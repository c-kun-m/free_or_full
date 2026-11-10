import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { request } from 'node:https';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const data = await mkdtemp(join(tmpdir(), 'phone-assistant-smoke-'));
const port = await new Promise<number>(resolve => {
  const server = createServer();
  server.listen(0, '127.0.0.1', () => {
    const port = (server.address() as { port: number }).port;
    server.close(() => resolve(port));
  });
});
const child = spawn(process.execPath, ['dist/apps/companion/src/main.js'], {
  env: { ...process.env, PA_HOST: '127.0.0.1', PA_PORT: String(port), PA_DATA_DIR: data, PA_SANDBOX: 'read-only' },
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
});
try {
  const code = await new Promise<string>((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Service startup timed out')), 20000);
    child.once('exit', status => { clearTimeout(timer); reject(new Error('Service exited during startup: ' + status)); });
    child.stdout.on('data', bytes => {
      output += bytes.toString();
      const code = output.match(/Pairing code \(one use, 5 minutes\): ([a-f0-9]+)/)?.[1];
      if (code) { clearTimeout(timer); resolve(code); }
    });
    child.stderr.on('data', bytes => { process.stderr.write(bytes); });
  });
  const { cert } = JSON.parse(await readFile(join(data, 'tls.json'), 'utf8'));
  const call = (path: string, body?: unknown, token?: string) => new Promise<any>((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port, path, ca: cert, method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }
    }, response => {
      let text = '';
      response.on('data', bytes => { text += bytes.toString(); });
      response.on('end', () => {
        if (!response.statusCode || response.statusCode >= 300) reject(new Error('HTTP ' + response.statusCode));
        else { try { resolve(JSON.parse(text)); } catch (error) { reject(error); } }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('HTTP timeout')));
    req.end(body ? JSON.stringify(body) : undefined);
  });
  if (!(await call('/health')).ok) throw new Error('Health check failed');
  const paired = await call('/v1/pairings/claim', { code, name: 'smoke' });
  const tasks = await call('/v1/tasks', undefined, paired.token);
  if (tasks.tasks.length !== 0) throw new Error('Unexpected initial tasks');
  const snapshot = await call('/v1/snapshot', undefined, paired.token);
  const info = await call('/v1/info', undefined, paired.token);
  if (snapshot.chats.length !== 0 || info.assistant.framework !== 'langchain') throw new Error('Unexpected assistant contract');
  console.log('PASS: compiled service startup, trusted TLS, pairing, task/chat snapshot and LangChain configuration status');
} finally {
  await new Promise<void>(resolve => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', () => resolve()); child.kill();
  });
  if (!resolve(data).startsWith(resolve(tmpdir()) + '\\') && !resolve(data).startsWith(resolve(tmpdir()) + '/')) {
    throw new Error('Refusing cleanup outside the temporary directory');
  }
  await rm(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
