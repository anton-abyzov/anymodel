import { it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { fixtureSource, TASKS } from '../tasks.mjs';
import { scoreTask } from '../scoring.mjs';
for(const task of TASKS)it(`frozen pre-fix ${task.id} fails meaningful acceptance checks`,()=>{
  assert.ok(fixtureSource(task.id).length>1000);
  const result=scoreTask(task.id,fileURLToPath(new URL(`../fixtures/${task.id}.mjs`,import.meta.url)));
  assert.equal(result.scorerExitCode,0);
  assert.equal(result.artifactPassed,false);
  assert.ok(result.passedCount<result.total);
});
