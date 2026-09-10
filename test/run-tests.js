#!/usr/bin/env node
// Relay Bridge's own suite.
//
// It builds a throwaway repository with two bare remotes standing in for GitHub
// and GitLab, starts the real server against it, and drives the real HTTP
// surface. Nothing is mocked, because the bugs worth catching here live in the
// seams -- a command built from the wrong config key, a gate that forgets to
// close, a guard that waves through a header it should refuse.
//
// The remotes are deliberately NOT called origin/gitlab and the branch is not
// main, so a test can only pass if the tool is genuinely reading its config
// rather than falling back to the defaults.
//
// No dependencies, no framework, on purpose: the tool has none either.

import { execFileSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ENTRY = fileURLToPath(new URL('../relay-bridge.mjs', import.meta.url));
// Two servers run over the course of the suite. They get different ports on
// purpose: reusing one means the second can land on the first's socket while it
// is still closing, which fails as a timeout that looks nothing like its cause.
const FIRST_PORT = 4400 + Math.floor(Math.random() * 80);
let PORT = FIRST_PORT;
let BASE = `http://127.0.0.1:${PORT}`;

function usePort(port) {
  PORT = port;
  BASE = `http://127.0.0.1:${port}`;
}

let passed = 0;
let failed = 0;

function ok(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok    ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail === undefined ? '' : `\n          got: ${detail}`}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

// --- the rig ---------------------------------------------------------------

function buildRig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-bridge-test-'));
  const hub = path.join(root, 'hub.git');
  const bench = path.join(root, 'bench.git');
  const work = path.join(root, 'work');
  const agent = path.join(root, 'agent');

  git(['init', '--bare', '-q', '-b', 'trunk', hub], root);
  git(['init', '--bare', '-q', '-b', 'trunk', bench], root);

  fs.mkdirSync(work);
  git(['init', '-q', '-b', 'trunk'], work);
  git(['config', 'user.name', 'Test'], work);
  git(['config', 'user.email', 'test@example.com'], work);
  git(['remote', 'add', 'hub', hub], work);
  git(['remote', 'add', 'bench', bench], work);
  fs.writeFileSync(path.join(work, 'package.json'), '{"name":"rig","private":true}\n');
  fs.writeFileSync(path.join(work, 'a.txt'), 'base\n');
  git(['add', '-A'], work);
  git(['commit', '-qm', 'first'], work);
  git(['push', '-q', 'hub', 'trunk'], work);
  git(['push', '-q', 'bench', 'trunk'], work);

  // Something for "Get work" to find: a commit that exists only on the workbench.
  git(['clone', '-q', bench, agent], root);
  git(['config', 'user.name', 'Agent'], agent);
  git(['config', 'user.email', 'agent@example.com'], agent);
  fs.writeFileSync(path.join(agent, 'b.txt'), 'from the workbench\n');
  git(['add', '-A'], agent);
  git(['commit', '-qm', 'work done on the workbench'], agent);
  git(['push', '-q', 'origin', 'trunk'], agent);
  git(['fetch', '-q', '--all'], work);

  return { root, work };
}

// --- talking to the server -------------------------------------------------

const getJson = (p) => fetch(BASE + p).then((r) => r.json());
const post = (p, body) => fetch(BASE + p, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body ?? {}),
});
const postJson = (p, body) => post(p, body).then((r) => r.json());

// fetch() silently drops Host -- it is a forbidden header name -- so a guard
// test written with fetch would pass without ever exercising the guard.
function rawStatus(headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: '/api/state', method: 'GET', headers },
      (res) => { res.resume(); resolve(res.statusCode); },
    );
    req.on('error', reject);
    req.end();
  });
}

async function settle() {
  for (let i = 0; i < 100; i += 1) {
    const state = await getJson('/api/state');
    if (!state.job.running) return state;
    await sleep(200);
  }
  throw new Error('a job never finished');
}

function startServer(cwd, env) {
  const child = spawn(process.execPath, [ENTRY, '--no-open', '--port', String(PORT)], {
    cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (c) => { log += c; });
  child.stderr.on('data', (c) => { log += c; });
  child.on('error', (e) => { log += `spawn failed: ${e.message}`; });
  return { child, log: () => log };
}

async function waitForServer(server) {
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`${BASE}/api/state`);
      if (res.ok) return;
    } catch { /* not listening yet */ }
    await sleep(200);
  }
  throw new Error(`server never came up on ${PORT}\n${server.log()}`);
}

