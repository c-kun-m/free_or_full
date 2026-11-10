import { CodexEngine } from '../apps/companion/src/codex.js';
const engine = new CodexEngine({
  executable: process.env.PA_CODEX_BIN ?? 'codex', cwd: process.cwd(), sandbox: 'read-only',
  model: process.env.PA_CODEX_MODEL, effort: 'low',
  trace: process.argv.includes('--trace') ? method => console.error('[protocol] ' + method) : undefined
});
try {
  await engine.connect();
  const account = await engine.request('account/read', { refreshToken: false });
  console.log(JSON.stringify({ handshake: 'ok', authenticated: Boolean(account.account), requiresOpenaiAuth: account.requiresOpenaiAuth }));
  if (process.argv.includes('--run')) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90_000);
    try {
      const status = await engine.run({ prompt: 'Reply with READY only. Do not use tools or read or modify any files.', signal: controller.signal }, {
        started: async () => {}, approval: async approval => { if (approval) engine.decide(approval.id, false); },
        text: async text => { process.stdout.write(text); }
      });
      console.log('\nTurn status: ' + status);
      if (status !== 'succeeded') process.exitCode = 1;
    } finally { clearTimeout(timer); }
  }
} finally { await engine.close(); }
