import { expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { CodexEngine } from '../src/codex.js';

it('handles stdio handshake, interleaved deltas, and approval responses', async () => {
  const engine = new CodexEngine({
    executable: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url))],
    cwd: process.cwd(), sandbox: 'read-only'
  });
  const text: string[] = [];
  const approvals: string[] = [];
  try {
    const result = await engine.run({ prompt: 'fixture', signal: new AbortController().signal }, {
      started: async () => {},
      text: async delta => { text.push(delta); },
      approval: async approval => {
        if (approval) { approvals.push(approval.method); engine.decide(approval.id, false); }
      }
    });
    expect(result).toBe('succeeded');
    expect(text.join('')).toBe('hello');
    expect(approvals).toEqual(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval']);
  } finally { await engine.close(); }
});
