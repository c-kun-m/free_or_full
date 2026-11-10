import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import WebSocket from 'ws';
import { createApp } from '../src/server.js';
import type { CodingEngine, RunHooks, RunInput } from '../src/codex.js';

class ControlledEngine implements CodingEngine {
  runs: { input: RunInput; hooks: RunHooks; finish: (status: 'succeeded' | 'cancelled') => void }[] = [];
  decisions: unknown[] = [];
  async run(input: RunInput, hooks: RunHooks): Promise<'succeeded' | 'cancelled'> {
    return new Promise(resolve => {
      const entry = { input, hooks, finish: resolve };
      this.runs.push(entry);
      void hooks.started(input.threadId ?? 'thread-1', 'turn-' + this.runs.length);
      // Keep cancellation under test control, to exercise cancellation/completion races.
    });
  }
  decide(id: string, allow: boolean) { this.decisions.push({ id, allow }); }
  async close() { for (const run of this.runs) run.finish('cancelled'); }
}
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'phone-assistant-test-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const engine = new ControlledEngine();
  const service = await createApp({ dbPath: join(dir, 'test.sqlite'), engine, projectName: 'test' });
  cleanup.push(() => service.app.close());
  await service.app.ready();
  const pair = await service.app.inject({ method: 'POST', url: '/v1/pairings/claim', payload: { code: service.pairingCode, name: 'test' } });
  expect(pair.statusCode).toBe(201);
  const headers = { authorization: 'Bearer ' + pair.json().token };
  return { ...service, engine, headers, dir };
}
async function waitFor(check: () => Promise<boolean> | boolean) {
  for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('Timed out waiting for condition');
}
describe('authenticated task lifecycle', () => {
  it('requires authentication and consumes pairing codes exactly once', async () => {
    const { app, pairingCode } = await setup();
    expect((await app.inject('/v1/tasks')).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/v1/pairings/claim', payload: { code: pairingCode, name: 'again' } })).statusCode).toBe(401);
    expect((await app.inject({ url: '/health', headers: { origin: 'https://untrusted.example' } })).statusCode).toBe(403);
  });
  it('deduplicates simultaneous retries and rejects changed content', async () => {
    const { app, headers, engine } = await setup();
    const request = { method: 'POST' as const, url: '/v1/tasks', headers, payload: { request_id: 'retry-1', prompt: 'Hello' } };
    const responses = await Promise.all([app.inject(request), app.inject(request)]);
    expect(responses.map(r => r.statusCode)).toEqual([202, 202]);
    expect(responses[0].json().id).toBe(responses[1].json().id);
    await waitFor(() => engine.runs.length === 1);
    expect((await app.inject({ ...request, payload: { request_id: 'retry-1', prompt: 'Changed' } })).statusCode).toBe(409);
    expect((await app.inject({ ...request, payload: { request_id: 'blank', prompt: '   ' } })).statusCode).toBe(400);
  });
  it('serializes jobs, cancels a queued task, and does not execute it', async () => {
    const { app, headers, engine, tasks } = await setup();
    const first = (await app.inject({ method: 'POST', url: '/v1/tasks', headers, payload: { request_id: 'a', prompt: 'first' } })).json();
    await waitFor(() => engine.runs.length === 1);
    const second = (await app.inject({ method: 'POST', url: '/v1/tasks', headers, payload: { request_id: 'b', prompt: 'second' } })).json();
    const cancelled = await app.inject({ method: 'POST', url: '/v1/tasks/' + second.id + '/cancel', headers });
    expect(cancelled.json().status).toBe('cancelled');
    await engine.runs[0].hooks.text('真实输出');
    engine.runs[0].finish('succeeded');
    await waitFor(async () => (await tasks.get(first.device_id, first.id)).status === 'succeeded');
    expect((await tasks.get(first.device_id, first.id)).output).toBe('真实输出');
    expect(engine.runs).toHaveLength(1);
  });
  it('retains actual completion when cancellation races with completion', async () => {
    const { app, headers, engine, tasks } = await setup();
    const task = (await app.inject({ method: 'POST', url: '/v1/tasks', headers, payload: { request_id: 'race', prompt: 'work' } })).json();
    await waitFor(() => engine.runs.length === 1);
    const cancel = await app.inject({ method: 'POST', url: '/v1/tasks/' + task.id + '/cancel', headers });
    expect(cancel.json().status).toBe('cancel_requested');
    expect(engine.runs[0].input.signal.aborted).toBe(true);
    engine.runs[0].finish('succeeded');
    await waitFor(async () => (await tasks.get(task.device_id, task.id)).status === 'succeeded');
  });
  it('reports upstream retries and confirms a running cancellation', async () => {
    const { app, headers, engine, tasks } = await setup();
    const task = (await app.inject({ method: 'POST', url: '/v1/tasks', headers, payload: { request_id: 'retry-status', prompt: 'work' } })).json();
    await waitFor(() => engine.runs.length === 1);
    await engine.runs[0].hooks.progress?.('Reconnecting');
    expect((await tasks.get(task.device_id, task.id)).progress).toBe('Reconnecting');
    await app.inject({ method: 'POST', url: '/v1/tasks/' + task.id + '/cancel', headers });
    engine.runs[0].finish('cancelled');
    await waitFor(async () => (await tasks.get(task.device_id, task.id)).status === 'cancelled');
    expect((await tasks.get(task.device_id, task.id)).progress).toBeNull();
  });
  it('binds approvals to the active task and rejects stale decisions', async () => {
    const { app, headers, engine } = await setup();
    const task = (await app.inject({ method: 'POST', url: '/v1/tasks', headers, payload: { request_id: 'approval', prompt: 'work' } })).json();
    await waitFor(() => engine.runs.length === 1);
    await engine.runs[0].hooks.approval({ id: 'approval-1', method: 'test', description: 'command', expires_at: new Date(Date.now() + 10000).toISOString() });
    expect((await app.inject({ method: 'POST', url: '/v1/tasks/' + task.id + '/approval', headers, payload: { approval_id: 'wrong', allow: true } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/v1/tasks/' + task.id + '/approval', headers, payload: { approval_id: 'approval-1', allow: false } })).statusCode).toBe(200);
    expect(engine.decisions).toEqual([{ id: 'approval-1', allow: false }]);
  });
  it('isolates other devices, including history', async () => {
    const { app, headers, store } = await setup();
    const { createHash } = await import('node:crypto');
    await store.call('deviceAdd', { id: 'other', hash: createHash('sha256').update('other-token').digest('hex'), name: 'Other' });
    const other = { authorization: 'Bearer other-token' };
    const task = (await app.inject({ method: 'POST', url: '/v1/tasks', headers, payload: { request_id: 'private', prompt: 'private' } })).json();
    expect((await app.inject({ url: '/v1/tasks/' + task.id, headers: other })).statusCode).toBe(404);
    expect((await app.inject({ url: '/v1/events/history?after=0', headers: other })).json().events).toEqual([]);
    expect((await app.inject({ method: 'POST', url: '/v1/tasks', headers: other, payload: { request_id: 'steal', prompt: 'work', conversation_id: task.conversation_id } })).statusCode).toBe(404);
  });
  it('replays persisted events over WebSocket after reconnect', async () => {
    const { app, headers } = await setup();
    const task = (await app.inject({ method: 'POST', url: '/v1/tasks', headers, payload: { request_id: 'events', prompt: 'work' } })).json();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const nextEvent = (after: number) => new Promise<any>((resolve, reject) => {
      const socket = new WebSocket(address.replace('http:', 'ws:') + '/v1/events?after=' + after, { headers });
      const timer = setTimeout(() => { socket.terminate(); reject(new Error('No event')); }, 3000);
      socket.on('message', bytes => { clearTimeout(timer); socket.close(); resolve(JSON.parse(bytes.toString())); });
      socket.on('error', error => { clearTimeout(timer); reject(error); });
    });
    const first = await nextEvent(0);
    expect(first.payload.task_id).toBe(task.id);
    const second = await nextEvent(first.event_seq);
    expect(second.event_seq).toBeGreaterThan(first.event_seq);
  });
  it('marks unfinished persisted work unknown without re-executing on restart', async () => {
    const { dir, store } = await setup();
    const now = new Date().toISOString();
    await store.call('save', { hash: 'hash', type: 'task.updated', task: {
      id: 'crashed', device_id: 'crashed-device', request_id: 'crashed-request', conversation_id: 'conversation',
      prompt: 'Do not repeat', status: 'running', output: '', output_truncated: false, error: null,
      thread_id: 'thread', turn_id: 'turn', approval: null, created_at: now, updated_at: now, version: 1
    } });
    // A separate database connection models recovery from durable state.
    const recoveredEngine = new ControlledEngine();
    const recovered = await createApp({ dbPath: join(dir, 'test.sqlite'), engine: recoveredEngine, projectName: 'test' });
    cleanup.push(() => recovered.app.close());
    const task = await recovered.tasks.get('crashed-device', 'crashed');
    expect(task.status).toBe('unknown');
    expect(recoveredEngine.runs).toHaveLength(0);
  });
});
