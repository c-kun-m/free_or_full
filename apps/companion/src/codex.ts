import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import type { Approval } from '../../../packages/protocol/src/index.js';

export interface RunInput { prompt: string; threadId?: string | null; signal: AbortSignal }
export interface RunHooks {
  started(thread: string, turn?: string): Promise<void>;
  text(delta: string): Promise<void>;
  approval(approval: Approval | null): Promise<void>;
  progress?(message: string): Promise<void>;
}
export interface CodingEngine {
  run(input: RunInput, hooks: RunHooks): Promise<'succeeded' | 'cancelled'>;
  decide(id: string, allow: boolean): void;
  close(): Promise<void>;
}
export class CodexEngine implements CodingEngine {
  private process?: ChildProcessWithoutNullStreams;
  private ready?: Promise<void>;
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private active?: {
    thread: string; turn?: string; hooks: RunHooks;
    resolve: (status: 'succeeded' | 'cancelled') => void; reject: (error: Error) => void;
  };
  private approvals = new Map<string, { rpcId: number | string; timer: NodeJS.Timeout; info: Approval }>();
  private notificationChain = Promise.resolve();
  constructor(private options: { executable: string; cwd: string; sandbox: 'read-only' | 'workspace-write'; model?: string; args?: string[]; effort?: 'low'; trace?: (method: string) => void }) {}

