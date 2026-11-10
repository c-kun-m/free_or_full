import { createHash, randomUUID } from 'node:crypto';
import type { EventEnvelope, Task } from '../../../packages/protocol/src/index.js';
import { terminal } from '../../../packages/protocol/src/index.js';
import type { CodingEngine } from './codex.js';
import { Store } from './storage/store.js';

export class ServiceError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}
export class TaskService {
  private chain: Promise<unknown> = Promise.resolve();
  private running?: { task: Task; abort: AbortController; completion: Promise<void> };
  private stopped = false;
  private pumpScheduled = false;
  onEvent: (device: string, event: EventEnvelope) => void = () => {};
  constructor(private store: Store, private engine: CodingEngine) {}
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn);
    this.chain = next.catch(() => {});
    return next;
  }
  async initialize() {
    // Do not blindly re-execute accepted commands after a process restart.
    for (const task of await this.store.call<Task[]>('allTasks')) {
      if (!terminal.has(task.status)) {
        task.status = 'unknown'; task.approval = null;
        task.error = '电脑服务重启，任务结果需要核对；未自动重试。';
        await this.save(task);
      }
    }
  }
  private async save(task: Task, hash?: string) {
    task.version++; task.updated_at = new Date().toISOString();
    const event = await this.store.call<EventEnvelope>('save', { task, hash, type: 'task.updated' });
    this.onEvent(task.device_id, event);
  }
  async get(device: string, id: string): Promise<Task> {
    const task = await this.store.call<Task | null>('taskGet', { device, id });
    if (!task) throw new ServiceError(404, 'Task not found');
    return task;
  }
  list(device: string) { return this.store.call<Task[]>('tasks', { device }); }
  submit(device: string, input: { request_id: string; prompt: string; conversation_id?: string }): Promise<Task> {
    return this.serial(async () => {
      if (!input.prompt.trim()) throw new ServiceError(400, 'Prompt cannot be blank');
      const hash = createHash('sha256').update(JSON.stringify([input.prompt, input.conversation_id ?? null])).digest('hex');
      const previous = await this.store.call('taskByRequest', { device, request: input.request_id });
      if (previous) {
        if (previous.hash !== hash) throw new ServiceError(409, 'request_id already used with different content');
        return previous.task;
      }
      const all = await this.list(device);
      const conversation = input.conversation_id ?? randomUUID();
      if (input.conversation_id && !all.some(t => t.conversation_id === conversation)) throw new ServiceError(404, 'Conversation not found');
      if (all.filter(t => !terminal.has(t.status)).length >= 10) throw new ServiceError(429, 'Too many pending tasks');
      const task: Task = {
        id: randomUUID(), device_id: device, request_id: input.request_id, conversation_id: conversation,
        prompt: input.prompt, status: 'queued', output: '', output_truncated: false,
        error: null, progress: null, thread_id: null, turn_id: null, approval: null,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(), version: 0
      };
      await this.save(task, hash);
      this.schedulePump();
      return structuredClone(task);
    });
  }
  private schedulePump() {
    if (this.pumpScheduled || this.stopped) return;
    this.pumpScheduled = true;
    setImmediate(() => {
      this.pumpScheduled = false;
      void this.serial(() => this.pump()).catch(() => {});
    });
  }
  private async pump() {
    if (this.running || this.stopped) return;
    const all = await this.store.call<Task[]>('allTasks');
    const task = all.find(t => t.status === 'queued');
    if (!task) return;
    const previous = all.filter(t => t.device_id === task.device_id && t.conversation_id === task.conversation_id && t.thread_id).at(-1);
    if (previous?.status === 'unknown') {
      task.status = 'failed'; task.error = '上一轮结果未知，请核对后新建会话。'; await this.save(task); this.schedulePump(); return;
    }
    task.thread_id = previous?.thread_id ?? null;
    task.status = 'running';
    await this.save(task);
    const abort = new AbortController();
    const mutate = (fn: () => void) => this.serial(async () => {
      fn(); await this.save(task);
    });
    let buffered = '';
    let flushTimer: NodeJS.Timeout | undefined;
    const flush = async () => {
      clearTimeout(flushTimer); flushTimer = undefined;
      if (!buffered) return;
      const delta = buffered; buffered = '';
      await mutate(() => {
        const cap = 256_000;
        if (task.output.length + delta.length > cap) task.output_truncated = true;
        task.output = (task.output + delta).slice(0, cap);
      });
    };
    const completion = this.engine.run({ prompt: task.prompt, threadId: task.thread_id, signal: abort.signal }, {
      started: (thread, turn) => mutate(() => { task.thread_id = thread; if (turn) task.turn_id = turn; }),
      text: async delta => {
        buffered += delta;
        if (!flushTimer) flushTimer = setTimeout(() => void flush().catch(() => abort.abort()), 400);
      },
      progress: message => mutate(() => { task.progress = message; }),
      approval: approval => mutate(() => {
        task.approval = task.status === 'cancel_requested' ? null : approval;
        if (task.status !== 'cancel_requested') task.status = approval ? 'waiting_approval' : 'running';
      })
    }).then(async status => { await flush(); await mutate(() => { task.status = status; task.approval = null; task.progress = null; }); })
      .catch(async error => { await flush(); await mutate(() => {
        task.status = error.name === 'CodexTurnFailed' ? 'failed' : 'unknown'; task.error = error.message; task.approval = null;
      }); if (task.status === 'unknown') await this.engine.close(); })
      .finally(() => { this.running = undefined; this.schedulePump(); });
    this.running = { task, abort, completion };
  }
  cancel(device: string, id: string) {
    return this.serial(async () => {
      let task = await this.get(device, id);
      if (terminal.has(task.status)) return task;
      if (this.running?.task.id === id) {
        task = this.running.task; task.status = 'cancel_requested'; task.approval = null;
        await this.save(task);
        this.running.abort.abort();
      } else {
        task.status = 'cancelled'; await this.save(task);
      }
      return structuredClone(task);
    });
  }
  decide(device: string, id: string, approvalId: string, allow: boolean) {
    return this.serial(async () => {
      const task = await this.get(device, id);
      if (task.status !== 'waiting_approval' || task.approval?.id !== approvalId || Date.parse(task.approval.expires_at) <= Date.now()) {
        throw new ServiceError(409, 'Approval expired or no longer active');
      }
      this.engine.decide(approvalId, allow);
      return { accepted: true };
    });
  }
  async close() {
    this.stopped = true;
    this.running?.abort.abort();
    await this.engine.close();
    await this.running?.completion;
    await this.chain;
  }
}
