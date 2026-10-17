import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { filesFor, run } from './run.mjs';
import { installEnvironment } from './install.mjs';

test('installer ignores ambient source, bundle, repo and runtime overrides', () => {
  const env = installEnvironment({ RUNNER_TEMP: '/tmp/runner', PATH: '/bin', NEATROOTS_BUNDLE: 'evil', NEATROOTS_FROM_SOURCE: '1', NEATROOTS_GITHUB_REPO: 'evil', NEATROOTS_NODE: 'evil', NEATROOTS_VERSION: 'latest' }, '0.2.8');
  assert.equal(env.NEATROOTS_VERSION, undefined);
  assert.equal(env.NEATROOTS_REF, '0.2.8');
  assert.equal(env.NEATROOTS_BUNDLE, undefined);
  assert.equal(env.NEATROOTS_FROM_SOURCE, '1');
  assert.equal(env.NEATROOTS_GITHUB_REPO, undefined);
  assert.equal(env.NEATROOTS_NODE, undefined);
  assert.equal(env.PATH, '/bin');
});

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'action-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'runs'));
  fs.writeFileSync(path.join(dir, 'runs', 'trace.json'), '{}');
  return { dir, env: { INPUT_RUNS: path.join(dir, 'runs'), RUNNER_TEMP: dir, GITHUB_STEP_SUMMARY: path.join(dir, 'summary') } };
}
for (const status of [0, 1, 2]) test(`preserves CLI exit ${status} and contains private output`, t => {
  const { env } = fixture(t);
  const output = [];
  const data = { rules: ['hit'], errors: status === 2 ? ['SECRET'] : [], runs: [{ trace_id: 'a'.repeat(32), root_name: 'SECRET', findings: status === 1 ? [{ check_id: 'hit', title: 'SECRET\n::error::attack', params: { key: 'SECRET' }, evidence_span_ids: ['b'.repeat(16)] }] : [] }] };
  assert.equal(run(env, () => ({ status, stdout: JSON.stringify(data), stderr: 'SECRET' }), x => output.push(x)), status);
  const published = output.join('\n') + fs.readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8');
  assert.ok(!published.includes('SECRET'));
  if (status === 1) assert.match(published, /check hit; spans b/);
});
test('uses argument arrays and terminates variadic checks before file paths', t => {
  const { env, dir } = fixture(t);
  env.INPUT_CHECKS = 'checks with spaces\nother';
  env.INPUT_ONLY = 'hit,$(touch unwanted)';
  assert.equal(run(env, (binary, args, opts) => {
    assert.equal(binary, process.execPath);
    assert.equal(args[0], path.join(dir, 'neatroots-action-install', 'src', 'packages', 'neatroots', 'dist', 'cli.js'));
    assert.equal(opts.shell, false);
    assert.equal(args[4], env.INPUT_ONLY);
    assert.deepEqual(args.slice(5, 9), ['--checks', path.resolve('checks with spaces'), path.resolve('other'), '--']);
    assert.equal(args[9], path.join(dir, 'runs', 'trace.json'));
    assert.notEqual(opts.env.NEATROOTS_HOME, env.NEATROOTS_HOME);
    return { status: 0, stdout: '{"runs":[],"rules":[],"errors":[]}' };
  }, () => {}), 0);
});
for (const result of [{ status: null, error: new Error('SECRET') }, { status: 0, stdout: 'not JSON' }, { status: 0, stdout: '' }, { status: 7 }, { status: 0, stdout: '{"runs":[],"errors":["SECRET"],"rules":[]}' }]) {
  test('fails closed on unusable or inconsistent CLI results', t => {
    const { env } = fixture(t);
    assert.equal(run(env, () => result, () => {}), 2);
  });
}
test('recurses directories, ignores unrelated files, deduplicates and rejects empty inputs', t => {
  const { env } = fixture(t);
  fs.writeFileSync(path.join(env.INPUT_RUNS, 'ignored.txt'), 'SECRET');
  fs.mkdirSync(path.join(env.INPUT_RUNS, 'nested'));
  fs.writeFileSync(path.join(env.INPUT_RUNS, 'nested', 'trace.jsonl'), '{}');
  assert.equal(filesFor(`${env.INPUT_RUNS}\n${env.INPUT_RUNS}`).length, 2);
  assert.throws(() => filesFor(''));
});
test('withholds malformed identifiers and workflow command characters', t => {
  const { env } = fixture(t);
  const output = [];
  assert.equal(run(env, () => ({ status: 1, stdout: JSON.stringify({ rules: [], errors: [], runs: [{ trace_id: 'SECRET\n::error::injected', findings: [{ check_id: 'SECRET|<script>', evidence_span_ids: ['SECRET'] }] }] }) }), x => output.push(x)), 1);
  assert.ok(!output.join('').includes('SECRET'));
  assert.ok(!fs.readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8').includes('<script>'));
});