// Waiting for the process to actually exit, rather than sleeping and hoping.
function stopServer(server) {
  return new Promise((resolve) => {
    const child = server.child;
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    const done = () => resolve();
    child.once('exit', done);
    child.kill();
    setTimeout(done, 3000);
  });
}

// --- the tests -------------------------------------------------------------

const PASSING = `${JSON.stringify(process.execPath)} -e "process.exit(0)"`;
const FAILING = `${JSON.stringify(process.execPath)} -e "process.exit(1)"`;

const CONFIG = {
  safeRemote: 'hub',
  workbenchRemote: 'bench',
  branch: 'trunk',
  testCommand: PASSING,
  runCommand: '',
  projectName: 'rig',
  port: PORT,
};

async function run(rig) {
  // --- setup gate ----------------------------------------------------------
  let state = await getJson('/api/state');
  ok('an unconfigured repo reports configured:false', state.configured === false, state.configured);
  ok('the checked-out branch is detected', state.config.branch === 'trunk', state.config.branch);
  // No remote URL here looks like github.com, so detection has no candidate and
  // is expected to fall back rather than guess from the remote's name.
  ok('the safe falls back to the default', state.config.safeRemote === 'origin', state.config.safeRemote);
  ok('no shadow warning without env vars', state.shadowed.length === 0, JSON.stringify(state.shadowed));

  // --- validation ----------------------------------------------------------
  let body = await postJson('/api/config', { ...CONFIG, branch: 'a; rm -rf /' });
  ok('a branch with shell metacharacters is refused', /may only contain/.test(body.error || ''), JSON.stringify(body));
  body = await postJson('/api/config', { ...CONFIG, workbenchRemote: 'hub' });
  ok('the safe and workbench cannot be the same remote', /two different remotes/.test(body.error || ''), JSON.stringify(body));
  body = await postJson('/api/config', { ...CONFIG, port: 99999 });
  ok('an out-of-range port is refused', /between 1 and 65535/.test(body.error || ''), JSON.stringify(body));
  body = await postJson('/api/config', { ...CONFIG, branch: '' });
  ok('an empty branch is refused', /cannot be empty/.test(body.error || ''), JSON.stringify(body));

  // --- saving --------------------------------------------------------------
  body = await postJson('/api/config', CONFIG);
  ok('a valid config saves', body.ok === true, JSON.stringify(body));
  state = await getJson('/api/state');
  ok('the repo is configured afterwards', state.configured === true, state.configured);

  // The point of the odd names: these strings can only be right if the commands
  // are built from the config rather than from the defaults.
  ok('publish is built from the configured names',
    state.commands.publish === 'git push hub trunk --tags && git push bench trunk --tags',
    state.commands.publish);
  ok('discard resets to the safe, not the workbench',
    state.commands.discard === 'git reset --hard hub/trunk', state.commands.discard);
  ok('get merges from the workbench with --ff-only',
    state.commands.get === 'git diff --stat HEAD bench/trunk && git merge --ff-only bench/trunk',
    state.commands.get);

  // --- the gate ------------------------------------------------------------
  ok('the gate starts closed', state.tested === false, state.tested);
  ok('the workbench commit is waiting to come down', state.incoming.length === 1, JSON.stringify(state.incoming));

  await post('/api/action/get');
  state = await settle();
  ok('get succeeds', state.job.code === 0, state.job.output);
  ok('getting work leaves the gate closed', state.tested === false, state.tested);

  await post('/api/action/test');
  state = await settle();
  ok('a passing suite exits 0', state.job.code === 0, state.job.output);
  ok('a passing suite opens the gate', state.tested === true, state.tested);

  await postJson('/api/config', CONFIG);
  state = await getJson('/api/state');
  ok('changing settings closes the gate again', state.tested === false, state.tested);

  await postJson('/api/config', { ...CONFIG, testCommand: FAILING });
  await post('/api/action/test');
  state = await settle();
  ok('a failing suite exits non-zero', state.job.code !== 0, state.job.code);
  ok('a failing suite leaves the gate closed', state.tested === false, state.tested);

  await postJson('/api/config', CONFIG);
  await post('/api/action/test');
  await settle();
  await post('/api/action/publish');
  state = await settle();
  ok('publish succeeds', state.job.code === 0, state.job.output);
  ok('nothing is left to publish', state.outgoing.length === 0, JSON.stringify(state.outgoing));
  ok('the safe now has the work',
    git(['rev-parse', 'hub/trunk'], rig.work) === git(['rev-parse', 'HEAD'], rig.work));
  ok('the workbench was pushed to as well',
    git(['rev-parse', 'bench/trunk'], rig.work) === git(['rev-parse', 'HEAD'], rig.work));

  // --- divergence ----------------------------------------------------------
  // Both sides move independently. --ff-only must refuse, and must say why.
  fs.writeFileSync(path.join(rig.work, 'mine.txt'), 'made on the laptop\n');
  git(['add', 'mine.txt'], rig.work);
  git(['commit', '-qm', 'my own local commit'], rig.work);
  const theirs = path.join(rig.root, 'agent');
  git(['pull', '-q', '--ff-only', 'origin', 'trunk'], theirs);
  fs.writeFileSync(path.join(theirs, 'theirs.txt'), 'made on the workbench\n');
  git(['add', '-A'], theirs);
  git(['commit', '-qm', 'their commit'], theirs);
  git(['push', '-q', 'origin', 'trunk'], theirs);
  // The tool only fetches on its own slow clock, so without this the workbench
  // ref would still be stale and the merge would report "already up to date"
  // -- testing nothing. The divergence has to be visible locally to be refused.
  git(['fetch', '-q', 'bench'], rig.work);

  const before = git(['rev-parse', 'HEAD'], rig.work);
  await post('/api/action/get');
  state = await settle();
  ok('a diverged get fails instead of inventing a merge', state.job.code !== 0, state.job.code);
  ok('it explains the divergence in plain words',
    /both moved on/.test(state.job.output), state.job.output.slice(-200));
  ok('it names the manual way out',
    /git merge bench\/trunk/.test(state.job.output), state.job.output.slice(-200));
  ok('a refused get changes nothing', git(['rev-parse', 'HEAD'], rig.work) === before);

  // --- refusals ------------------------------------------------------------
  let res = await post('/api/action/nope');
  ok('an unknown action is 404', res.status === 404, res.status);
  await postJson('/api/config', { ...CONFIG, runCommand: '' });
  res = await post('/api/action/run');
  ok('a blank run command is refused rather than run', res.status === 400, res.status);

  // --- the localhost guard -------------------------------------------------
  ok('a foreign Host is rejected', await rawStatus({ Host: 'evil.example' }) === 403);
  ok('a localhost Host is allowed', await rawStatus({ Host: `localhost:${PORT}` }) === 200);
  ok('a cross-site Origin is rejected', await rawStatus({ Origin: 'http://evil.example' }) === 403);
  ok('a same-origin Origin is allowed', await rawStatus({ Origin: BASE }) === 200);
}

