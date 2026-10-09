import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { durableOutput } from '../durable-output.mjs';

test('completed events persist before close and split credentials never leak',()=>{
 const path=join(mkdtempSync(join(tmpdir(),'anymodel-output-')),'events.jsonl');
 const log=durableOutput(path,['fixture-secret-value']);
 log.write(Buffer.from('{"event":"started"}\n{"key":"fixture-sec'));
 assert.equal(readFileSync(path,'utf8'),'{"event":"started"}\n');
 log.write(Buffer.from('ret-value"}\n'));
 assert.equal(readFileSync(path,'utf8'),'{"event":"started"}\n{"key":"[REDACTED]"}\n');
 assert.equal(log.finish(),readFileSync(path,'utf8'));
});

test('incomplete credential suffix is redacted at close',()=>{
 const path=join(mkdtempSync(join(tmpdir(),'anymodel-output-')),'events.jsonl');
 const log=durableOutput(path,['fixture-secret-value']);log.write(Buffer.from('truncated fixture-secret'));
 assert.equal(log.finish(),'truncated [REDACTED_PARTIAL]');
});
