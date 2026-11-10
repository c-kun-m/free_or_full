import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import rateLimit from '@fastify/rate-limit';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { WebSocket } from 'ws';
import type { CodingEngine } from './codex.js';
import { Store } from './storage/store.js';
import { ServiceError, TaskService } from './tasks.js';
import { taskInputSchema } from '../../../packages/protocol/src/index.js';
import { ChatService } from './chats.js';
import type { AssistantEngine } from './assistant.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export async function createApp(options: { dbPath: string; engine: CodingEngine; projectName: string; tls?: { key: string; cert: string }; logger?: boolean;
  assistantFactory?: (store: Store, tasks: TaskService) => AssistantEngine | undefined }) {
  const store = new Store(options.dbPath);
  const tasks = new TaskService(store, options.engine);
  await tasks.initialize();
  const chats = new ChatService(store, tasks, options.assistantFactory?.(store, tasks));
  await chats.initialize();
  const app = Fastify({
    ...(options.tls ? { https: options.tls } : {}),
    logger: options.logger ? { redact: ['req.headers.authorization'], level: 'info' } : false,
    bodyLimit: 64 * 1024
  });
  const devices = new WeakMap<object, string>();
  const sockets = new Set<WebSocket>();
  let pairing = { code: randomBytes(16).toString('hex'), expires: Date.now() + 5 * 60_000 };
  await app.register(rateLimit, { max: 240, timeWindow: '1 minute' });
  await app.register(websocket, { options: { maxPayload: 4096 } });
  app.addHook('onRequest', async (request, reply) => {
    if (request.headers.origin) return reply.code(403).send({ error: 'Browser origins are not accepted by this device API' });
    const path = request.url.split('?')[0];
    if (path === '/health' || path === '/v1/pairings/claim') return;
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer ')) return reply.code(401).send({ error: 'Device authentication required' });
    const device = await store.call('deviceGet', { hash: hash(authorization.slice(7)) });
    if (!device) return reply.code(401).send({ error: 'Invalid or revoked device credential' });
    devices.set(request, device.id);
  });
  app.setErrorHandler((error, request, reply) => {
    const failure = error as Error & { statusCode?: number };
    const status = failure.statusCode ?? 500;
    if (status >= 500) request.log.error({ err: error }, 'Request failed');
    reply.code(status).send({ error: status >= 500 ? 'Internal service error' : failure.message });
  });
  app.get('/health', async () => ({ ok: true, protocol_version: 1 }));
  app.post<{ Body: { code: string; name: string } }>('/v1/pairings/claim', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    schema: { body: {
      type: 'object', additionalProperties: false, required: ['code', 'name'],
      properties: { code: { type: 'string', maxLength: 128 }, name: { type: 'string', minLength: 1, maxLength: 80 } }
    } }
  }, async (request, reply) => {
    if (Date.now() > pairing.expires || !timingSafeEqual(Buffer.from(hash(request.body.code)), Buffer.from(hash(pairing.code)))) {
      throw new ServiceError(401, 'Pairing code invalid or expired');
    }
    pairing.expires = 0; // consume before awaiting storage
    const token = randomBytes(32).toString('base64url');
    const id = randomUUID();
    await store.call('deviceAdd', { id, hash: hash(token), name: request.body.name });
    return reply.code(201).send({ device_id: id, token });
  });
  app.get('/v1/info', async () => ({ protocol_version: 1, project_name: options.projectName,
    assistant: { framework: 'langchain', configured: chats.configured } }));
  app.get('/v1/snapshot', async request => store.call('snapshot', { device: devices.get(request)! }));
  app.post<{ Body: { request_id: string; prompt: string; conversation_id?: string } }>('/v1/chats',
    { schema: { body: taskInputSchema } },
    async (request, reply) => reply.code(202).send(await chats.submit(devices.get(request)!, request.body)));
  app.get<{ Params: { id: string } }>('/v1/chats/:id', async request => chats.get(devices.get(request)!, request.params.id));
  app.post<{ Params: { id: string } }>('/v1/chats/:id/cancel', async request => chats.cancel(devices.get(request)!, request.params.id));
  app.get('/v1/tasks', async request => store.call('snapshot', { device: devices.get(request)! }));
  app.post<{ Body: { request_id: string; prompt: string; conversation_id?: string } }>('/v1/tasks',
    { schema: { body: taskInputSchema } },
    async (request, reply) => reply.code(202).send(await tasks.submit(devices.get(request)!, request.body)));
  app.get<{ Params: { id: string } }>('/v1/tasks/:id', async request => tasks.get(devices.get(request)!, request.params.id));
  app.post<{ Params: { id: string } }>('/v1/tasks/:id/cancel', async request => tasks.cancel(devices.get(request)!, request.params.id));
  app.post<{ Params: { id: string }; Body: { approval_id: string; allow: boolean } }>('/v1/tasks/:id/approval', {
    schema: { body: {
      type: 'object', additionalProperties: false, required: ['approval_id', 'allow'],
      properties: { approval_id: { type: 'string', maxLength: 100 }, allow: { type: 'boolean' } }
    } }
  }, async request => tasks.decide(devices.get(request)!, request.params.id, request.body.approval_id, request.body.allow));
  app.get<{ Querystring: { after?: number } }>('/v1/events/history', {
    schema: { querystring: { type: 'object', properties: { after: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER } } } }
  }, async request => ({ events: await store.call('events', { device: devices.get(request)!, after: request.query.after ?? 0 }) }));
  app.get<{ Querystring: { after?: number } }>('/v1/events', {
    websocket: true,
    schema: { querystring: { type: 'object', properties: { after: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER } } } }
  }, (socket, request) => {
    sockets.add(socket);
    let cursor = request.query.after ?? 0;
    let busy = false;
    const drain = async () => {
      if (busy || socket.readyState !== 1) return;
      busy = true;
      try {
        if (socket.bufferedAmount > 256_000) { socket.close(1013, 'Reconnect and replay'); return; }
        const events = await store.call('events', { device: devices.get(request)!, after: cursor });
        for (const event of events) {
          if (socket.readyState !== 1) break;
          socket.send(JSON.stringify(event)); cursor = event.event_seq;
        }
      } catch { socket.close(1011, 'Event stream unavailable'); }
      finally { busy = false; }
    };
    const timer = setInterval(() => void drain(), 250);
    socket.on('close', () => { clearInterval(timer); sockets.delete(socket); });
    socket.on('error', () => socket.close());
    void drain();
  });
  app.addHook('preClose', async () => { for (const socket of sockets) socket.close(1001, 'Server stopping'); });
  app.addHook('onClose', async () => { await chats.close(); await tasks.close(); await store.close(); });
  return { app, tasks, chats, store, pairingCode: pairing.code };
}
