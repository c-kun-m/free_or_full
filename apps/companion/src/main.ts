import { mkdir, readFile, writeFile, realpath, stat } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import selfsigned from 'selfsigned';
import { CodexEngine } from './codex.js';
import { createApp } from './server.js';
import { configuredAssistant } from './assistant.js';

const dataDir = resolve(process.env.PA_DATA_DIR ?? '.local');
await mkdir(dataDir, { recursive: true });
const cwd = await realpath(process.env.PA_PROJECT_ROOT ?? process.cwd());
if (!(await stat(cwd)).isDirectory()) throw new Error('PA_PROJECT_ROOT must be a directory');
const sandbox = process.env.PA_SANDBOX ?? 'read-only';
if (sandbox !== 'read-only' && sandbox !== 'workspace-write') throw new Error('Invalid PA_SANDBOX');
const host = process.env.PA_HOST ?? '127.0.0.1';
const port = Number(process.env.PA_PORT ?? 4318);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PA_PORT');
const tlsPath = join(dataDir, 'tls.json');
let tls: { key: string; cert: string };
try { tls = JSON.parse(await readFile(tlsPath, 'utf8')); }
catch (error: any) {
  if (error.code !== 'ENOENT') throw error;
  const generated = await selfsigned.generate([{ name: 'commonName', value: 'Phone Assistant' }], {
    keySize: 2048, algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: [
        { type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' },
        ...Object.values(networkInterfaces()).flat().filter(address => address?.family === 'IPv4' && !address.internal)
          .map(address => ({ type: 7 as const, ip: address!.address }))
      ] }
    ]
  });
  tls = { key: generated.private, cert: generated.cert };
  await writeFile(tlsPath, JSON.stringify(tls), { mode: 0o600, flag: 'wx' });
}
const engine = new CodexEngine({ executable: process.env.PA_CODEX_BIN ?? 'codex', cwd, sandbox, model: process.env.PA_CODEX_MODEL });
const { app, chats, pairingCode } = await createApp({ dbPath: join(dataDir, 'assistant.sqlite'), engine, projectName: basename(cwd), tls, logger: true,
  assistantFactory: configuredAssistant });
await app.listen({ host, port });
console.log('Phone Assistant companion ready');
console.log('LangChain assistant: ' + (chats.configured ? 'configured' : 'set PA_AGENT_MODEL and OPENAI_API_KEY to enable chat'));
console.log('Project: ' + cwd + ' | Sandbox: ' + sandbox);
console.log('Pairing code (one use, 5 minutes): ' + pairingCode);
console.log('TLS certificate SHA-256: ' + new X509Certificate(tls.cert).fingerprint256.replaceAll(':', '').toLowerCase());
console.log('Address: https://' + host + ':' + port);
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  if (closing) return; closing = true;
  void app.close().then(() => process.exit(0), () => process.exit(1));
});
