import { createInterface } from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
let initialized = false;
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') send({ id: m.id, result: {} });
  if (m.method === 'initialized') initialized = true;
  if (m.method === 'thread/start') {
    if (!initialized) throw new Error('Missing handshake');
    send({ id: m.id, result: { thread: { id: 'thread' } } });
  }
  if (m.method === 'turn/start') {
    // Events intentionally precede the start response.
    send({ method: 'turn/started', params: { threadId: 'thread', turn: { id: 'turn' } } });
    send({ method: 'item/agentMessage/delta', params: { threadId: 'thread', turnId: 'turn', delta: 'hello' } });
    send({ id: m.id, result: { turn: { id: 'turn' } } });
    send({ id: 999, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread', turnId: 'turn', command: 'test', reason: 'fixture' } });
    send({ id: 1000, method: 'item/fileChange/requestApproval', params: { threadId: 'thread', turnId: 'turn', reason: 'second fixture' } });
  }
  if (m.id === 999 && m.result) {
    if (m.result.decision !== 'decline') throw new Error('Unexpected approval');
    // Delayed completion from an older turn must not complete the current one.
    send({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'old-turn', status: 'completed' } } });
  }
  if (m.id === 1000 && m.result) {
    if (m.result.decision !== 'decline') throw new Error('Unexpected second approval');
    send({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'completed' } } });
  }
});