  async connect() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      this.process = spawn(this.options.executable, this.options.args ?? ['app-server', '--listen', 'stdio://'], {
        cwd: this.options.cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false
      });
      this.process.stderr.resume();
      this.process.on('error', error => this.fail(error));
      this.process.on('exit', () => this.fail(new Error('Codex process exited; reconcile the task before retrying.')));
      createInterface({ input: this.process.stdout }).on('line', line => {
        let message: any;
        try { message = JSON.parse(line); } catch { return; }
        this.options.trace?.(message.method ?? ('response:' + message.id + (message.error ? ':error' : '')));
        if (message.id !== undefined && !message.method) {
          const pending = this.pending.get(message.id);
          if (!pending) return;
          clearTimeout(pending.timer); this.pending.delete(message.id);
          if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
        } else {
          this.notificationChain = this.notificationChain.then(() => this.onNotification(message)).catch(error => this.fail(error));
        }
      });
      await this.request('initialize', { clientInfo: { name: 'phone_assistant', title: 'Phone Assistant', version: '0.1.0' } });
      this.send({ method: 'initialized' });
    })();
    try { await this.ready; } catch (error) { await this.close(); throw error; }
  }
  private send(message: unknown) {
    if (!this.process?.stdin.writable) throw new Error('Codex connection unavailable');
    this.process.stdin.write(JSON.stringify(message) + '\n');
  }
  request(method: string, params: unknown): Promise<any> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Codex request timed out: ' + method)); }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch (error) {
        clearTimeout(timer); this.pending.delete(id); reject(error);
      }
    });
  }
  private fail(error: Error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.active?.reject(error);
    this.clearApprovals();
    this.ready = undefined;
  }
  private clearApprovals() {
    for (const approval of this.approvals.values()) clearTimeout(approval.timer);
    this.approvals.clear();
  }
  private async onNotification(message: any) {
    const active = this.active;
    const p = message.params ?? {};
    if (message.method === 'error') {
      const reason = String(p.error?.message ?? 'unknown').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 500);
      this.options.trace?.('error detail: ' + JSON.stringify({ reason, info: p.error?.codexErrorInfo, retrying: p.willRetry }));
    }
    if (message.id !== undefined) {
      const supported = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(message.method);
      if (!active || !supported || p.threadId !== active.thread) {
        this.send({ id: message.id, error: { code: -32601, message: 'This client does not support this interactive request.' } });
        return;
      }
      const id = randomUUID();
      const expires = Date.now() + 120_000;
      const timer = setTimeout(() => this.decide(id, false), 120_000);
      const info: Approval = {
        id, method: message.method,
        description: JSON.stringify({ reason: p.reason, command: p.command, cwd: p.cwd, itemId: p.itemId, grantRoot: p.grantRoot }),
        expires_at: new Date(expires).toISOString()
      };
      this.approvals.set(id, { rpcId: message.id, timer, info });
      if (this.approvals.size === 1) await active.hooks.approval(info);
      return;
    }
    if (!active || p.threadId !== active.thread) return;
    if (active.turn && p.turnId && p.turnId !== active.turn) return;
    if (message.method === 'error' && p.willRetry) {
      await active.hooks.progress?.('模型连接中断，Codex 正在重试；可以随时停止任务。');
    }
    if (message.method === 'turn/started') {
      active.turn = p.turn.id;
      await active.hooks.started(active.thread, active.turn);
    }
    if (message.method === 'item/agentMessage/delta') await active.hooks.text(p.delta);
    if (message.method === 'turn/completed') {
      if (!active.turn || p.turn.id !== active.turn) return;
      if (p.turn.status === 'completed') active.resolve('succeeded');
      else if (p.turn.status === 'interrupted') active.resolve('cancelled');
      else {
        const error = new Error(p.turn.error?.message ?? 'Codex turn failed');
        error.name = 'CodexTurnFailed';
        active.reject(error);
      }
    }
  }
  decide(id: string, allow: boolean) {
    const approval = this.approvals.get(id);
    if (!approval) throw new Error('Approval is no longer active');
    clearTimeout(approval.timer); this.approvals.delete(id);
    this.send({ id: approval.rpcId, result: { decision: allow ? 'accept' : 'decline' } });
    const next = this.approvals.values().next().value?.info ?? null;
    void this.active?.hooks.approval(next).catch(error => this.fail(error));
  }
  async run(input: RunInput, hooks: RunHooks): Promise<'succeeded' | 'cancelled'> {
    await this.connect();
    if (input.signal.aborted) return 'cancelled';
    if (this.active) throw new Error('Codex engine is busy');
    const params = { cwd: this.options.cwd, sandbox: this.options.sandbox, approvalPolicy: 'on-request', approvalsReviewer: 'user', ...(this.options.model ? { model: this.options.model } : {}) };
    const result = input.threadId
      ? await this.request('thread/resume', { ...params, threadId: input.threadId, excludeTurns: true })
      : await this.request('thread/start', params);
    const thread = result.thread.id as string;
    await hooks.started(thread);
    if (input.signal.aborted) return 'cancelled';
    let complete!: (value: 'succeeded' | 'cancelled') => void;
    let reject!: (error: Error) => void;
    const finished = new Promise<'succeeded' | 'cancelled'>((res, rej) => { complete = res; reject = rej; });
    // A process exit may arrive before turn/start returns.
    void finished.catch(() => {});
    this.active = { thread, hooks, resolve: complete, reject };
    let cancelDeadline: NodeJS.Timeout | undefined;
    const interrupt = () => {
      cancelDeadline ??= setTimeout(() => reject(new Error('Cancellation was not confirmed; reconcile before retrying.')), 15_000);
      for (const id of this.approvals.keys()) this.decide(id, false);
      if (this.active?.turn) void this.request('turn/interrupt', { threadId: thread, turnId: this.active.turn }).catch(reject);
    };
    input.signal.addEventListener('abort', interrupt);
    const deadline = setTimeout(() => { interrupt(); reject(new Error('Task exceeded the 30 minute execution limit; status requires reconciliation.')); }, 30 * 60_000);
    try {
      const started = await this.request('turn/start', { threadId: thread, input: [{ type: 'text', text: input.prompt }], ...(this.options.effort ? { effort: this.options.effort } : {}) });
      this.active.turn = started.turn.id;
      await hooks.started(thread, started.turn.id);
      if (input.signal.aborted) interrupt();
      return await finished;
    } finally {
      clearTimeout(deadline);
      clearTimeout(cancelDeadline);
      input.signal.removeEventListener('abort', interrupt);
      this.clearApprovals();
      this.active = undefined;
    }
  }
  async close() {
    this.fail(new Error('Codex connection closed'));
    const child = this.process;
    this.process = undefined;
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => resolve(), 3000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        child.stdin.end(); child.kill();
      });
    }
  }
}
