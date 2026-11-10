import { createHash, randomUUID } from 'node:crypto';
import type { ChatCommand, ChatTurn } from '../../../packages/protocol/src/index.js';
import type { AssistantEngine } from './assistant.js';
import { ServiceError, type TaskService } from './tasks.js';
import type { Store } from './storage/store.js';

type Active = { turn: ChatTurn; abort: AbortController; done?: Promise<void>; flushTimer?: NodeJS.Timeout };
export class ChatService {
  private active = new Map<string, Active>();
  private serial: Promise<unknown> = Promise.resolve();
  private stopping = false;
  constructor(private store: Store, private tasks: TaskService, private engine?: AssistantEngine) {}
  get configured() { return !!this.engine; }
  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.serial.then(operation);
    this.serial = next.catch(() => {});
    return next;
  }
  async initialize() {
    for (const turn of await this.store.call<ChatTurn[]>('unfinishedChats')) {
      turn.status = 'cancelled';
      turn.error = '电脑服务已重启，本轮回答已停止；已提交的电脑任务请查看各自状态。';
      await this.save(turn);
    }
  }
  private async save(turn: ChatTurn, hash?: string) {
    turn.updated_at = new Date().toISOString(); turn.version++;
    await this.store.call('chatSave', { turn, hash });
  }
  async get(device: string, id: string) {
    const turn = await this.store.call<ChatTurn | null>('chatGet', { device, id });
    if (!turn) throw new ServiceError(404, 'Chat turn not found');
    return turn;
  }
  submit(device: string, input: ChatCommand) {
    return this.mutate(async () => {
      const hash = createHash('sha256').update(JSON.stringify([input.prompt, input.conversation_id ?? null])).digest('hex');
      const existing = await this.store.call<{ turn: ChatTurn; hash: string } | null>('chatByRequest', { device, request: input.request_id });
      if (existing) {
        if (existing.hash !== hash) throw new ServiceError(409, 'Request ID already used with different content');
        return existing.turn;
      }
      if (this.stopping) throw new ServiceError(409, 'Service is stopping');
      if (!this.engine) throw new ServiceError(409, '请在电脑设置 PA_AGENT_MODEL 和 OPENAI_API_KEY 后重启服务，启用 LangChain 助手。');
      if (!input.prompt.trim()) throw new ServiceError(400, 'Prompt cannot be blank');
      let history = input.conversation_id
        ? await this.store.call<ChatTurn[]>('chatHistory', { device, conversation: input.conversation_id }) : [];
      if (input.conversation_id && !history.length) throw new ServiceError(404, 'Conversation not found');
      const previous = [...this.active.values()].filter(item => item.turn.device_id === device && item.turn.status === 'running');
      if (this.active.size - previous.length >= 4) throw new ServiceError(429, 'Too many active conversations');
      for (const entry of previous) await this.stop(entry);
      history = history.map(turn => structuredClone(previous.find(entry => entry.turn.id === turn.id)?.turn ?? turn));
      const now = new Date().toISOString();
      const turn: ChatTurn = { id: randomUUID(), device_id: device, request_id: input.request_id,
        conversation_id: input.conversation_id ?? randomUUID(), prompt: input.prompt, output: '', status: 'running',
        error: null, task_ids: [], created_at: now, updated_at: now, version: 0 };
      await this.save(turn, hash);
      const entry: Active = { turn, abort: new AbortController() };
      this.active.set(turn.id, entry);
      // Start after the acceptance transaction; each tool will recheck cancellation inside the mutation lock.
      entry.done = new Promise<void>(resolve => setImmediate(resolve)).then(() => this.run(entry, history));
      return structuredClone(turn);
    });
  }
  private async stop(entry: Active) {
    clearTimeout(entry.flushTimer);
    entry.abort.abort();
    entry.turn.status = 'cancelled';
    await this.save(entry.turn);
  }
  cancel(device: string, id: string) {
    return this.mutate(async () => {
      const turn = await this.get(device, id);
      const entry = this.active.get(id);
      if (entry && turn.status === 'running') { await this.stop(entry); return structuredClone(entry.turn); }
      return turn;
    });
  }
  private async run(entry: Active, history: ChatTurn[]) {
    const { turn, abort } = entry;
    const deadline = setTimeout(() => abort.abort(new Error('Agent timeout')), 120000);
    let removeAbort = () => {};
    try {
      abort.signal.throwIfAborted();
      const cancelled = new Promise<never>((_, reject) => {
        const handler = () => reject(abort.signal.reason);
        abort.signal.addEventListener('abort', handler, { once: true });
        removeAbort = () => abort.signal.removeEventListener('abort', handler);
      });
      await Promise.race([cancelled, this.engine!.run({ turn: structuredClone(turn), history, signal: abort.signal,
        text: delta => this.mutate(async () => {
          if (abort.signal.aborted || turn.status !== 'running') return;
          if (turn.output.length + delta.length > 64000) throw new Error('Assistant output limit exceeded');
          turn.output += delta;
          if (!entry.flushTimer) entry.flushTimer = setTimeout(() => {
            entry.flushTimer = undefined;
            void this.mutate(async () => { if (turn.status === 'running') await this.save(turn); })
              .catch(() => abort.abort(new Error('Could not save reply')));
          }, 250);
        }),
        submitTask: (requestId, prompt, conversation) => this.mutate(async () => {
          abort.signal.throwIfAborted();
          if (this.stopping || turn.status !== 'running') throw new Error('Chat is no longer active');
          const task = await this.tasks.submit(turn.device_id, { request_id: requestId, prompt, conversation_id: conversation });
          if (!turn.task_ids.includes(task.id)) turn.task_ids.push(task.id);
          await this.save(turn);
          return task;
        })
      })]);
      await this.mutate(async () => {
        if (turn.status !== 'running') return;
        turn.status = 'succeeded';
        await this.save(turn);
      });
    } catch {
      await this.mutate(async () => {
        if (turn.status !== 'running') return;
        turn.status = abort.signal.aborted ? 'cancelled' : 'failed';
        turn.error = abort.signal.aborted ? '本轮回答已超时或停止。' : '助手请求失败，请检查电脑端模型配置和网络后重新提问。';
        await this.save(turn);
      });
    } finally {
      clearTimeout(deadline); clearTimeout(entry.flushTimer); removeAbort(); this.active.delete(turn.id);
    }
  }
  async close() {
    this.stopping = true;
    // Wait for a submit already inside its transaction before collecting active runs.
    const entries = await this.mutate(async () => {
      const entries = [...this.active.values()];
      for (const entry of entries) if (entry.turn.status === 'running') await this.stop(entry);
      return entries;
    });
    await Promise.all(entries.map(entry => entry.done));
    await this.serial;
  }
}
