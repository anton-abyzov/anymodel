// US-004 (0013): detect an RLHF capability-disclaimer refusal so the proxy can re-issue
// once with a "use your tools" nudge (opt-in, local-only, one retry per turn).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCapabilityRefusal, shouldRetryRefusal } from '../providers/openai.mjs';

test('US-004 — isCapabilityRefusal matches the real disclaimer phrasings', () => {
  for (const t of [
    "I can't actually access websites or browse the internet.",
    'I also can\'t deploy websites or run code.',
    'I cannot visit the URL you provided.',
    'I cannot run applications.',
    "I can't actually browse the web or deploy applications.",
    "I'm unable to access external resources.",
  ]) assert.equal(isCapabilityRefusal(t), true, `should flag: ${t}`);
});

test('US-004 — isCapabilityRefusal does NOT flag normal coding prose', () => {
  for (const t of [
    'I can access the file at src/index.ts.',
    "I can't find the function you mentioned.",   // can't + find (not a capability verb)
    'I will run the tests now.',
    'Let me deploy the change after review.',
    'Running the build and checking the output.',
    '',
  ]) assert.equal(isCapabilityRefusal(t), false, `should NOT flag: ${t}`);
});

test('US-004 (AC-US4-01) — retry fires on refusal + end_turn + tools + enabled', () => {
  assert.equal(shouldRetryRefusal({
    enabled: true, stopReason: 'end_turn', hasTools: true, text: "I can't browse the web.",
  }), true);
});

test('US-004 (AC-US4-02) — retry suppressed when disabled, no tools, not a refusal, or tool_use', () => {
  const base = { stopReason: 'end_turn', hasTools: true, text: "I can't deploy applications." };
  assert.equal(shouldRetryRefusal({ ...base, enabled: false }), false, 'disabled → no retry (default behavior)');
  assert.equal(shouldRetryRefusal({ ...base, enabled: true, hasTools: false }), false, 'no tools → no retry');
  assert.equal(shouldRetryRefusal({ ...base, enabled: true, stopReason: 'tool_use' }), false, 'already a tool call → no retry');
  assert.equal(shouldRetryRefusal({ ...base, enabled: true, text: 'Here is the result.' }), false, 'not a refusal → no retry');
});