// The environment outranks the file, so this needs a server of its own: the
// variables are read once, at startup.
async function runEnvShadow(rig) {
  const server = startServer(rig.work, { RELAY_BRIDGE_BRANCH: 'release' });
  current = server;
  try {
    await waitForServer(server);
    const state = await getJson('/api/state');
    ok('an env var wins over the saved branch', state.config.branch === 'release', state.config.branch);
    ok('the shadowed key is reported',
      state.shadowed.length === 1 && state.shadowed[0].variable === 'RELAY_BRIDGE_BRANCH',
      JSON.stringify(state.shadowed));
    ok('the report carries the value actually in use',
      state.shadowed[0].value === 'release' && state.shadowed[0].saved === 'trunk',
      JSON.stringify(state.shadowed[0]));

    const saved = await postJson('/api/config', { ...CONFIG, port: PORT, branch: 'main' });
    ok('saving over a shadowed key still succeeds', saved.ok === true, JSON.stringify(saved));
    ok('the save admits the environment overrode it',
      saved.shadowed.length === 1 && saved.shadowed[0].saved === 'main',
      JSON.stringify(saved.shadowed));
    const onDisk = JSON.parse(fs.readFileSync(path.join(rig.work, 'relay-bridge.config.json'), 'utf8'));
    ok('the file still received the typed value', onDisk.branch === 'main', onDisk.branch);
  } finally {
    await stopServer(server);
  }
}

// --- main ------------------------------------------------------------------

const rig = buildRig();
let current = startServer(rig.work);

try {
  await waitForServer(current);
  await run(rig);
  await stopServer(current);
  usePort(FIRST_PORT + 1);
  await runEnvShadow(rig);
} catch (error) {
  failed += 1;
  console.log(`\n  the suite could not finish: ${error.message}`);
  const log = current.log().trim();
  if (log) console.log(`\n  --- server output ---\n${log.split('\n').map((l) => `  ${l}`).join('\n')}`);
} finally {
  await stopServer(current);
  try { fs.rmSync(rig.root, { recursive: true, force: true, maxRetries: 5 }); } catch { /* windows */ }
}

console.log(`\n  ${passed} passing${failed ? `, ${failed} failing` : ''}\n`);
process.exit(failed ? 1 : 0);
