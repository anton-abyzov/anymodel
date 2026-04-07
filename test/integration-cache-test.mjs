// Integration test: verify prefix caching with real Ollama
import http from 'http';
import { createProxy } from '../proxy.mjs';

const OLLAMA_MODEL = 'llama3.1:8b';
const PORT = 19876;

function sendRequest(port, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const start = Date.now();
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        'x-api-key': 'test',
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const elapsed = Date.now() - start;
        const raw = Buffer.concat(chunks).toString();
        try {
          resolve({ status: res.statusCode, body: JSON.parse(raw), elapsed });
        } catch {
          resolve({ status: res.statusCode, body: raw, elapsed });
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(120000);
    req.write(payload);
    req.end();
  });
}

async function main() {
  console.log('=== AnyModel Prefix Cache Integration Test ===\n');

  const ollamaProvider = (await import('../providers/ollama.mjs')).default;

  const server = createProxy(ollamaProvider, { port: PORT, model: OLLAMA_MODEL, rpm: 999 });
  await new Promise(resolve => {
    if (server.listening) resolve();
    else server.on('listening', resolve);
  });
  const actualPort = server.address().port;
  console.log(`Proxy listening on :${actualPort}\n`);

  // Wait for warmup
  await new Promise(r => setTimeout(r, 3000));

  const systemPrompt = 'You are a helpful coding assistant. Today: 2026-04-07. Keep responses under 20 words.';
  const tools = [
    { name: 'Read', description: 'Read a file from disk with full content', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
    { name: 'Write', description: 'Write content to a file on disk', input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
    { name: 'Bash', description: 'Execute a bash command and return output', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
  ];

  const baseRequest = {
    model: OLLAMA_MODEL,
    max_tokens: 50,
    stream: false,
    system: systemPrompt,
    tools,
    messages: [{ role: 'user', content: 'What is 2+2? Answer in one word.' }],
  };

  // === TEST 1: First request (cache MISS) ===
  console.log('--- Test 1: First request (expect cache MISS) ---');
  const r1 = await sendRequest(actualPort, baseRequest);
  console.log(`Status: ${r1.status}`);
  console.log(`Elapsed: ${r1.elapsed}ms`);
  console.log(`cache_creation_input_tokens: ${r1.body?.usage?.cache_creation_input_tokens ?? 'MISSING'}`);
  console.log(`cache_read_input_tokens: ${r1.body?.usage?.cache_read_input_tokens ?? 'MISSING'}`);
  console.log(`Response text: ${r1.body?.content?.[0]?.text?.slice(0, 100) ?? 'N/A'}`);
  console.log('');

  // === TEST 2: Second request, same prefix (cache HIT) ===
  console.log('--- Test 2: Second request, same prefix (expect cache HIT) ---');
  const r2 = await sendRequest(actualPort, {
    ...baseRequest,
    messages: [{ role: 'user', content: 'What is 3+3? Answer in one word.' }],
  });
  console.log(`Status: ${r2.status}`);
  console.log(`Elapsed: ${r2.elapsed}ms`);
  console.log(`cache_creation_input_tokens: ${r2.body?.usage?.cache_creation_input_tokens ?? 'MISSING'}`);
  console.log(`cache_read_input_tokens: ${r2.body?.usage?.cache_read_input_tokens ?? 'MISSING'}`);
  console.log(`Response text: ${r2.body?.content?.[0]?.text?.slice(0, 100) ?? 'N/A'}`);
  console.log('');

  // === TEST 3: Different date, same template (cache HIT -- date normalized) ===
  // Runs right after Test 2 (same prefix) so lastHashByModel matches
  console.log('--- Test 3: Same prefix but different date (expect cache HIT -- date normalized) ---');
  const r3 = await sendRequest(actualPort, {
    ...baseRequest,
    system: 'You are a helpful coding assistant. Today: 2026-04-08. Keep responses under 20 words.',
    messages: [{ role: 'user', content: 'What is 4+4?' }],
  });
  console.log(`Status: ${r3.status}`);
  console.log(`Elapsed: ${r3.elapsed}ms`);
  console.log(`cache_creation_input_tokens: ${r3.body?.usage?.cache_creation_input_tokens ?? 'MISSING'}`);
  console.log(`cache_read_input_tokens: ${r3.body?.usage?.cache_read_input_tokens ?? 'MISSING'}`);
  console.log('');

  // === TEST 4: Tools in different order (cache HIT -- tools sorted before hash) ===
  console.log('--- Test 4: Tools reordered (expect cache HIT -- tools sorted before hash) ---');
  const r4 = await sendRequest(actualPort, {
    ...baseRequest,
    tools: [tools[2], tools[0], tools[1]], // Bash, Read, Write instead of Read, Write, Bash
    messages: [{ role: 'user', content: 'What is 5+5?' }],
  });
  console.log(`Status: ${r4.status}`);
  console.log(`Elapsed: ${r4.elapsed}ms`);
  console.log(`cache_creation_input_tokens: ${r4.body?.usage?.cache_creation_input_tokens ?? 'MISSING'}`);
  console.log(`cache_read_input_tokens: ${r4.body?.usage?.cache_read_input_tokens ?? 'MISSING'}`);
  console.log('');

  // === TEST 5: Different system prompt (cache MISS) ===
  console.log('--- Test 5: Different system prompt (expect cache MISS) ---');
  const r5 = await sendRequest(actualPort, {
    ...baseRequest,
    system: 'You are a math tutor. Today: 2026-04-07. Be concise.',
    messages: [{ role: 'user', content: 'What is 6+6?' }],
  });
  console.log(`Status: ${r5.status}`);
  console.log(`Elapsed: ${r5.elapsed}ms`);
  console.log(`cache_creation_input_tokens: ${r5.body?.usage?.cache_creation_input_tokens ?? 'MISSING'}`);
  console.log(`cache_read_input_tokens: ${r5.body?.usage?.cache_read_input_tokens ?? 'MISSING'}`);
  console.log('');

  // === TEST 6: Streaming mode ===
  console.log('--- Test 6: Streaming request (expect cache HIT + metrics in stream) ---');
  const streamResp = await new Promise((resolve, reject) => {
    const payload = JSON.stringify({ ...baseRequest, stream: true, messages: [{ role: 'user', content: 'Say hi' }] });
    const start = Date.now();
    const req = http.request({
      hostname: '127.0.0.1', port: actualPort, path: '/v1/messages', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'x-api-key': 'test' },
    }, res => {
      let data = '';
      res.on('data', c => { data += c.toString(); });
      res.on('end', () => resolve({ elapsed: Date.now() - start, data }));
    });
    req.on('error', reject);
    req.setTimeout(120000);
    req.write(payload);
    req.end();
  });
  const deltaLine = streamResp.data.split('\n').find(l => l.includes('message_delta') && l.includes('cache_'));
  console.log(`Elapsed: ${streamResp.elapsed}ms`);
  console.log(`Stream contains cache metrics: ${deltaLine ? 'YES' : 'NO'}`);
  if (deltaLine) {
    const parsed = JSON.parse(deltaLine.replace('data: ', ''));
    console.log(`  cache_read_input_tokens: ${parsed.usage?.cache_read_input_tokens ?? 'N/A'}`);
    console.log(`  cache_creation_input_tokens: ${parsed.usage?.cache_creation_input_tokens ?? 'N/A'}`);
  }
  console.log('');

  // === SUMMARY ===
  console.log('========== EVIDENCE SUMMARY ==========');
  console.log(`Test 1 (first request, MISS):    creation=${r1.body?.usage?.cache_creation_input_tokens}, read=${r1.body?.usage?.cache_read_input_tokens}, ${r1.elapsed}ms`);
  console.log(`Test 2 (same prefix, HIT):       creation=${r2.body?.usage?.cache_creation_input_tokens}, read=${r2.body?.usage?.cache_read_input_tokens}, ${r2.elapsed}ms`);
  console.log(`Test 3 (diff date, HIT):         creation=${r3.body?.usage?.cache_creation_input_tokens}, read=${r3.body?.usage?.cache_read_input_tokens}, ${r3.elapsed}ms`);
  console.log(`Test 4 (reordered tools, HIT):   creation=${r4.body?.usage?.cache_creation_input_tokens}, read=${r4.body?.usage?.cache_read_input_tokens}, ${r4.elapsed}ms`);
  console.log(`Test 5 (diff system, MISS):      creation=${r5.body?.usage?.cache_creation_input_tokens}, read=${r5.body?.usage?.cache_read_input_tokens}, ${r5.elapsed}ms`);
  console.log(`Test 6 (streaming, HIT):         stream cache metrics present: ${deltaLine ? 'YES' : 'NO'}`);
  console.log('');

  const allPassed =
    r1.body?.usage?.cache_creation_input_tokens > 0 &&
    r1.body?.usage?.cache_read_input_tokens === 0 &&
    r2.body?.usage?.cache_read_input_tokens > 0 &&
    r2.body?.usage?.cache_creation_input_tokens === 0 &&
    r3.body?.usage?.cache_read_input_tokens > 0 &&
    r3.body?.usage?.cache_creation_input_tokens === 0 &&
    r4.body?.usage?.cache_read_input_tokens > 0 &&
    r4.body?.usage?.cache_creation_input_tokens === 0 &&
    r5.body?.usage?.cache_creation_input_tokens > 0 &&
    r5.body?.usage?.cache_read_input_tokens === 0 &&
    deltaLine;

  console.log(allPassed ? 'ALL TESTS PASSED -- prefix caching is working correctly' : 'SOME TESTS FAILED -- review output above');

  server.close();
  process.exit(allPassed ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
