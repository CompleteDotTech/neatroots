// Integration test against the action's installed, immutable source build.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

for (const [file, only, expected] of [
  ['clean.json', 'action-fixture-hit', 0],
  ['failing.json', 'action-fixture-hit', 1],
  ['clean.json', 'no-such-action-fixture-rule', 2],
]) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./run.mjs', import.meta.url))], {
    env: { ...process.env, INPUT_RUNS: fileURLToPath(new URL(`./fixtures/${file}`, import.meta.url)),
      INPUT_CHECKS: fileURLToPath(new URL('./fixtures/checks', import.meta.url)), INPUT_ONLY: only },
    encoding: 'utf8', shell: false,
  });
  assert.equal(result.status, expected, `Expected ${expected} for ${file}; ${result.stdout}`);
  console.log(`Real CLI ${file} / ${only}: exit ${expected}`);
}
