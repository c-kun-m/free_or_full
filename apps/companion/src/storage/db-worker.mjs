import Database from 'better-sqlite3';
import { parentPort, workerData } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';

const db = new Database(workerData.path);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.exec(`
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
INSERT OR IGNORE INTO schema_version VALUES (1);
CREATE TABLE IF NOT EXISTS devices (
 id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, name TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tasks (
 id TEXT PRIMARY KEY, device_id TEXT NOT NULL, request_id TEXT NOT NULL,
 input_hash TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(device_id, request_id)
);
CREATE TABLE IF NOT EXISTS events (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_device_seq ON events(device_id, seq);
CREATE TABLE IF NOT EXISTS chats (
 id TEXT PRIMARY KEY, device_id TEXT NOT NULL, request_id TEXT NOT NULL,
 conversation_id TEXT NOT NULL, input_hash TEXT NOT NULL, data TEXT NOT NULL,
 UNIQUE(device_id, request_id)
);
CREATE INDEX IF NOT EXISTS chats_device_conversation ON chats(device_id, conversation_id);
INSERT OR IGNORE INTO schema_version VALUES (2);
`);
const recentChats = device => db.prepare('SELECT data FROM chats WHERE device_id = ? ORDER BY rowid DESC LIMIT 100')
  .all(device).map(row => JSON.parse(row.data));
const operations = {
  deviceAdd: ({ id, hash, name }) => db.prepare('INSERT INTO devices(id, token_hash, name) VALUES (?,?,?)').run(id, hash, name).changes,
  deviceGet: ({ hash }) => db.prepare('SELECT id, name FROM devices WHERE token_hash = ? AND revoked = 0').get(hash) ?? null,
  taskGet: ({ id, device }) => {
    const row = db.prepare('SELECT data FROM tasks WHERE id = ? AND device_id = ?').get(id, device);
    return row ? JSON.parse(row.data) : null;
  },
  taskByRequest: ({ request, device }) => {
    const row = db.prepare('SELECT data, input_hash FROM tasks WHERE request_id = ? AND device_id = ?').get(request, device);
    return row ? { task: JSON.parse(row.data), hash: row.input_hash } : null;
  },
  tasks: ({ device }) => db.prepare('SELECT data FROM tasks WHERE device_id = ? ORDER BY rowid DESC LIMIT 100').all(device).map(row => JSON.parse(row.data)),
  snapshot: db.transaction(({ device }) => ({
    tasks: db.prepare('SELECT data FROM tasks WHERE device_id = ? ORDER BY rowid DESC LIMIT 100').all(device).map(row => JSON.parse(row.data)),
    chats: recentChats(device),
    cursor: db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE device_id = ?').get(device).seq
  })),
  chatGet: ({ device, id }) => {
    const row = db.prepare('SELECT data FROM chats WHERE device_id = ? AND id = ?').get(device, id);
    return row ? JSON.parse(row.data) : null;
  },
  chatByRequest: ({ device, request }) => {
    const row = db.prepare('SELECT data, input_hash FROM chats WHERE device_id = ? AND request_id = ?').get(device, request);
    return row ? { turn: JSON.parse(row.data), hash: row.input_hash } : null;
  },
  chatHistory: ({ device, conversation }) => db.prepare('SELECT data FROM chats WHERE device_id = ? AND conversation_id = ? ORDER BY rowid DESC LIMIT 20')
    .all(device, conversation).map(row => JSON.parse(row.data)).reverse(),
  unfinishedChats: () => db.prepare("SELECT data FROM chats WHERE json_extract(data, '$.status') = 'running'")
    .all().map(row => JSON.parse(row.data)),
  chatSave: db.transaction(({ turn, hash }) => {
    db.prepare('INSERT INTO chats(id, device_id, request_id, conversation_id, input_hash, data) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data')
      .run(turn.id, turn.device_id, turn.request_id, turn.conversation_id, hash ?? '', JSON.stringify(turn));
    const event = { protocol_version: 1, event_id: randomUUID(), type: 'chat.updated', occurred_at: new Date().toISOString(),
      payload: { chat_id: turn.id, status: turn.status, version: turn.version } };
    const row = db.prepare('INSERT INTO events(device_id, data) VALUES (?,?)').run(turn.device_id, JSON.stringify(event));
    return { ...event, event_seq: Number(row.lastInsertRowid) };
  }),
  searchHistory: ({ device, query, excludeChat = '' }) => {
    // Parameterized literal substring matching works for Chinese without an English tokenizer.
    // Bounded recent results; semantic retrieval and pagination belong to the memory milestone.
    const chats = db.prepare("SELECT data FROM chats WHERE device_id = ? AND id != ? AND (instr(lower(json_extract(data, '$.prompt')), lower(?)) > 0 OR instr(lower(json_extract(data, '$.output')), lower(?)) > 0) ORDER BY rowid DESC LIMIT 8")
      .all(device, excludeChat, query, query).map(row => {
        const turn = JSON.parse(row.data);
        return { kind: 'chat', id: turn.id, prompt: turn.prompt.slice(0, 1000), output: excerpt(turn.output, query), status: turn.status, task_ids: turn.task_ids };
      });
    const tasks = db.prepare("SELECT data FROM tasks WHERE device_id = ? AND (instr(lower(json_extract(data, '$.prompt')), lower(?)) > 0 OR instr(lower(json_extract(data, '$.output')), lower(?)) > 0) ORDER BY rowid DESC LIMIT 8")
      .all(device, query, query).map(row => {
        const task = JSON.parse(row.data);
        return { kind: 'task', id: task.id, prompt: task.prompt.slice(0, 1000), output: excerpt(task.output, query), status: task.status };
      });
    return { chats, tasks };
  },
  allTasks: () => db.prepare('SELECT data FROM tasks ORDER BY rowid').all().map(row => JSON.parse(row.data)),
  save: db.transaction(({ task, hash, type }) => {
    db.prepare('INSERT INTO tasks(id, device_id, request_id, input_hash, data) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data')
      .run(task.id, task.device_id, task.request_id, hash ?? '', JSON.stringify(task));
    const event = {
      protocol_version: 1, event_id: randomUUID(), type,
      occurred_at: new Date().toISOString(),
      payload: { task_id: task.id, status: task.status, version: task.version }
    };
    const row = db.prepare('INSERT INTO events(device_id, data) VALUES (?,?)').run(task.device_id, JSON.stringify(event));
    return { ...event, event_seq: Number(row.lastInsertRowid) };
  }),
  events: ({ device, after }) => db.prepare('SELECT seq, data FROM events WHERE device_id = ? AND seq > ? ORDER BY seq LIMIT 100')
    .all(device, after).map(row => ({ ...JSON.parse(row.data), event_seq: row.seq })),
  close: () => { db.close(); return true; }
};
function excerpt(text, query) {
  const start = Math.max(0, text.toLowerCase().indexOf(query.toLowerCase()) - 200);
  return text.slice(start, start + 2000);
}
parentPort.on('message', ({ id, op, args }) => {
  try {
    if (!Object.hasOwn(operations, op)) throw new Error('Unknown storage operation');
    parentPort.postMessage({ id, result: operations[op](args) });
  } catch (error) {
    parentPort.postMessage({ id, error: error.message });
  }
});
