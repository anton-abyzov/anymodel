// US-006 (0013): the --local-agentic preset wires agentic-friendly defaults and keeps
// the Skill tool, without changing default behavior when the flag is absent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, applyLocalAgenticEnv } from '../cli.mjs';

test('US-006 (AC-US6-01) — --local-agentic sets the preset opts', () => {
  const o = parseArgs(['proxy', 'lmstudio', '--local-agentic']);
  assert.equal(o.localAgentic, true);
  assert.equal(o.fullMcp, true, 'keeps the Skill tool (full MCP)');
  assert.equal(o.localFidelity, 'balanced', 'defaults fidelity to balanced');
});

test('US-006 — explicit --local-fidelity is preserved alongside --local-agentic', () => {
  const o = parseArgs(['proxy', 'lmstudio', '--local-fidelity', 'full', '--local-agentic']);
  assert.equal(o.localAgentic, true);
  assert.equal(o.localFidelity, 'full', 'user choice not clobbered');
});

test('US-006 (AC-US6-01) — applyLocalAgenticEnv sets agentic env defaults', () => {
  const env = {};
  applyLocalAgenticEnv(env, { localAgentic: true });
  assert.equal(env.LOCAL_REFUSAL_RETRY, 'on');
  assert.equal(env.LOCAL_NUM_CTX, '65536');
  assert.equal(env.LOCAL_FIDELITY, 'balanced');
});

test('US-006 — applyLocalAgenticEnv never overrides explicit env', () => {
  const env = { LOCAL_REFUSAL_RETRY: 'off', LOCAL_NUM_CTX: '32768', LOCAL_FIDELITY: 'full' };
  applyLocalAgenticEnv(env, { localAgentic: true, localFidelity: 'balanced' });
  assert.deepEqual(env, { LOCAL_REFUSAL_RETRY: 'off', LOCAL_NUM_CTX: '32768', LOCAL_FIDELITY: 'full' });
});

test('US-006 (AC-US6-02) — default behavior unchanged without the flag', () => {
  const o = parseArgs(['proxy', 'lmstudio']);
  assert.equal(o.localAgentic, false);
  assert.equal(o.fullMcp, false, 'no implied full MCP');
  const env = { existing: '1' };
  assert.deepEqual(applyLocalAgenticEnv(env, o), { existing: '1' }, 'no env mutation when not opted in');
});
