import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FakeToolCallingModel } from 'langchain';
import { createApp } from '../src/server.js';
import { LangChainAssistant, type AssistantEngine, type AssistantRun } from '../src/assistant.js';
import type { CodingEngine, RunHooks, RunInput } from '../src/codex.js';

class ControlledCoding implements CodingEngine {
  runs: RunInput[] = [];
  async run(input: RunInput, hooks: RunHooks): Promise<'succeeded'> {
    this.runs.push(input);
    await hooks.started('thread', 'turn');
    await hooks.text('Coding result');
    return 'succeeded';
  }
  decide() {}
  async close() {}
}
class ControlledAssistant implements AssistantEngine {
  runs: { input: AssistantRun; finish: () => void }[] = [];
  run(input: AssistantRun): Promise<void> {
    return new Promise(resolve => this.runs.push({ input, finish: resolve }));
  }
}
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
async function setup(factory?: Parameters<typeof createApp>[0]['assistantFactory']) {
  const directory = await mkdtemp(join(tmpdir(), 'phone-assistant-chat-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const engine = new ControlledCoding();
  const service = await createApp({ dbPath: join(directory, 'test.sqlite'), engine, projectName: 'test', assistantFactory: factory });
  cleanup.push(() => service.app.close());
  const pair = await service.app.inject({ method: 'POST', url: '/v1/pairings/claim', payload: { code: service.pairingCode, name: 'Phone' } });
  const device = pair.json().device_id as string;
  const headers = { authorization: 'Bearer ' + pair.json().token };
  const send = (request_id: string, prompt: string, conversation_id?: string) => service.app.inject({ method: 'POST', url: '/v1/chats', headers,
    payload: { request_id, prompt, ...(conversation_id ? { conversation_id } : {}) } });
  return { ...service, engine, directory, device, headers, send };
}
async function waitFor(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 300; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Condition not reached');
}

describe('LangChain assistant and native chat protocol', () => {
  it('runs the actual LangChain loop for normal conversation without starting Codex', async () => {
    const { send, chats, device, engine } = await setup((store, tasks) => new LangChainAssistant(new FakeToolCallingModel(), store, tasks));
    const first = (await send('hello', '你好，记住项目叫松树。')).json();
    await waitFor(async () => (await chats.get(device, first.id)).status !== 'running');
    expect((await chats.get(device, first.id)).status).toBe('succeeded');
    expect((await chats.get(device, first.id)).output).toContain('松树');
    const second = (await send('again', '刚才的项目叫什么？', first.conversation_id)).json();
    await waitFor(async () => (await chats.get(device, second.id)).status !== 'running');
    expect((await chats.get(device, second.id)).output).toContain('松树');
    expect(engine.runs).toHaveLength(0);
  });
  it('executes a LangChain Codex tool call once and persists the task link across retries', async () => {
    const model = new FakeToolCallingModel({ toolCalls: [[{ name: 'submit_codex_task', id: 'call-1', args: { prompt: 'Inspect this project', previous_task_id: null } }], []] });
    const { send, chats, device, engine, store } = await setup((store, tasks) => new LangChainAssistant(model, store, tasks));
    const [a, b] = await Promise.all([send('request-1', '检查项目'), send('request-1', '检查项目')]);
    expect(a.statusCode).toBe(202); expect(b.json().id).toBe(a.json().id);
    const id = a.json().id;
    await waitFor(async () => (await chats.get(device, id)).status !== 'running');
    const turn = await chats.get(device, id);
    expect(turn.status).toBe('succeeded');
    expect(turn.task_ids).toHaveLength(1);
    expect(turn.output).toContain(turn.task_ids[0]);
    await waitFor(() => engine.runs.length === 1);
    expect((await send('request-1', '检查项目')).json().task_ids).toEqual(turn.task_ids);
    expect((await send('request-1', 'Different')).statusCode).toBe(409);
    const events = await store.call('events', { device, after: 0 });
    expect(events.some((event: any) => event.type === 'chat.updated' && event.payload.chat_id === id)).toBe(true);
    expect(engine.runs).toHaveLength(1);
  });
  it('stops late tokens and tool calls after interruption without cancelling an already submitted task', async () => {
    const assistant = new ControlledAssistant();
    const { send, app, headers, chats, device, tasks } = await setup(() => assistant);
    const turn = (await send('cancel', '开始工作')).json();
    await waitFor(() => assistant.runs.length === 1);
    const input = assistant.runs[0].input;
    await input.text('部分回答');
    const task = await input.submitTask('submitted', 'work');
    const stopped = await app.inject({ method: 'POST', url: '/v1/chats/' + turn.id + '/cancel', headers });
    expect(stopped.json().status).toBe('cancelled');
    expect(input.signal.aborted).toBe(true);
    await input.text('迟到的数据');
    await expect(input.submitTask('late', 'should not run')).rejects.toBeDefined();
    expect((await chats.get(device, turn.id)).output).toBe('部分回答');
    expect((await tasks.get(device, task.id)).status).not.toBe('cancelled');
    assistant.runs[0].finish();
  });
  it('flushes partial text while a model is still running and rejects late text after cancellation', async () => {
    const assistant = new ControlledAssistant();
    const { send, chats, device } = await setup(() => assistant);
    const turn = (await send('stream', '请回答')).json();
    await waitFor(() => assistant.runs.length === 1);
    await assistant.runs[0].input.text('已收到的文字');
    await waitFor(async () => (await chats.get(device, turn.id)).output === '已收到的文字');
    expect((await chats.get(device, turn.id)).status).toBe('running');
    await chats.cancel(device, turn.id);
    await assistant.runs[0].input.text('不能出现');
    expect((await chats.get(device, turn.id)).output).toBe('已收到的文字');
  });
  it('permits only one Codex submission even when parallel tools both resume an earlier task', async () => {
    const model = new FakeToolCallingModel();
    const { tasks, device, send, chats, engine } = await setup((store, tasks) => new LangChainAssistant(model, store, tasks));
    const previous = await tasks.submit(device, { request_id: 'previous', prompt: 'First task' });
    await waitFor(async () => (await tasks.get(device, previous.id)).status === 'succeeded');
    model.toolCalls = [[
      { name: 'submit_codex_task', id: 'parallel-a', args: { prompt: 'Continue A', previous_task_id: previous.id } },
      { name: 'submit_codex_task', id: 'parallel-b', args: { prompt: 'Continue B', previous_task_id: previous.id } }
    ], []];
    const turn = (await send('parallel', '继续上一个任务')).json();
    await waitFor(async () => (await chats.get(device, turn.id)).status !== 'running');
    expect((await chats.get(device, turn.id)).task_ids).toHaveLength(1);
    expect((await tasks.list(device))).toHaveLength(2);
    await waitFor(() => engine.runs.length === 2);
  });
  it('a new message interrupts the previous generation and preserves follow-up context', async () => {
    const assistant = new ControlledAssistant();
    const { send, chats, device } = await setup(() => assistant);
    const first = (await send('first', '旧问题')).json();
    await waitFor(() => assistant.runs.length === 1);
    const next = await send('next', '新问题', first.conversation_id);
    expect(next.statusCode).toBe(202);
    await waitFor(() => assistant.runs.length === 2);
    expect(assistant.runs[0].input.signal.aborted).toBe(true);
    expect((await chats.get(device, first.id)).status).toBe('cancelled');
    expect(assistant.runs[1].input.history[0].prompt).toBe('旧问题');
    await assistant.runs[1].input.text('新回答'); assistant.runs[1].finish();
    await waitFor(async () => (await chats.get(device, next.json().id)).status === 'succeeded');
  });
  it('isolates chat reads, cancellation, continuation and history search by paired device', async () => {
    const model = new FakeToolCallingModel({ toolCalls: [[{ name: 'search_history', id: 'search', args: { query: '秘密' } }], []] });
    const { send, store, chats, device, app } = await setup((store, tasks) => new LangChainAssistant(model, store, tasks));
    await store.call('deviceAdd', { id: 'other', hash: createHash('sha256').update('other-token').digest('hex'), name: 'Other' });
    const now = new Date().toISOString();
    await store.call('chatSave', { turn: { id: 'private', device_id: 'other', request_id: 'private', conversation_id: 'private-conversation',
      prompt: '秘密', output: 'PRIVATE-SECRET-DO-NOT-LEAK', status: 'succeeded', error: null, task_ids: [], created_at: now, updated_at: now, version: 1 } });
    const turn = (await send('search', '查一下秘密')).json();
    await waitFor(async () => (await chats.get(device, turn.id)).status !== 'running');
    expect((await chats.get(device, turn.id)).output).not.toContain('PRIVATE-SECRET-DO-NOT-LEAK');
    const headers = { authorization: 'Bearer other-token' };
    expect((await app.inject({ url: '/v1/chats/' + turn.id, headers })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/v1/chats/' + turn.id + '/cancel', headers })).statusCode).toBe(404);
    expect((await send('steal', '继续', 'private-conversation')).statusCode).toBe(404);
    expect((await app.inject('/v1/snapshot')).statusCode).toBe(401);
  });
  it('recovers interrupted chats without rerunning a model or a tool', async () => {
    const assistant = new ControlledAssistant();
    const { store, directory, device } = await setup(() => assistant);
    const now = new Date().toISOString();
    const prompt = 'do not replay';
    await store.call('chatSave', { hash: createHash('sha256').update(JSON.stringify([prompt, null])).digest('hex'),
      turn: { id: 'crashed', device_id: device, request_id: 'crashed-request', conversation_id: 'crashed-conversation', prompt,
        output: 'partial', status: 'running', error: null, task_ids: ['existing-task'], created_at: now, updated_at: now, version: 1 } });
    const recovered = await createApp({ dbPath: join(directory, 'test.sqlite'), engine: new ControlledCoding(), projectName: 'test', assistantFactory: () => assistant });
    cleanup.push(() => recovered.app.close());
    const result = await recovered.chats.submit(device, { request_id: 'crashed-request', prompt });
    expect(result.id).toBe('crashed'); expect(result.status).toBe('cancelled');
    expect(result.task_ids).toEqual(['existing-task']);
    expect(assistant.runs).toHaveLength(0);
  });
  it('clearly reports missing assistant credentials without pretending to run a model', async () => {
    const { app, send, headers, engine } = await setup();
    expect((await app.inject({ url: '/v1/info', headers })).json().assistant.configured).toBe(false);
    const result = await send('missing', '你好');
    expect(result.statusCode).toBe(409); expect(result.json().error).toContain('PA_AGENT_MODEL');
    expect(engine.runs).toHaveLength(0);
  });
});
