#!/usr/bin/env node
/**
 * Relay Bridge -- a local dashboard for the GitHub/GitLab shuffle.
 *
 * The model it enforces:
 *   GitHub, "the safe"       permanent, never expires, nothing is ever lost.
 *   GitLab, "the workbench"  disposable, swapped when trial credits run out.
 *   Your laptop              carries work between the two, and is the only
 *                            place the test suite actually runs.
 *
 * The one rule it exists to protect: nothing reaches the safe until the suite
 * has passed. Getting work down and publishing it are deliberately separate
 * buttons, because collapsing them into one is the mistake this prevents.
 *
 * One file, zero dependencies, plain Node.
 *
 * Run: npx relay-bridge   (from inside the repository you want to manage)
 */

import { execSync, spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = process.cwd();
const CONFIG_FILE = path.join(ROOT, 'relay-bridge.config.json');

// Read the real version when installed as a package. Guarded by the name check
// because a standalone copy of this file sitting in someone's repo root would
// otherwise resolve `./package.json` to *their* project and report its version.
const VERSION = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
    if (pkg.name === 'relay-bridge') return pkg.version;
  } catch { /* standalone copy, fall through */ }
  return '0.1.0';
})();

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULTS = {
  safeRemote: 'origin',
  workbenchRemote: 'gitlab',
  branch: 'main',
  testCommand: '',
  runCommand: '',
  projectName: '',
  port: 4317,
};

const KEYS = Object.keys(DEFAULTS);

const ENV_KEYS = {
  safeRemote: 'RELAY_BRIDGE_SAFE_REMOTE',
  workbenchRemote: 'RELAY_BRIDGE_WORKBENCH_REMOTE',
  branch: 'RELAY_BRIDGE_BRANCH',
  testCommand: 'RELAY_BRIDGE_TEST_COMMAND',
  runCommand: 'RELAY_BRIDGE_RUN_COMMAND',
  projectName: 'RELAY_BRIDGE_PROJECT_NAME',
  port: 'RELAY_BRIDGE_PORT',
};

const LABELS = {
  safeRemote: 'Safe remote',
  workbenchRemote: 'Workbench remote',
  branch: 'Branch',
  testCommand: 'Test command',
  runCommand: 'Run command',
  projectName: 'New project name',
  port: 'Port',
};

/** Capture a command's output. Returns null instead of throwing. */
function read(command) {
  try {
    return execSync(command, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function packageScripts() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts || {};
  } catch {
    return {};
  }
}

// Guesses good enough to hand someone a filled-in form on first run. Every one
// of them is wrong for somebody, which is why the setup screen shows them for
// correction rather than adopting them silently.
function detect() {
  const remotes = (read('git remote -v') || '')
    .split('\n')
    .map((line) => line.split(/\s+/))
    .filter((parts) => parts.length >= 2)
    .map(([name, url]) => ({ name, url }));
  const byUrl = (needle, fallback) => remotes.find((r) => r.url.includes(needle))?.name || fallback;

  const scripts = packageScripts();
  // `npm init` writes a placeholder test script that only exits 1. Detecting it
  // would gate publishing behind a command that can never pass.
  const realTest = scripts.test && !/no test specified/i.test(scripts.test);
  const runScript = ['dev', 'start', 'restart'].find((name) => scripts[name]);

  return {
    safeRemote: byUrl('github.com', DEFAULTS.safeRemote),
    workbenchRemote: byUrl('gitlab.', DEFAULTS.workbenchRemote),
    branch: read('git symbolic-ref --short HEAD') || DEFAULTS.branch,
    testCommand: realTest ? 'npm test'
      : fs.existsSync(path.join(ROOT, 'test', 'run-tests.js')) ? 'node test/run-tests.js'
        : '',
    runCommand: runScript ? `npm run ${runScript}` : '',
    projectName: path.basename(ROOT),
    port: DEFAULTS.port,
  };
}

// Remote names and the branch are interpolated straight into shell strings, so
// they are held to what git actually allows. The two command fields are not
// checked at all -- running the command you asked for is the entire job.
const REF_OK = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

function validate(config) {
  for (const key of ['safeRemote', 'workbenchRemote', 'branch']) {
    if (!config[key]) return `${LABELS[key]} cannot be empty.`;
    if (!REF_OK.test(config[key])) {
      return `${LABELS[key]} may only contain letters, numbers, dot, dash, underscore and slash `
        + `— got "${config[key]}".`;
    }
  }
  if (config.safeRemote === config.workbenchRemote) {
    return 'The safe and the workbench have to be two different remotes, or publishing means nothing.';
  }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    return `Port must be a whole number between 1 and 65535 — got "${config.port}".`;
  }
  return null;
}

function normalize(input, base) {
  const out = { ...base };
  for (const key of KEYS) {
    const value = input?.[key];
    if (value === undefined || value === null) continue;
    out[key] = key === 'port' ? Number(value) : String(value).trim();
  }
  return out;
}

function envOverrides() {
  const out = {};
  for (const key of KEYS) {
    const value = process.env[ENV_KEYS[key]];
    if (value !== undefined && value !== '') out[key] = value;
  }
  return out;
}

let configured = false;
let config = { ...DEFAULTS };
let configFile = null;

// defaults <- detected <- config file <- environment. The file is the record of
// a decision someone made; the environment wins over it so a one-off run can
// point at another branch without editing anything.
function loadConfig() {
  let file = null;
  try {
    file = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    file = null;
  }
  configured = file !== null;
  configFile = file;
  config = normalize(envOverrides(), normalize(file, { ...DEFAULTS, ...detect() }));
  return config;
}

// Settings whose saved value is not the one in effect, because the environment
// outranks the file. That precedence is the point, but silence about it is not:
// you would type a branch, save, watch the field come back holding something
// else, and have nothing to blame but the tool. So the page is told which
// variable did it. Compares against the file rather than re-running detect(),
// because this is read on every poll.
function shadowedKeys() {
  if (!configFile) return [];
  const out = [];
  for (const key of KEYS) {
    const fromEnv = process.env[ENV_KEYS[key]];
    if (fromEnv === undefined || fromEnv === '') continue;
    const saved = configFile[key];
    if (saved === undefined || saved === null) continue;
    if (String(config[key]) === String(saved).trim()) continue;
    out.push({
      key,
      label: LABELS[key] || key,
      variable: ENV_KEYS[key],
      value: String(config[key]),
      saved: String(saved).trim(),
    });
  }
  return out;
}

function writeConfig(next) {
  const body = {};
  for (const key of KEYS) body[key] = next[key];
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(body, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// The GitLab token
// ---------------------------------------------------------------------------

// A GitLab token with `api` scope, so the tool can make a group and a project
// rather than making you click through both. It is an account credential, not a
// repository one, so it lives in your user config directory -- outside every
// repository, where no `git add .` can reach it. It is never sent to the page
// and never written into job output: the browser triggers actions, the server
// holds the secret.
const TOKEN_FILE = path.join(
  process.platform === 'win32'
    ? process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
  'relay-bridge',
  'token',
);

function loadToken() {
  try {
    return fs.readFileSync(TOKEN_FILE, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function saveToken(token) {
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(TOKEN_FILE, `${token}\n`, { mode: 0o600 });
}

async function gitlabApi(pathname, options = {}, token = loadToken()) {
  if (!token) throw new Error('No GitLab token saved yet.');
  const response = await fetch(`https://gitlab.com/api/v4${pathname}`, {
    ...options,
    headers: { 'PRIVATE-TOKEN': token, 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!response.ok) {
    const detail = body?.message || body?.error || text.slice(0, 200) || response.statusText;
    const plain = typeof detail === 'string' ? detail : JSON.stringify(detail);
    throw new Error(`GitLab ${response.status}: ${plain}`);
  }
  return body;
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

// One job at a time. The whole tool is a sequence of blocking steps, so a queue
// would only let the user start a publish while a test was still deciding
// whether the publish is a good idea.
let job = { running: false, name: null, output: '', code: null, startedAt: 0 };
// Whether the suite has passed since work last came down. Publishing without it
// is the mistake this exists to prevent, so it is tracked rather than trusted.
let tested = false;

function startJob(name, command, onDone) {
  if (job.running) return false;
  job = { running: true, name, output: `$ ${command}\n\n`, code: null, startedAt: Date.now() };
  const child = spawn(command, { cwd: ROOT, shell: true });
  const append = (chunk) => { job.output += chunk.toString(); };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  child.on('close', (code) => {
    job.running = false;
    job.code = code;
    job.output += `\n[finished, exit ${code}]\n`;
    // Anything that finished may have moved a remote, so the next read of state
    // should see the truth rather than whatever was cached before it ran.
    invalidate();
    if (onDone) onDone(code);
  });
  child.on('error', (error) => {
    job.running = false;
    job.code = 1;
    job.output += `\n[failed to start: ${error.message}]\n`;
  });
  return true;
}

// ---------------------------------------------------------------------------
// Reading git state
// ---------------------------------------------------------------------------

// Talking to the network is the expensive part of reading state, and the page
// polls so the job output stays live. Local refs are cheap to re-read; the fetch
// that updates them is not, so it runs on its own slower clock and after
// anything that could have moved a remote.
let lastFetch = 0;
const FETCH_EVERY_MS = 20_000;

function refreshRemotes(force = false) {
  if (!force && Date.now() - lastFetch < FETCH_EVERY_MS) return;
  lastFetch = Date.now();
  read('git fetch --all --prune --tags --quiet');
}

// execSync blocks the event loop, and reading state costs eight git processes.
// Without this the page's own polling queues against itself and a request that
// should be instant waits twenty seconds behind a backlog of identical ones.
let cached = null;
let cachedAt = 0;
const STATE_TTL_MS = 1200;

// The remote URL only changes when this tool changes it, so it is not worth a
// process on every read.
let workbenchUrl = null;

function invalidate() {
  lastFetch = 0;
  cachedAt = 0;
  workbenchUrl = null;
}

function gitState() {
  refreshRemotes();
  const { safeRemote: safe, workbenchRemote: bench, branch } = config;
  // One process for all three refs rather than three. `--short` keeps them in
  // argument order, and a missing ref would abort the batch, so each is asked
  // for with a fallback that survives a workbench that does not exist yet.
  const refs = (read(`git rev-parse --short ${branch} ${safe}/${branch} ${bench}/${branch}`) || '').split('\n');
  const shortRef = (ref, index) => refs[index] || read(`git rev-parse --short ${ref}`);
  const incoming = read(`git log --oneline HEAD..${bench}/${branch}`) || '';
  const outgoing = read(`git log --oneline ${safe}/${branch}..HEAD`) || '';
  const dirtyList = read('git status --porcelain') || '';
  if (workbenchUrl === null) workbenchUrl = read(`git remote get-url ${bench}`) || 'not set';
  return {
    local: shortRef(branch, 0),
    safe: shortRef(`${safe}/${branch}`, 1),
    workbench: shortRef(`${bench}/${branch}`, 2),
    url: workbenchUrl,
    subject: read('git log -1 --pretty=%s') || '',
    incoming: incoming ? incoming.split('\n') : [],
    outgoing: outgoing ? outgoing.split('\n') : [],
    dirty: dirtyList ? dirtyList.split('\n') : [],
  };
}

function state() {
  // While a job runs, git state cannot change but the output is what the page is
  // watching -- so serve the last snapshot and spend nothing on refiguring it.
  const fresh = !job.running && (!cached || Date.now() - cachedAt > STATE_TTL_MS);
  if (fresh) {
    cached = gitState();
    cachedAt = Date.now();
  }
  return {
    ...(cached ?? gitState()),
    tested,
    job: { running: job.running, name: job.name, output: job.output, code: job.code },
  };
}

// Pure builders, no side effects. The page prints these verbatim under each
// button, so the description of an action and the action itself come from one
// place -- the alternative is a caption that drifts from the deed it describes,
// on a screen whose whole job is being trusted with `git reset --hard`.
// `git remote set-url` fails outright when the remote does not exist yet, and
// on a first run it usually does not: the normal starting point is a repo with
// only a GitHub remote and no workbench at all. Pick the verb that fits.
function wireRemote(remote, url) {
  const verb = read(`git remote get-url ${remote}`) === null ? 'add' : 'set-url';
  return `git remote ${verb} ${remote} "${url.replace(/"/g, '')}"`;
}

const COMMANDS = {
  get: () => {
    const target = `${config.workbenchRemote}/${config.branch}`;
    return `git diff --stat HEAD ${target} && git merge --ff-only ${target}`;
  },
  test: () => config.testCommand,
  run: () => config.runCommand,
  publish: () => `git push ${config.safeRemote} ${config.branch} --tags`
    + ` && git push ${config.workbenchRemote} ${config.branch} --tags`,
  discard: () => `git reset --hard ${config.safeRemote}/${config.branch}`,
};

// Fresh work and a thrown-away tree both mean the last green run no longer
// describes what is on disk.
const CLEARS_TEST = new Set(['get', 'discard']);

// When a step fails, git's own output is accurate but not kind. These add one
// plain line for the failures a user is most likely to hit, saying what happened
// and -- the part that matters -- that nothing was changed.
const HINTS = {
  get: () => 'The workbench and your laptop have both moved on, so they cannot be'
    + ' fast-forwarded together.\nNothing here was changed. Get merges with --ff-only'
    + ' on purpose, so it stops rather than\ninventing a merge you did not ask for.'
    + ` To combine them by hand:\n    git merge ${config.workbenchRemote}/${config.branch}`,
};

function commandTable() {
  const out = {};
  for (const name of Object.keys(COMMANDS)) out[name] = COMMANDS[name]();
  return out;
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

const PAGE_TEMPLATE = String.raw`<!doctype html>
<html lang="en" data-theme="light" data-accent="indigo"><head><meta charset="utf-8"><title>Relay Bridge</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#f6f8fc">
<link id="favicon" rel="icon" type="image/png">
<style>
/* Tokens, surfaces and accents are the Relay dashboard's, carried over verbatim
   so the two tools read as one family. The contrast arithmetic behind these
   values lives in that project's stylesheet; the short version is that every
   type token clears WCAG AA 4.5:1 on every surface it can land on, in both
   themes, and the -text pair exists because the vivid hues do not. Move a value
   here only with that arithmetic in hand. */
:root{
  color-scheme:light;
  --bg:#f6f8fc; --surface:#ffffff; --surface-soft:#f8faff; --surface-strong:#eef3fb;
  /* A terminal block stays dark in both themes, so --ink is declared once and
     deliberately not overridden below. */
  --ink:#0d1420;
  --text:#111827; --text-soft:#334155; --muted:#515c6c; --quiet:#666e7b;
  --line:#e4e9f2; --line-strong:#d7deea;
  --orange:#f0490f; --orange-strong:#a83409; --orange-soft:#ffeee6;
  --blue:#377cf4; --blue-strong:#2563eb; --blue-soft:#eaf2ff;
  --violet:#7357e8; --violet-soft:#f0edff;
  --green:#28b889; --green-soft:#e8f8f2;
  --amber:#ee9a24; --amber-soft:#fff4e3;
  --red:#eb4b5c; --red-soft:#fff0f2;
  --orange-text:#c43e0c; --blue-text:#0e61f2; --violet-text:#6d50e7;
  --green-text:#1b7b5c; --amber-text:#9b5f0c; --red-text:#d7182c;
  --on-accent:#ffffff;
  --accent:var(--blue); --accent-strong:var(--blue-strong);
  --accent-soft:var(--blue-soft); --accent-text:var(--blue-text);
  --accent-2:var(--violet); --accent-2-soft:var(--violet-soft); --accent-2-text:var(--violet-text);
  --focus-ring:var(--accent-text);
  --shadow:0 7px 21px rgba(34,55,88,.055);
  --shadow-raised:0 16px 41px rgba(24,40,72,.12);
  --radius:7px;
  --font:Inter,"Segoe UI Variable","Segoe UI",Arial,sans-serif;
  --mono:"Cascadia Mono","SFMono-Regular",Consolas,monospace;
}
:root[data-theme="dark"]{
  color-scheme:dark;
  --bg:#17171a; --surface:#232327; --surface-soft:#1d1d20; --surface-strong:#2d2d32;
  --text:#ececed; --text-soft:#c8c9cd; --muted:#adaeb6; --quiet:#96979f;
  --line:#34343a; --line-strong:#434349;
  --orange:#d65b39; --orange-strong:#e57a5d; --orange-soft:#1e1a1b;
  --blue:#7499e8; --blue-strong:#8aa9ec; --blue-soft:#152541;
  --violet:#a292e5; --violet-soft:#241e46;
  --green:#49c59b; --green-soft:#102d26;
  --amber:#e3a854; --amber-soft:#332613;
  --red:#e87f89; --red-soft:#351a21;
  --orange-text:#e57a5d; --blue-text:#7499e8; --violet-text:#a292e5;
  --green-text:#49c59b; --amber-text:#e3a854; --red-text:#e87f89;
  --on-accent:#0d1420;
  --shadow:0 9px 27px rgba(0,0,0,.26);
  --shadow-raised:0 20px 50px rgba(0,0,0,.46);
}
/* Every declaration in an accent block is an alias, never a literal, so one
   block covers both themes -- var() resolves where it is used. Dark wears
   terracotta, light wears indigo, and setTheme() writes both attributes. */
[data-accent="terracotta"]{
  --accent:var(--orange); --accent-strong:var(--orange-strong);
  --accent-soft:var(--orange-soft); --accent-text:var(--orange-text);
  --accent-2:var(--amber); --accent-2-soft:var(--orange-soft); --accent-2-text:var(--amber-text);
}
[data-accent="indigo"]{
  --accent:var(--blue); --accent-strong:var(--blue-strong);
  --accent-soft:var(--blue-soft); --accent-text:var(--blue-text);
  --accent-2:var(--violet); --accent-2-soft:var(--violet-soft); --accent-2-text:var(--violet-text);
}

*{box-sizing:border-box}
[hidden]{display:none!important}
html{min-width:288px;background:var(--bg)}
body{margin:0;background:var(--bg);color:var(--text);
  font-family:var(--font);font-size:13px;line-height:1.45}
button,input,select,textarea{font:inherit}
button{color:inherit}
a{color:var(--accent-text)}
a:focus-visible,button:focus-visible,summary:focus-visible,input:focus-visible,
select:focus-visible,[tabindex]:focus-visible{outline:3px solid var(--focus-ring);outline-offset:2px}
::selection{background:color-mix(in srgb,var(--accent) 28%,transparent);color:var(--text)}
*{scrollbar-width:thin;scrollbar-color:var(--line-strong) transparent}
::-webkit-scrollbar{width:9px;height:9px}
::-webkit-scrollbar-thumb{border:3px solid transparent;border-radius:9px;
  background:var(--line-strong);background-clip:padding-box}
.sr-only{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;
  margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;
  white-space:nowrap!important;border:0!important}

.icon-sprite{position:absolute;width:0;height:0;overflow:hidden}
.icon{width:16px;height:16px;display:inline-block;flex:0 0 auto;fill:none;stroke:currentColor;
  stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;vertical-align:-3px}
.icon.sm{width:13px;height:13px}
.icon.lg{width:20px;height:20px}

.topbar{position:sticky;top:0;z-index:30;height:63px;display:flex;align-items:center;
  justify-content:space-between;gap:18px;padding:0 25px;
  border-bottom:1px solid color-mix(in srgb,var(--line) 72%,transparent);
  background:color-mix(in srgb,var(--bg) 92%,transparent);backdrop-filter:blur(14px)}
.breadcrumb{display:flex;align-items:center;gap:8px;color:var(--quiet);font-size:12px;min-width:0}
.breadcrumb b{color:var(--text);font-weight:700}
/* The mark ships in both identities, because the theme picks one: terracotta on
   dark, the blue/violet gradient on light. Two <img> swapped by data-theme, so
   the glyph agrees with the page rather than with the OS. */
.brand-mark{display:inline-flex;align-items:center;flex:0 0 auto}
.brand-mark img{display:block;width:auto;height:23px}
.brand-mark .on-dark{display:none}
:root[data-theme="dark"] .brand-mark .on-dark{display:block}
:root[data-theme="dark"] .brand-mark .on-light{display:none}
.top-actions{display:flex;align-items:center;gap:9px;flex:0 0 auto}
.running-state{display:inline-flex;align-items:center;gap:7px;color:var(--muted);
  font-size:11px;white-space:nowrap}

.status-dot{width:7px;height:7px;display:inline-block;flex:0 0 auto;border-radius:50%;background:var(--quiet)}
.status-dot.healthy{background:var(--green-text)}
.status-dot.warning{background:var(--amber-text)}
.status-dot.bad{background:var(--red-text)}
.status-dot.busy{background:var(--accent-text)}

.button,.icon-button{height:36px;display:inline-flex;align-items:center;justify-content:center;gap:7px;
  padding:0 13px;border:1px solid var(--line-strong);border-radius:7px;background:var(--surface);
  color:var(--text-soft);font-weight:650;cursor:pointer;white-space:nowrap;
  transition:background .16s ease,border-color .16s ease,color .16s ease,box-shadow .16s ease,opacity .16s ease}
.button:hover:not(:disabled),.icon-button:hover:not(:disabled){
  border-color:color-mix(in srgb,var(--accent) 35%,var(--line-strong));
  background:var(--surface-strong);color:var(--text)}
.button:active:not(:disabled),.icon-button:active:not(:disabled){background:var(--accent-soft)}
.button:disabled,.icon-button:disabled{opacity:.48;cursor:not-allowed}
.button.primary{border-color:var(--accent-text);background:var(--accent-text);color:var(--on-accent);
  box-shadow:0 6px 16px color-mix(in srgb,var(--accent-text) 24%,transparent)}
.button.primary:hover:not(:disabled){border-color:var(--accent-strong);background:var(--accent-strong)}
.button.danger{border-color:color-mix(in srgb,var(--red) 35%,var(--line));color:var(--red-text)}
.button.danger:hover:not(:disabled){background:var(--red-soft);border-color:var(--red)}
.button.compact{height:31px;padding:0 10px;font-size:12px}
.icon-button{width:36px;padding:0}
.icon-button.compact{width:31px;height:31px;border-radius:6px}
.icon-button.borderless{border-color:transparent;background:transparent}
.text-link{display:inline-flex;align-items:center;gap:5px;padding:0;border:0;background:none;
  color:var(--accent-text);font-size:12px;font-weight:700;cursor:pointer}
.text-link:hover{text-decoration:underline;text-underline-offset:3px}

.main{width:100%;max-width:1000px;margin:0 auto;padding:23px 25px 40px}
.page-head{display:flex;align-items:flex-end;justify-content:space-between;gap:21px;margin-bottom:20px}
.page-head h2{margin:0;color:var(--text);font-size:25px;line-height:1.15;font-weight:750;letter-spacing:-.015em}
.page-head p{max-width:640px;margin:7px 0 0;color:var(--muted);font-size:12px}
.page-actions{display:flex;align-items:center;gap:9px;flex-wrap:wrap;justify-content:flex-end}

.system-strip{display:flex;align-items:center;gap:18px;flex-wrap:wrap;margin:-4px 0 16px}
.system-pill{height:34px;display:inline-flex;align-items:center;gap:8px;padding:0 12px;
  border:1px solid var(--line);border-radius:7px;background:var(--surface);font-size:12px;font-weight:650}
.system-pill.warn{border-color:color-mix(in srgb,var(--amber) 45%,var(--line));background:var(--amber-soft);color:var(--amber-text)}
.system-pill.ok{border-color:color-mix(in srgb,var(--green) 45%,var(--line));background:var(--green-soft);color:var(--green-text)}
.endpoint-inline{display:flex;align-items:center;gap:9px;min-width:0;color:var(--quiet);font-size:12px}
.endpoint-inline code{color:var(--text);font:12px var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

.panel{border:1px solid var(--line);border-radius:var(--radius);background:var(--surface);
  box-shadow:var(--shadow);margin-bottom:13px}
.panel-head{min-height:48px;display:flex;align-items:center;justify-content:space-between;gap:13px;
  padding:11px 14px;border-bottom:1px solid var(--line)}
.panel-head h3{display:flex;align-items:center;gap:8px;margin:0;font-size:13px;font-weight:750}
.panel-head .sub{margin:3px 0 0;color:var(--muted);font-size:11px;font-weight:400}
.panel-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;
  padding:11px 14px;border-top:1px solid var(--line)}
.panel-note{margin:0;color:var(--quiet);font-size:11px}
.eyebrow-label{display:block;font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--quiet)}
.badge{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px;border-radius:5px;
  font-size:10px;font-weight:750;text-transform:uppercase;letter-spacing:.06em;
  background:var(--surface-strong);color:var(--muted)}
.badge.good{background:var(--green-soft);color:var(--green-text)}
.badge.bad{background:var(--red-soft);color:var(--red-text)}
.badge.busy{background:var(--accent-soft);color:var(--accent-text)}

/* The pipeline is the one screen element that is not a generic dashboard part.
   Work only ever moves workbench -> laptop -> safe, so the three places are laid
   out in that order with the pending count sitting in the gap it has to cross.
   A card trio would say the same thing and make the reader infer the direction. */
.pipeline{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr) auto minmax(0,1fr)}
.node{min-width:0;padding:15px}
.node-icon{width:28px;height:28px;display:grid;place-items:center;margin-bottom:11px;
  border-radius:6px;background:var(--surface-strong);color:var(--muted)}
.node.is-bench .node-icon{background:var(--accent-soft);color:var(--accent-text)}
.node.is-local .node-icon{background:var(--accent-2-soft);color:var(--accent-2-text)}
.node.is-safe .node-icon{background:var(--green-soft);color:var(--green-text)}
.node-sha{display:block;margin:6px 0 0;color:var(--text);font:20px/1.05 var(--mono);
  font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.node-sha.is-missing{color:var(--quiet);font-size:14px}
.node-note{margin:5px 0 0;color:var(--muted);font-size:11px;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap}
.flow{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;
  min-width:86px;padding:0 6px;border-left:1px solid var(--line);border-right:1px solid var(--line)}
.flow .icon{color:var(--line-strong);transition:color .16s ease}
.flow-count{font:12px var(--mono);font-variant-numeric:tabular-nums;color:var(--quiet)}
.flow-label{color:var(--quiet);font-size:10px;text-transform:uppercase;letter-spacing:.06em;text-align:center}
.flow.is-live .icon{color:var(--accent-text)}
.flow.is-live .flow-count{color:var(--accent-text);font-weight:700}
.flow.is-live .flow-label{color:var(--accent-text)}

/* Each step prints the command it will run. A screen trusted with a hard reset
   should not ask to be taken on faith, and the string comes from the
   same builder the server executes rather than a caption kept in step with it. */
.steps{margin:0;padding:0;list-style:none}
.steps>li{display:flex;align-items:center;gap:13px;padding:12px 14px}
.steps>li+li{border-top:1px solid var(--line)}
.step-n{width:23px;height:23px;display:grid;place-items:center;flex:0 0 auto;border-radius:50%;
  background:var(--accent-soft);color:var(--accent-text);font:11px var(--mono);font-weight:700}
.steps>li.is-off .step-n{background:var(--surface-strong);color:var(--quiet)}
.step-body{flex:1;min-width:0}
.step-body b{display:block;font-size:12.5px}
.step-body code{display:block;margin-top:2px;color:var(--quiet);font:11px var(--mono);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.step-body .warn-note{display:block;margin-top:2px;color:var(--amber-text);font-size:11px}
.steps>li>.button{flex:0 0 auto;min-width:138px}

.change-group{padding:12px 14px}
.change-group+.change-group{border-top:1px solid var(--line)}
.change-group ul{margin:7px 0 0;padding-left:18px}
.change-group li{color:var(--muted);font:11.5px var(--mono);margin:2px 0;word-break:break-word}

.field{display:grid;grid-template-columns:176px minmax(0,1fr);gap:3px 14px;align-items:center;padding:11px 14px}
.field+.field{border-top:1px solid var(--line)}
.field label{font-size:12.5px;font-weight:650}
.field input{width:100%;height:34px;padding:0 11px;border:1px solid var(--line-strong);border-radius:7px;
  background:var(--surface-soft);color:var(--text);font:12px var(--mono)}
.field input:focus{outline:2px solid var(--focus-ring);outline-offset:1px;border-color:transparent}
.field .why{grid-column:2;margin:1px 0 0;color:var(--quiet);font-size:11px}
.field.is-shadowed .why{color:var(--amber-text)}

.row{display:flex;gap:9px;align-items:center;flex-wrap:wrap}
.row input,.row select{flex:1;min-width:0;height:36px;padding:0 11px;border:1px solid var(--line-strong);
  border-radius:7px;background:var(--surface-soft);color:var(--text);font:12px var(--mono)}
.row select{font-family:var(--font);font-size:13px}
.row input:focus,.row select:focus{outline:2px solid var(--focus-ring);outline-offset:1px;border-color:transparent}
.stack{display:flex;flex-direction:column;gap:11px}
.hint{margin:0;color:var(--quiet);font-size:11.5px}
.hint code{color:var(--text-soft);font:11px var(--mono)}

.disclosure{padding:0}
.disclosure>summary{display:flex;align-items:center;gap:8px;min-height:48px;padding:11px 14px;
  cursor:pointer;font-size:13px;font-weight:750;list-style:none}
.disclosure>summary::-webkit-details-marker{display:none}
.disclosure>summary::after{content:"";flex:0 0 auto;margin-left:auto;width:7px;height:7px;
  border-right:1.8px solid var(--quiet);border-bottom:1.8px solid var(--quiet);
  transform:rotate(-45deg);transition:transform .18s ease}
.disclosure[open]>summary::after{transform:rotate(45deg)}
.disclosure[open]>summary{border-bottom:1px solid var(--line)}
.disclosure-body{padding:14px}

.first-use-callout{display:flex;align-items:center;gap:12px;margin:-4px 0 14px;padding:13px 14px;
  border:1px solid color-mix(in srgb,var(--accent) 28%,var(--line));border-radius:var(--radius);
  background:var(--accent-soft)}
.first-use-callout-icon{width:29px;height:29px;display:grid;place-items:center;flex:0 0 auto;
  border-radius:6px;background:var(--surface);color:var(--accent-text)}
.first-use-callout b{font-size:12px}
.first-use-callout p{margin:3px 0 0;color:var(--muted);font-size:11px}

.gl-row{display:flex;align-items:center;gap:9px;padding:8px 11px;border:1px solid var(--line);
  border-radius:7px;background:var(--surface-soft);margin-bottom:6px}
.gl-row .who{flex:1;min-width:0}
.gl-row .name{font:12px var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gl-row .when{margin-top:2px;color:var(--quiet);font-size:10.5px}
.gl-head{margin:13px 0 6px;color:var(--quiet);font-size:10px;text-transform:uppercase;letter-spacing:.07em}
.gl-head:first-child{margin-top:0}

pre.term{margin:0;padding:13px 14px;background:var(--ink);color:#d9e6ff;overflow:auto;
  max-height:340px;border-radius:0 0 var(--radius) var(--radius)}
pre.term code{font:11px/1.7 var(--mono);white-space:pre-wrap;word-break:break-word}

.toast{position:fixed;right:18px;bottom:18px;z-index:100;max-width:340px;display:flex;
  align-items:flex-start;gap:8px;padding:11px 13px;border:1px solid var(--line-strong);
  border-radius:7px;background:var(--surface);box-shadow:var(--shadow-raised);opacity:0;
  transform:translateY(9px);pointer-events:none;font-size:12px;
  transition:opacity .18s ease,transform .18s ease}
.toast.show{opacity:1;transform:none}
.toast.good{border-color:color-mix(in srgb,var(--green) 50%,var(--line))}
.toast.good .icon{color:var(--green-text)}
.toast.warn{border-color:color-mix(in srgb,var(--amber) 50%,var(--line))}
.toast.warn .icon{color:var(--amber-text)}
.toast.bad{border-color:color-mix(in srgb,var(--red) 50%,var(--line))}
.toast.bad .icon{color:var(--red-text)}
.toast span{white-space:pre-wrap}

/* A theme flip repoints every token at once. Without this, the .16s transition
   on buttons, pills and flow arrows runs on all of them together and the whole
   page visibly washes from one palette to the other. setTheme() holds this
   attribute for two frames -- long enough for the new values to paint. */
:root[data-switching] *{transition:none!important}

@media(max-width:760px){
  .topbar{padding:0 16px}
  .main{padding:18px 16px 34px}
  .page-head{flex-direction:column;align-items:flex-start;gap:13px}
  .page-actions{justify-content:flex-start}
  /* Stacked, the arrows have to turn with the layout or they point across the
     flow instead of along it. */
  .pipeline{grid-template-columns:minmax(0,1fr)}
  .flow{min-width:0;padding:7px 14px;flex-direction:row;gap:9px;justify-content:flex-start;
    border-left:0;border-right:0;border-top:1px solid var(--line);border-bottom:1px solid var(--line);
    background:var(--surface-soft)}
  .flow .icon{transform:rotate(90deg)}
  .node{padding:13px 14px}
  .steps>li{flex-wrap:wrap}
  .steps>li>.button{width:100%;margin-left:36px}
  .field{grid-template-columns:minmax(0,1fr);gap:5px}
  .field .why{grid-column:1}
}
@media(prefers-reduced-motion:reduce){
  *{transition-duration:0s!important}
}
</style></head><body>
<svg class="icon-sprite" aria-hidden="true">
  <symbol id="i-wrench" viewBox="0 0 24 24"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></symbol>
  <symbol id="i-laptop" viewBox="0 0 24 24"><path d="M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16"/></symbol>
  <symbol id="i-shield-check" viewBox="0 0 24 24"><path d="M20 13c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V5l8-3 8 3z"/><path d="m9 12 2 2 4-4"/></symbol>
  <symbol id="i-arrow-right" viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></symbol>
  <symbol id="i-download" viewBox="0 0 24 24"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></symbol>
  <symbol id="i-upload" viewBox="0 0 24 24"><path d="M12 21V9M7 12l5-5 5 5M5 3h14"/></symbol>
  <symbol id="i-circle-check" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m8 12 2.5 2.5L16 9"/></symbol>
  <symbol id="i-check-circle" viewBox="0 0 24 24"><path d="M22 11.1V12a10 10 0 1 1-5.9-9.1"/><path d="m9 11 3 3L22 4"/></symbol>
  <symbol id="i-play" viewBox="0 0 24 24"><path d="m7 4 13 8-13 8z"/></symbol>
  <symbol id="i-rotate-ccw" viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></symbol>
  <symbol id="i-route" viewBox="0 0 24 24"><circle cx="6" cy="19" r="3"/><path d="M9 19h3a5 5 0 0 0 5-5V5"/><path d="m14 8 3-3 3 3"/><circle cx="6" cy="5" r="3"/><path d="M9 5h3"/></symbol>
  <symbol id="i-sliders" viewBox="0 0 24 24"><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/></symbol>
  <symbol id="i-terminal" viewBox="0 0 24 24"><path d="m4 17 6-5-6-5"/><path d="M12 19h8"/></symbol>
  <symbol id="i-plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></symbol>
  <symbol id="i-trash-2" viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M19 6l-1 15H6L5 6M10 11v5M14 11v5"/></symbol>
  <symbol id="i-refresh-cw" viewBox="0 0 24 24"><path d="M20 6v5h-5"/><path d="M4 18v-5h5"/><path d="M5.8 9a7 7 0 0 1 11.7-2.6L20 9M4 15l2.5 2.6A7 7 0 0 0 18.2 15"/></symbol>
  <symbol id="i-alert-triangle" viewBox="0 0 24 24"><path d="M10.3 3.7 2.5 18a2 2 0 0 0 1.8 3h15.4a2 2 0 0 0 1.8-3L13.7 3.7a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/></symbol>
  <symbol id="i-clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></symbol>
  <symbol id="i-external-link" viewBox="0 0 24 24"><path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></symbol>
  <symbol id="i-key" viewBox="0 0 24 24"><circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 8.8-8.8M17 5l3 3M14 8l3 3"/></symbol>
  <symbol id="i-sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.42"/></symbol>
  <symbol id="i-moon" viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z"/></symbol>
  <symbol id="i-git-branch" viewBox="0 0 24 24"><path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></symbol>
  <symbol id="i-layers" viewBox="0 0 24 24"><path d="m12 2 9 5-9 5-9-5z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/></symbol>
</svg>

<header class="topbar">
  <div class="breadcrumb">
    <span class="brand-mark"><img class="on-light" src="data:image/png;base64,__MARK_LIGHT__" alt="" aria-hidden="true"><img class="on-dark" src="data:image/png;base64,__MARK_DARK__" alt="" aria-hidden="true"></span>
    <span>Relay Bridge</span><span>/</span><b id="crumb">Overview</b>
  </div>
  <div class="top-actions">
    <span class="running-state"><i id="live-dot" class="status-dot"></i><span id="live-copy">Loading</span></span>
    <button id="theme-toggle" class="icon-button" type="button" aria-label="Switch theme" title="Switch theme"></button>
  </div>
</header>

<main class="main">

<section id="setup" hidden>
  <div class="page-head">
    <div><h2>Set up Relay Bridge</h2>
    <p>One remote is permanent, the other is disposable. Tell it which is which and how to run your suite.</p></div>
  </div>
  <div class="first-use-callout">
    <div class="first-use-callout-icon"><svg class="icon" aria-hidden="true"><use href="#i-git-branch"></use></svg></div>
    <div><b>Detected from this repository</b>
    <p>Correct anything wrong. Saved to <code>relay-bridge.config.json</code>, changeable later under Settings.</p></div>
  </div>
  <section class="panel">
    <header class="panel-head"><h3><svg class="icon" aria-hidden="true"><use href="#i-sliders"></use></svg>Configuration</h3></header>
    <div id="setup-fields"></div>
    <footer class="panel-foot">
      <p class="panel-note">No secrets go in this file.</p>
      <button id="b-setup" class="button primary" type="button"><svg class="icon sm" aria-hidden="true"><use href="#i-circle-check"></use></svg>Save and continue</button>
    </footer>
  </section>
</section>

<section id="app" hidden>
  <div class="page-head">
    <div><h2>Overview</h2>
    <p>GitHub is the safe. GitLab is the workbench. Nothing reaches the safe until the suite passes.</p></div>
    <div class="page-actions">
      <button id="b-refresh" class="button compact" type="button"><svg class="icon sm" aria-hidden="true"><use href="#i-refresh-cw"></use></svg>Refresh</button>
    </div>
  </div>

  <div class="system-strip">
    <span id="sync-pill" class="system-pill"><i id="sync-dot" class="status-dot"></i><span id="sync-copy">checking</span></span>
    <span class="endpoint-inline">Workbench <code id="bench-url">—</code></span>
  </div>

  <section class="panel">
    <div class="pipeline">
      <article class="node is-bench">
        <div class="node-icon"><svg class="icon" aria-hidden="true"><use href="#i-wrench"></use></svg></div>
        <span class="eyebrow-label">GitLab · workbench</span>
        <b class="node-sha" id="h-workbench">—</b>
        <p class="node-note" id="n-workbench">disposable</p>
      </article>
      <div class="flow" id="flow-in">
        <span class="flow-count" id="c-in">0</span>
        <svg class="icon" aria-hidden="true"><use href="#i-arrow-right"></use></svg>
        <span class="flow-label" id="l-in">to get</span>
      </div>
      <article class="node is-local">
        <div class="node-icon"><svg class="icon" aria-hidden="true"><use href="#i-laptop"></use></svg></div>
        <span class="eyebrow-label" id="lab-local">Laptop</span>
        <b class="node-sha" id="h-local">—</b>
        <p class="node-note" id="n-local"></p>
      </article>
      <div class="flow" id="flow-out">
        <span class="flow-count" id="c-out">0</span>
        <svg class="icon" aria-hidden="true"><use href="#i-arrow-right"></use></svg>
        <span class="flow-label" id="l-out">to publish</span>
      </div>
      <article class="node is-safe">
        <div class="node-icon"><svg class="icon" aria-hidden="true"><use href="#i-shield-check"></use></svg></div>
        <span class="eyebrow-label">GitHub · the safe</span>
        <b class="node-sha" id="h-safe">—</b>
        <p class="node-note" id="n-safe">permanent</p>
      </article>
    </div>
  </section>

  <section class="panel" id="changes" hidden>
    <header class="panel-head"><h3><svg class="icon" aria-hidden="true"><use href="#i-layers"></use></svg>Pending</h3></header>
    <div id="changes-body"></div>
  </section>

  <section class="panel">
    <header class="panel-head">
      <h3><svg class="icon" aria-hidden="true"><use href="#i-route"></use></svg>Workflow</h3>
      <span id="gate-badge" class="badge">not tested</span>
    </header>
    <ol class="steps">
      <li id="s-get"><span class="step-n">1</span>
        <div class="step-body"><b>Get work from the workbench</b><code id="cmd-get">—</code></div>
        <button id="b-get" class="button" type="button"><svg class="icon sm" aria-hidden="true"><use href="#i-download"></use></svg>Get work</button></li>
      <li id="s-test"><span class="step-n">2</span>
        <div class="step-body"><b>Run the suite</b><code id="cmd-test">—</code></div>
        <button id="b-test" class="button" type="button"><svg class="icon sm" aria-hidden="true"><use href="#i-circle-check"></use></svg>Test it</button></li>
      <li id="s-run"><span class="step-n">3</span>
        <div class="step-body"><b>See it running</b><code id="cmd-run">—</code></div>
        <button id="b-run" class="button" type="button"><svg class="icon sm" aria-hidden="true"><use href="#i-play"></use></svg>See it running</button></li>
      <li id="s-publish"><span class="step-n">4</span>
        <div class="step-body"><b>Publish to the safe</b><code id="cmd-publish">—</code><span class="warn-note" id="gate-note" hidden></span></div>
        <button id="b-publish" class="button primary" type="button"><svg class="icon sm" aria-hidden="true"><use href="#i-upload"></use></svg>Publish</button></li>
    </ol>
    <footer class="panel-foot">
      <div><b style="font-size:12.5px">Throw the work away</b><code style="display:block;margin-top:2px;color:var(--quiet);font:11px var(--mono)" id="cmd-discard">—</code></div>
      <button id="b-discard" class="button danger" type="button"><svg class="icon sm" aria-hidden="true"><use href="#i-rotate-ccw"></use></svg>Throw away</button>
    </footer>
  </section>

  <section class="panel" id="out-panel" hidden>
    <header class="panel-head">
      <h3><svg class="icon" aria-hidden="true"><use href="#i-terminal"></use></svg><span id="out-title">Output</span></h3>
      <span id="out-badge" class="badge"></span>
    </header>
    <pre class="term"><code id="out"></code></pre>
  </section>

  <details class="panel disclosure" id="d-move">
    <summary><svg class="icon" aria-hidden="true"><use href="#i-plus"></use></svg>New workbench, for when credits run out</summary>
    <div class="disclosure-body stack">
      <div id="need-token" class="stack" hidden>
        <p class="hint">Paste a GitLab token with <b>api</b> scope once and this can make the group and the project for you. <a href="https://gitlab.com/-/user_settings/personal_access_tokens" target="_blank" rel="noreferrer">Make one here <svg class="icon sm" aria-hidden="true"><use href="#i-external-link"></use></svg></a>. Stored outside this repository, at <code id="token-path">your user config directory</code>, and it never leaves this machine.</p>
        <div class="row">
          <input id="token" type="password" placeholder="glpat-..." spellcheck="false" aria-label="GitLab token">
          <button id="b-token" class="button" type="button"><svg class="icon sm" aria-hidden="true"><use href="#i-key"></use></svg>Save token</button>
        </div>
      </div>
      <div id="have-token" class="stack" hidden>
        <p class="hint">Signed in as <b id="gl-user">—</b>. Pick a group you already have, or name a new one.</p>
        <div class="row">
          <select id="group" aria-label="Existing group"><option value="">— existing group —</option></select>
          <button id="b-move-existing" class="button" type="button">Move here</button>
        </div>
        <div class="row">
          <input id="new-group" placeholder="new group name" spellcheck="false" aria-label="New group name">
          <button id="b-move-new" class="button primary" type="button"><svg class="icon sm" aria-hidden="true"><use href="#i-plus"></use></svg>Create and move</button>
        </div>
        <p class="hint">Creates the group and a private <b id="np-name">project</b>, pushes to the safe first so nothing can be lost, then points the workbench at it. Starting the Ultimate trial on the new group is the one step GitLab has no API for, so it hands you the link.</p>
      </div>
      <div id="moved" hidden>
        <p class="hint">Moved to <a id="moved-web" href="#" target="_blank" rel="noreferrer">the new project</a>. <b>Now start the trial:</b> <a id="moved-trial" href="#" target="_blank" rel="noreferrer">open the trial page <svg class="icon sm" aria-hidden="true"><use href="#i-external-link"></use></svg></a></p>
      </div>
      <div id="gl-list-wrap" hidden>
        <div class="panel-head" style="padding:0 0 9px;border:0;border-bottom:1px solid var(--line);min-height:0">
          <h3 style="font-size:12px">Your GitLab</h3>
          <button id="gl-refresh" class="text-link" type="button"><svg class="icon sm" aria-hidden="true"><use href="#i-refresh-cw"></use></svg>Refresh</button>
        </div>
        <div id="gl-list" style="margin-top:11px"></div>
      </div>
      <details>
        <summary style="cursor:pointer;font-size:11.5px;color:var(--muted)">or point it at a URL by hand</summary>
        <div class="row" style="margin-top:9px">
          <input id="new-url" placeholder="https://gitlab.com/GROUP/PROJECT.git" spellcheck="false" aria-label="Workbench URL">
          <button id="b-relocate" class="button" type="button">Move</button>
        </div>
      </details>
    </div>
  </details>

  <details class="panel disclosure" id="d-settings">
    <summary><svg class="icon" aria-hidden="true"><use href="#i-sliders"></use></svg>Settings</summary>
    <div id="settings-fields"></div>
    <footer class="panel-foot">
      <p class="panel-note">Written to <code>relay-bridge.config.json</code>. No secrets in it — commit it if your team shares the workflow, or gitignore it if this setup is only yours.</p>
      <button id="b-settings" class="button primary" type="button">Save</button>
    </footer>
  </details>
</section>

</main>
<div id="toast" class="toast" role="status" aria-live="polite"></div>
<script>
var busy=false,setupFilled=false,settingsFilled=false,toastTimer=null;
// The tab icon follows the theme too, so it agrees with the page rather than
// with whatever the OS happens to be wearing. Held here rather than in the
// <link> so the two variants are not also duplicated in the markup.
var FAVICON_DARK='__FAVICON_DARK__',FAVICON_LIGHT='__FAVICON_LIGHT__';
function el(id){return document.getElementById(id)}
function esc(t){return String(t==null?'':t).replace(/[<&>"]/g,function(c){
  return c==='<'?'&lt;':c==='>'?'&gt;':c==='&'?'&amp;':'&quot;'})}
function icon(name,cls){return '<svg class="icon'+(cls?' '+cls:'')+'" aria-hidden="true"><use href="#i-'+name+'"></use></svg>'}

/* Errors used to arrive as alert(), which blocks the poll loop and cannot show
   two things at once. A toast is also the only way a background job's failure
   can reach the reader without stealing the keyboard. */
function toast(message,tone){
  var box=el('toast');clearTimeout(toastTimer);
  box.className='toast show '+(tone||'');
  box.innerHTML=icon(tone==='bad'?'alert-triangle':tone==='warn'?'clock':'check-circle')+'<span>'+esc(message)+'</span>';
  toastTimer=setTimeout(function(){box.className='toast'},tone==='bad'?6000:3400);
}

/* First load follows the device. After that the toggle wins, because choosing a
   theme by hand is a preference and the OS flipping at sunset is not a reason to
   overrule it. Dark wears terracotta, light wears indigo. */
function setTheme(theme,persist){
  var root=document.documentElement;
  root.setAttribute('data-switching','');
  root.setAttribute('data-theme',theme);
  root.setAttribute('data-accent',theme==='dark'?'terracotta':'indigo');
  if(persist!==false)localStorage.setItem('relay-bridge-theme',theme);
  var meta=document.querySelector('meta[name="theme-color"]');
  if(meta)meta.setAttribute('content',theme==='dark'?'#17171a':'#f6f8fc');
  var fav=el('favicon');
  if(fav)fav.href='data:image/png;base64,'+(theme==='dark'?FAVICON_DARK:FAVICON_LIGHT);
  var button=el('theme-toggle');
  button.innerHTML=icon(theme==='dark'?'sun':'moon');
  var next=theme==='dark'?'light':'dark';
  button.setAttribute('aria-label','Switch to '+next+' mode');
  button.setAttribute('title','Switch to '+next+' mode');
  button.setAttribute('aria-pressed',theme==='dark'?'true':'false');
  // Two frames is the right moment to let transitions back in, but rAF is
  // suspended outright in a background tab -- and setTheme() runs on first load,
  // which is exactly when a tab may not be looking. Without the timer the
  // attribute would stick and kill every transition in the UI for good.
  var release=function(){root.removeAttribute('data-switching')};
  requestAnimationFrame(function(){requestAnimationFrame(release)});
  setTimeout(release,120);
}
function currentTheme(){return document.documentElement.getAttribute('data-theme')}
el('theme-toggle').onclick=function(){setTheme(currentTheme()==='dark'?'light':'dark')};
(function(){
  var saved=localStorage.getItem('relay-bridge-theme');
  var query=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)');
  setTheme(saved||(query&&query.matches?'dark':'light'),Boolean(saved));
  if(query&&query.addEventListener)query.addEventListener('change',function(e){
    if(!localStorage.getItem('relay-bridge-theme'))setTheme(e.matches?'dark':'light',false);
  });
})();

var FIELDS=[
  ['safeRemote','Safe remote','the git remote pointing at GitHub'],
  ['workbenchRemote','Workbench remote','the git remote pointing at GitLab'],
  ['branch','Branch','the branch this workflow moves around'],
  ['testCommand','Test command','has to pass before publishing is offered'],
  ['runCommand','Run command','what "See it running" starts'],
  ['projectName','New project name','default name for projects created on GitLab'],
  ['port','Port','takes effect the next time you start it']
];
function formHtml(p){
  return FIELDS.map(function(f){
    return '<div class="field" id="'+p+'-'+f[0]+'-field"><label for="'+p+'-'+f[0]+'">'+esc(f[1])+'</label>'
      +'<input id="'+p+'-'+f[0]+'" spellcheck="false" autocomplete="off">'
      +'<p class="why" id="'+p+'-'+f[0]+'-why">'+esc(f[2])+'</p></div>';
  }).join('');
}
function fillForm(p,c){FIELDS.forEach(function(f){el(p+'-'+f[0]).value=c[f[0]]==null?'':c[f[0]]})}
function readForm(p){var o={};FIELDS.forEach(function(f){o[f[0]]=el(p+'-'+f[0]).value.trim()});return o}
el('setup-fields').innerHTML=formHtml('s');
el('settings-fields').innerHTML=formHtml('g');

/* An environment variable outranks the config file, so a field it holds is
   showing a value that Save cannot change. Saying so on the field beats letting
   someone type, save, and watch it snap back with no explanation. */
function markShadowed(p,list){
  var held={};(list||[]).forEach(function(e){held[e.key]=e});
  FIELDS.forEach(function(f){
    var box=el(p+'-'+f[0]+'-field'),why=el(p+'-'+f[0]+'-why'),hit=held[f[0]];
    box.classList.toggle('is-shadowed',Boolean(hit));
    why.textContent=hit
      ?hit.variable+' is set in your environment, so this run uses "'+hit.value
        +'". Saving updates the file for next time.'
      :f[2];
  });
}
function shadowNote(list){
  if(list.length===1){
    return 'Saved to the file. But '+list[0].variable+' is set in your environment, so '
      +list[0].label+' stays "'+list[0].value+'" until you unset it.';
  }
  var names=list.map(function(e){return e.label});
  return 'Saved to the file. But your environment still sets '
    +names.slice(0,-1).join(', ')+' and '+names[names.length-1]+' for this run.';
}

function saveConfig(p,button){
  button.disabled=true;
  fetch('/api/config',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(readForm(p))})
    .then(function(r){return r.json()}).then(function(r){
      button.disabled=false;
      if(r.error){toast(r.error,'bad');return}
      setupFilled=false;settingsFilled=false;
      el('d-settings').open=false;
      var shadowed=r.shadowed||[];
      if(shadowed.length)toast(shadowNote(shadowed),'warn');
      else toast(r.restartRequired?'Saved. The new port takes effect next start.':'Settings saved',
        r.restartRequired?'warn':'good');
      refresh();
    }).catch(function(){button.disabled=false;toast('Could not reach Relay Bridge','bad')});
}
el('b-setup').onclick=function(){saveConfig('s',this)};
el('b-settings').onclick=function(){saveConfig('g',this)};
el('b-refresh').onclick=function(){refresh();toast('Refreshed')};

function setFlow(id,count,singular,plural){
  var box=el('flow-'+id),n=count.length;
  box.className='flow'+(n?' is-live':'');
  el('c-'+id).textContent=n;
  el('l-'+id).textContent=n===1?singular:plural;
}
function paint(s){
  busy=s.job.running;
  el('live-dot').className='status-dot '+(busy?'busy':s.configured?'healthy':'warning');
  el('live-copy').textContent=busy?'running':s.configured?'idle':'setup';
  if(s.tokenPath)el('token-path').textContent=s.tokenPath;

  var out=el('out');
  if(s.job.output){
    el('out-panel').hidden=false;
    el('out-title').textContent=s.job.name?'Output · '+s.job.name:'Output';
    var badge=el('out-badge');
    if(s.job.running){badge.className='badge busy';badge.textContent='running'}
    else if(s.job.code===0){badge.className='badge good';badge.textContent='exit 0'}
    else if(s.job.code==null){badge.className='badge';badge.textContent=''}
    else {badge.className='badge bad';badge.textContent='exit '+s.job.code}
    if(out.textContent!==s.job.output){out.textContent=s.job.output;out.parentNode.scrollTop=out.parentNode.scrollHeight}
  }

  if(!s.configured){
    el('setup').hidden=false;el('app').hidden=true;el('crumb').textContent='Setup';
    if(!setupFilled){setupFilled=true;fillForm('s',s.config)}
    markShadowed('s',s.shadowed);
    return;
  }
  el('setup').hidden=true;el('app').hidden=false;el('crumb').textContent='Overview';
  if(!settingsFilled){settingsFilled=true;fillForm('g',s.config)}
  markShadowed('g',s.shadowed);

  el('lab-local').textContent='Laptop · '+s.config.branch;
  el('h-local').textContent=s.local||'—';
  el('n-local').textContent=s.subject||'';
  el('h-safe').textContent=s.safe||'—';
  el('n-safe').textContent=s.config.safeRemote+' · permanent';
  var bench=el('h-workbench');
  bench.textContent=s.workbench||'not reachable';
  bench.className='node-sha'+(s.workbench?'':' is-missing');
  el('n-workbench').textContent=(s.url||'').replace(/^https:\/\//,'').replace(/\.git$/,'')||'not set';
  el('bench-url').textContent=(s.url||'—').replace(/^https:\/\//,'');
  el('np-name').textContent=s.config.projectName||'project';

  setFlow('in',s.incoming,'commit to get','commits to get');
  setFlow('out',s.outgoing,'commit to publish','commits to publish');

  var pill=el('sync-pill'),dot=el('sync-dot'),copy=el('sync-copy');
  var agree=s.local&&s.local===s.safe&&s.safe===s.workbench;
  if(busy){pill.className='system-pill';dot.className='status-dot busy';copy.textContent='running '+s.job.name}
  else if(s.dirty.length){pill.className='system-pill warn';dot.className='status-dot warning';
    copy.textContent=s.dirty.length+' uncommitted change'+(s.dirty.length===1?'':'s')+' on this laptop'}
  else if(s.incoming.length){pill.className='system-pill warn';dot.className='status-dot warning';
    copy.textContent='work waiting on the workbench'}
  else if(s.outgoing.length){pill.className='system-pill warn';dot.className='status-dot warning';
    copy.textContent='not on GitHub yet'}
  else if(agree){pill.className='system-pill ok';dot.className='status-dot healthy';copy.textContent='everything in sync'}
  else {pill.className='system-pill warn';dot.className='status-dot warning';copy.textContent='out of sync'}

  var groups='';
  groups+=changeGroup(s.incoming,'On the workbench, not taken yet');
  groups+=changeGroup(s.outgoing,'On this laptop, not on GitHub');
  groups+=changeGroup(s.dirty,'Uncommitted files');
  el('changes').hidden=!groups;
  if(groups&&el('changes-body').innerHTML!==groups)el('changes-body').innerHTML=groups;

  var cmd=s.commands||{};
  ['get','test','run','publish','discard'].forEach(function(k){
    el('cmd-'+k).textContent=cmd[k]||'nothing configured';
  });

  var gate=el('gate-badge');
  gate.className='badge '+(s.tested?'good':'');
  gate.textContent=s.tested?'suite passed':'not tested';
  el('gate-note').hidden=Boolean(s.tested);
  if(!s.tested)el('gate-note').textContent='The suite has not passed since the last change.';

  ['get','test','run','publish','discard','relocate','move-existing','move-new'].forEach(function(k){
    var b=el('b-'+k);if(b)b.disabled=busy;
  });
  /* A blank command would spawn an empty shell and read as a silent success, so
     the step says why it cannot run rather than pretending it did. */
  gateStep('test',cmd.test,'No test command configured — open Settings.');
  gateStep('run',cmd.run,'No run command configured — open Settings.');

  showToken(Boolean(s.hasToken));
  if(s.glUser)el('gl-user').textContent=s.glUser;
}
function gateStep(name,value,why){
  var button=el('b-'+name),row=el('s-'+name);
  row.className=value?'':'is-off';
  if(value){button.title='';return}
  button.disabled=true;button.title=why;
}
function changeGroup(list,label){
  if(!list.length)return '';
  return '<div class="change-group"><span class="eyebrow-label">'+list.length+' · '+esc(label)+'</span><ul>'
    +list.map(function(x){return '<li>'+esc(x)+'</li>'}).join('')+'</ul></div>';
}

/* Fast while something is running, because that is when the output pane is worth
   watching. Slow otherwise -- an idle repo does not change on its own, and every
   poll costs the server a handful of blocking git calls. */
var timer=null,rate=0;
function schedule(ms){if(rate===ms)return;rate=ms;clearInterval(timer);timer=setInterval(refresh,ms)}
function refresh(){
  return fetch('/api/state').then(function(r){return r.json()})
    .then(function(s){paint(s);schedule(s.job.running?900:4000)})
    .catch(function(){el('live-dot').className='status-dot bad';el('live-copy').textContent='no answer'});
}

function act(name,body){
  // Buttons are disabled while a job runs, but a click can still land in the gap
  // between starting one and the next paint. Swallowing it silently leaves a
  // button that looks live and does nothing.
  if(busy){toast('Something is already running','warn');return}
  busy=true;
  fetch('/api/action/'+name,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})})
    .then(function(r){return r.json()}).then(function(r){if(r.error)toast(r.error,'bad');refresh()})
    .catch(function(){busy=false;toast('Could not reach Relay Bridge','bad')});
}
el('b-get').onclick=function(){act('get')};
el('b-test').onclick=function(){act('test')};
el('b-run').onclick=function(){act('run')};
el('b-publish').onclick=function(){
  fetch('/api/state').then(function(r){return r.json()}).then(function(s){
    if(!s.tested&&!confirm('The suite has not passed since the last change.\n\nPublish to GitHub anyway?'))return;
    act('publish');
  });
};
el('b-discard').onclick=function(){
  fetch('/api/state').then(function(r){return r.json()}).then(function(s){
    var msg='This resets your laptop to whatever GitHub has.';
    /* Uncommitted work goes first because it is the half that cannot come back.
       A discarded commit is still in the reflog; an uncommitted edit has never
       existed anywhere else. */
    if(s.dirty.length)msg+='\n\n'+s.dirty.length+' uncommitted change'+(s.dirty.length===1?'':'s')
      +' will be lost for good - no commit, no remote, no copy:\n'+s.dirty.join('\n');
    if(s.outgoing.length)msg+='\n\n'+s.outgoing.length+' of your own commit(s) will be DESTROYED:\n'+s.outgoing.join('\n');
    if(!s.dirty.length&&!s.outgoing.length)msg+='\n\nNothing would be lost - this laptop already matches the safe.';
    if(confirm(msg))act('discard');
  });
};
el('b-relocate').onclick=function(){
  var url=el('new-url').value.trim();
  if(!url)return;
  if(!/^https:\/\/gitlab\.com\/.+\.git$/.test(url)
    &&!confirm('That does not look like https://gitlab.com/<group>/<project>.git\n\nUse it anyway?'))return;
  act('relocate',{url:url});
};

var groupsLoaded=false,listLoaded=false;
function showToken(has){
  el('need-token').hidden=has;el('have-token').hidden=!has;el('gl-list-wrap').hidden=!has;
  if(has&&!groupsLoaded){groupsLoaded=true;loadGroups()}
  if(has&&!listLoaded){listLoaded=true;loadList()}
}
function loadGroups(){
  fetch('/api/gitlab/groups').then(function(r){return r.json()}).then(function(list){
    if(list.error){el('gl-user').textContent='token rejected';groupsLoaded=false;toast(list.error,'bad');return}
    el('group').innerHTML='<option value="">'+String.fromCharCode(8212)+' existing group '+String.fromCharCode(8212)+'</option>'
      +list.map(function(g){return '<option value="'+esc(g.id)+'">'+esc(g.name)+'</option>'}).join('');
  });
}
el('b-token').onclick=function(){
  var t=el('token').value.trim();if(!t)return;
  var button=this;button.disabled=true;
  fetch('/api/gitlab/token',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:t})})
    .then(function(r){return r.json()}).then(function(r){
      button.disabled=false;
      if(r.error){toast(r.error,'bad');return}
      el('token').value='';el('gl-user').textContent=r.user;groupsLoaded=false;
      showToken(true);toast('Signed in as '+r.user,'good');refresh();
    }).catch(function(){button.disabled=false;toast('Could not reach Relay Bridge','bad')});
};
function move(payload){
  if(busy){toast('Something is already running','warn');return}
  busy=true;
  fetch('/api/gitlab/newproject',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)})
    .then(function(r){return r.json()}).then(function(r){
      busy=false;
      if(r.error){toast(r.error,'bad');return}
      el('moved').hidden=false;
      el('moved-web').href=r.web;el('moved-trial').href=r.trial;
      el('new-group').value='';
      toast('Workbench moved. Start the trial next.','good');
      refresh();
    }).catch(function(){busy=false;toast('Could not reach Relay Bridge','bad')});
}
el('b-move-existing').onclick=function(){
  var id=el('group').value;
  if(!id){toast('Pick a group first','warn');return}
  move({groupId:Number(id)});
};
el('b-move-new').onclick=function(){
  var name=el('new-group').value.trim();
  if(!name){toast('Name the new group first','warn');return}
  move({newGroupName:name});
};
function ago(iso){
  if(!iso)return '';
  var s=Math.floor((Date.now()-new Date(iso))/1000);
  if(s<3600)return Math.max(1,Math.floor(s/60))+'m ago';
  if(s<86400)return Math.floor(s/3600)+'h ago';
  return Math.floor(s/86400)+'d ago';
}
function loadList(){
  var wrap=el('gl-list');wrap.innerHTML='<p class="hint">loading…</p>';
  fetch('/api/gitlab/projects').then(function(r){return r.json()}).then(function(d){
    if(d.error){wrap.innerHTML='<p class="hint">'+esc(d.error)+'</p>';return}
    var html='';
    if(d.projects.length){
      html+='<div class="gl-head">Projects</div>';
      html+=d.projects.map(function(p){
        return '<div class="gl-row"><div class="who"><div class="name">'+esc(p.path)+'</div>'
          +'<div class="when">'+esc(ago(p.activity))+'</div></div>'
          +(p.current?'<span class="badge busy">workbench</span>':'')
          +'<button class="button compact danger" type="button" data-kind="project" data-id="'+esc(p.id)+'" data-name="'+esc(p.path)+'"'
          +(p.current?' data-current="1"':'')+'>'+icon('trash-2','sm')+'Delete</button></div>';
      }).join('');
    }
    if(d.groups.length){
      html+='<div class="gl-head">Groups</div>';
      html+=d.groups.map(function(g){
        return '<div class="gl-row"><div class="who"><div class="name">'+esc(g.path)+'</div>'
          +'<div class="when">'+esc(g.name)+'</div></div>'
          +'<button class="button compact danger" type="button" data-kind="group" data-id="'+esc(g.id)+'" data-name="'+esc(g.path)+'">'
          +icon('trash-2','sm')+'Delete</button></div>';
      }).join('');
    }
    wrap.innerHTML=html||'<p class="hint">nothing here</p>';
    Array.prototype.forEach.call(wrap.querySelectorAll('button[data-kind]'),function(b){
      b.onclick=function(){remove(b)};
    });
  });
}
function remove(b){
  var kind=b.dataset.kind,name=b.dataset.name;
  var msg='Delete the '+kind+' "'+name+'" on GitLab?';
  if(kind==='group')msg+='\n\nThis deletes every project inside it.';
  if(b.dataset.current)msg+='\n\nThis is your CURRENT workbench. Make sure GitHub has your work first (Publish), or it is gone.';
  if(!confirm(msg))return;
  if(prompt('Type the name to confirm:\n'+name)!==name){toast('Did not match. Nothing deleted.','warn');return}
  b.disabled=true;b.textContent='…';
  fetch('/api/gitlab/'+kind+'/'+b.dataset.id,{method:'DELETE'})
    .then(function(r){return r.json()}).then(function(r){
      if(r.error){toast(r.error,'bad');b.disabled=false;b.textContent='Delete';return}
      toast(r.note||('Deleted '+name),'good');
      loadList();groupsLoaded=false;loadGroups();refresh();
    });
}
el('gl-refresh').onclick=function(e){e.preventDefault();loadList()};

document.addEventListener('visibilitychange',function(){if(!document.hidden)refresh()});
refresh();schedule(4000);
</script></body></html>`;

// The brand assets, inlined so the tool stays one file you can copy anywhere.
// They are palette-quantised at the size they actually render -- the topbar mark
// at 3x its 44x23 box, the tab icon at 128px -- which is why four PNGs cost 16KB
// instead of the 3.2MB the 1024px originals weigh. Sources live in assets/.
const BRAND = {
  MARK_DARK: 'iVBORw0KGgoAAAANSUhEUgAAAKAAAABUCAMAAAAyEswQAAAACXBIWXMAAAAAAAAAAQCEeRdzAAADAFBMVEWIMh2ONiKTOCOcPCaoQSmyRiy7SjHDTTLHWDjMUTXRYkLSUDXaXz7cWjvdakvfVzviemLkVTnlYj/nWj7oXz7oknvpX0DqWz/qXUDtYkLuX0Dur6DwZkPwiG3xb0zxn4jyY0HygGLzbEjzuqj0aUT1aj71bEb1bkb1wrH2zb/3bkL3gVb3mHb3qYz32c/39/f4c0L4c0b4+Pj5d0b5d0j55Nz59fT59/f5+Pj5+fn6eEX67un7+/v9/v7+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+///+//8A/wAgsxBwAAABAHRSTlP///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////8AU/cHJQAADVFJREFUeJzFm/tvG8cRx7/7uNvjUaJeftWOZdkVggSRBCRAfsrf358KtIDdoi/XVVwnaezKepFH7t0+ipm9IylbsiWLcseWfKRE3oez89qZtYhYjOwhHg+qjYPVI4eV00H1fEHvq6//Fnsx5kNEgSJmR9ko09GKUzzWteqLp/9vwL3QqwCDJQCVgvYEKoQBIopqiMemDvv/L8Dt3uAIeVyt4QFr6ClP3wQID3A5NLyKj/Xx688P+LXWyyVWMQ41UwFWtRczkYHv4Pr3lj+Z8dMAd2OBErCkrIRlYCooD+X4oSAVahDgBNotu+yB9q8+F+DuYNBeRSLsRBEjLTCpUsy/tXbIUfv7+f5nANwuVjq8WrTqmxOvfHpyyl44pwELIc34vnt9w4DbxV0Axyv8IK+nz8faAN4m7c0Wub0FESLCShMex/2bBNy5y3CJr460kKQpa4SxBsor74kxCkQxJXROMyG9pGfD/fL5TQHuDqZwsDCASMZGl22YITfxkaJMBLtIchK6iyGXqk3tj568uBHAveUBq4/X13plhe/MLAqQBkE+LDxpLoopHrkImWCyh9orVd2783ThgF+vKyT1JRWqIIkvMiOvcmuAkXgQiXKCwmlSn3aGXYp1TOSvH/24YMBdjntTIRhHYKJ1VuLzkZVVS+1IexIFpHaVBRG7HLkiv8rrCAV799dFAn69Ppi6bifkCEgmyOKV8sppFwRcqPqiPq2dj4F0GeljVEJAQAqtC5XXEOuD/YUB7hb0fcZnQfoSUJ0Rdh6CQIQNMvXruOl+m7g4Pcco4EUjRlIURa83XjtcEOAOoZ3Vn+W4RiGvi8f0DKBilfku0vXqANHqmX+NvyJCjK4S2Yq5lCF+FHBPMVrnviSkPy26KBhrQ0+Qg7i6zJ9NXzkGejbI5EYiUlzkF9GfgPAm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',
  MARK_LIGHT: 'iVBORw0KGgoAAAANSUhEUgAAAKAAAABUCAMAAAAyEswQAAAACXBIWXMAAAAAAAAAAQCEeRdzAAADAFBMVEUDhPoDiPwFf/knh/08b+09LZ1AiP1EefpHMqVIi/1Jif1MlfZOM69UPb1bq/Vdfv1eRs1egv1ehP1fNb9ghP1mTtdqcftsOtNsSOJsV+tufPxvWetvd/xwVvVykfh0VfB1avt3P+N3efl4c/p7TfJ+YPp/TPWCZvuDbfqERvOITPeJVvmJv/aKpfePUPiPhvWUcfSlevOplvOtsO22xvW/qPTD2/jOvPXe1Pfm6Pn39/j4+Pj6+vr8/P3+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v4A/wDYHHdTAAABAHRSTlP///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////8AU/cHJQAADUNJREFUeJzFm/tz28YRx7+HwwFHEBRjO3EyaRolndpuVMuPytH0//+po1pR2rxcd/pImiaOFD8kPvC4O6CzeweKVChZlmh3JxNTBEl8uK/b3TuKFquRB62JMBpU9VoLSImdFX1ufPmPeHBw5WkNZMD06iH0ixRogJuQOsLu/xvwTvSdQvIUSVrZFAMjValLjQgQbVs0uBn1ot3/F+CDg2lUDXpAEwEV0ioFHIiv1K1oRUuccRHfElm888YBP90fO6g4HvVBHACID5L+KzVE59oWVtm6vp189kYB7/zXQSokddKf9L0Kk5qvOCijQRbubmBtbGOL2+pitr4I4PqTXiTRwtXJpM98TZTUiVehMqr0hJ6R4GKbVqmRd+VnbwBw8+hJHsu2JWW5ol/0ih4aJIB3QhindGBk6RlYfxMHXADxFQE3j35q41KXBCPJrr26R88TUMWECqVWCHyiRYHYomfiKnXEeDfefZ2AuY0iAbQ2TQUcJPtdvVZS7NZBg4pwQ5x4R+wZY1NLOpRO2rvpzusCzA2k695QphCkwgQoPZLXIEoJEHCIkliZIrYxXXQc5Rjf33stgMPSSfKj8C4NtE7WqJOEVFhqH8U+zZSaUL0UdAsJF9N7nQRU83u9u3LAzW/42wexukwF3a9XJ3WSHCUgPlYgM4THlH44jtMqVo2TDpKvxvbuX1YMmE+k/2yWKqcoIcKa/mQNMktVD3y29gHCzzU14IyqkDJh+Ihze+K5ADe/ahNHQZgEE7OXpaKFk6TCsgNP0xERlq7UpWmsca3tvAISsUjiJs884/gPn60MMJ9IGNaGI4NxVilTzUpyc4ZHXQ8GjqJ7iH920MzmX2WdAUZxGuOqgnLni5WXA25+BdFEfr0lG80I/crhSIWT/mRA4ZKOsml+LRjv+oiV578BI0q+XVVh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',
  FAVICON_DARK: 'iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAMAAAD04JH5AAAACXBIWXMAAAAAAAAAAQCEeRdzAAADAFBMVEUAAACJMh6SNyKXOyWhPSaoQSqwRCy3Ry2/TDLIUDPQUzbVXT3aVjndcVHgVDfktKflXD7naknpWT7qZUPsXkDscEzthmjuYkHuZULunYfvYkLweFfxYUDya0PzZkHzaULzakLzqZj0xLX1bkj1lHf1uab2bUD2flr2zcD3cUf39/f4cUb4cUb4ckX4d0r4jmf4qIz43NL49/f4+Pj5c0L5d0T5d0b59PL5+fn6e0n66uT7e0b7+vr9/fz+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v4A/wCpBtJJAAABAHRSTlP///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////8AU/cHJQAACeBJREFUeJztWltvG8cV/uays7ukTMpmJNWyXbcBZBt5CfXQFAj684s+pA9OgCJIYkBNWkexkkg2KZK7MzuX4syQlERLtkRLEdrysyySy9Web+bczy4LuF3IW5aPFQG5UgFWRnjLkCsCWKngliFXBLBSwS1DrghgpYJbhlwRwEoFtwz530tg96AtgFFPv74/Xhvs/ZYEnoR2NtT5HQTo9tiWr/ErfySkHO7/FgR2NhrWrbKO9mhc4RxkUccvbCMecVe+uFECOxt23WHdlxrwPHMAhIvynQDLHVBvtLMXN0Rgt23WuSQhcarCgaIWzkEZZSAsCxYBvOXGG7nau34CO1uZUY13gM6hcw1wD5LsDAxdyMbTvOcF6up+uXe9BPpqCwqG0aZDI6+450Bd0A6IeBDSBsYC9/BQwOBBvnd9BPpqDYABow91rpHWD0EbApcYONmAdENfAAUGj3+4JgK7GYmfy1e0/3ED4LLpKcQhWBYAm1RhUBSjXvnyGgg82ZQKIDtjqAsPpePhuE5BooVzDvAMAVZCgsPT6TW4qnrdvQ8l0O8iJyOL6y+i/nWiADSoRXonXAabAR41PDgKOhU1+GDr4IMI7GZKnf7sdY6Kkwt4+nEiOoH3FkcueB9CQGAAA+OMS8mL2v7u1QcQ6Gck3ihyt3hl5OT/MQp5mCJrHDQv2HCkm9nfMM8CGQMDY2KklHuPGuTFXz3pRuNLgSZaoE8BAJ7De4haQbeKWdxbmwCcJLO4BwCCha2EPN59vhSBfjdeBUbN5JMlINcgVwdMofW95tv5+SNAWRJO2zD9TySc/e7hyyUIfJblhnY/iU3gisIgrb8REMcP/rbwNwa5A4u6ijQCC4zBucN3mKI8//DupMtIPv2Ll0qHNaA9Mchw3M4X5dMJW4ekh7gDATxQtGAsDDrDqxHo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',
  FAVICON_LIGHT: 'iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAMAAAD04JH5AAAACXBIWXMAAAAAAAAAAQCEeRdzAAADAFBMVEUAAAADf/kFhfsLh/0dif09iP1ALp9GjPxLM6pRe/xTNrZThP1XQcFbh/xdR81fgP1hUdhiNsZiqPZndPxqO9FqR9pte/xuZ/NxTupxZ/txbPxzd/xzgPp2cfx2dPx3PeN4Wvh9Q+5/afuCSfSCTviEeeqFYvuJS/eKVvmPUPiRivGSuPaTnvSYavaeevWu0Pivk/W3sejAqvPOwfbQ4fng1vjp6/n19vn39/f49/n4+Pj4+Pn6+vr8/Pz+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v7+/v4A/wBRNhlUAAABAHRSTlP///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////8AU/cHJQAACYxJREFUeJztWglz28YV/rB4WCxBgqKGdWsnbSbylfiQPUr+/z+oqspunNoTK03SjupxZFGkCOJYLDpvFyQl6qakcNryk00SB/d9+659+0CvwmJBC5aPJQFamgBLJ1wwaEkASxMsGLQkgKUJFgxaEsDSBAsGLQlgaYIFg/57CXybG/QbWYiGlhCbvyWBb4oeRqRDwC+pxMd4P8Sa1C2tNn8DAuu9AcEPfCLArwoEaOgGAE0pPj0J/K1bJbD+S44YPlAESJXPp4qgCOxAmiBNMXgkoq1bIvD8Zw1JK4PQHSqUvgfS9qA51MwARgqkjxrB5s0T6Ja5IAExiC2D8cQ16UAThpOhjDBU5E/DrZsl0B0JCAgjAMdAVgFQ+paBnTvCoR1MGGGEV2WXpUCXE68hrRQgHgxiIM9hFQBwk4vQHGJYayAshP2QPW1s3gyBbi/UEHynFjADxAPEkLkzARtDk2YTOIYis3pC5WH44tUNEHj+1vMNhFOzxSAe8Bs7QemzAio7ynQkAXiVB4jLuAJdcF0VfuUZGGtoYUx9f8YMwAEJwLOvtQKQKzt/ywCjC5VA517t9o2w4wvD/w3/AwZACBQIUsXKLgKTIezBGGNgrKcKEVBEEhD66ZtrEFCFEDwZ3xihKZ/cGw+YQRmoNIIGKZX+vDf5EpMwyMUAIvRjha8bW3MS6PadKeEZNquWqeIQm3oBUuR+93V9++Of7Ju7w1HJTBL63Wxjay4C3X03kiNhBIwyLtEINgJKP6Xgzl8m97/D+g/M1H2L7+KjDEnUPM8R6KwL45GsP/FwR+IACDNQ2fjl+FdeA3EuSFsl2H9hxqbqnxePdNb0PTdz+8Lzh2Yr8PyZWBaW+uGfT35vsP6DJkNGsDOGmWMA7J7NgE49qwqvji6v5mApSHYvF2/lvbHtZ7WwmpJV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',
};

const PAGE = Object.entries(BRAND)
  .reduce((html, [key, data]) => html.replace(`__${key}__`, data), PAGE_TEMPLATE);

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

// Looked up once per run so the page can say who it is signed in as after a
// reload, not only in the moment the token was pasted.
let glUser = null;
function userOnce() {
  if (glUser || !loadToken()) return;
  glUser = 'checking';
  gitlabApi('/user').then((u) => { glUser = u.username; }).catch(() => { glUser = null; });
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      // Nothing this server accepts is large. A body that keeps growing is a
      // mistake or an attack, and either way it should not be buffered.
      if (body.length > 1e6) { body = ''; req.destroy(); resolve({}); }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); }
    });
  });
}

// This server hands out `git reset --hard` and GitLab project deletion, and it
// listens on a fixed, guessable port. Without these two checks any page open in
// the same browser could reach it -- by name, via DNS rebinding, or with a form
// post that never triggers a preflight.
function fromLocalhost(req, port, origins) {
  const host = (req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') return false;
  const origin = req.headers.origin;
  return !origin || origins.has(origin);
}

function serve(port) {
  const origins = new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `http://[::1]:${port}`,
  ]);

  return http.createServer(async (req, res) => {
    if (!fromLocalhost(req, port, origins)) {
      return send(res, 403, { error: 'Relay Bridge only answers requests from this machine.' });
    }
    const url = new URL(req.url, `http://127.0.0.1:${port}`);

    if (url.pathname === '/') return send(res, 200, PAGE, 'text/html; charset=utf-8');

    if (url.pathname === '/api/state') {
      userOnce();
      const common = {
        configured,
        config,
        shadowed: shadowedKeys(),
        tokenPath: TOKEN_FILE,
        hasToken: Boolean(loadToken()),
        glUser: glUser === 'checking' ? null : glUser,
        job: { running: job.running, name: job.name, output: job.output, code: job.code },
      };
      // Before setup there is nothing trustworthy to read state *with* -- the
      // remote names are still guesses -- so it does not spend eight git
      // processes and a network fetch proving that.
      if (!configured) return send(res, 200, common);
      return send(res, 200, { ...state(), ...common, commands: commandTable() });
    }

    if (url.pathname === '/api/config' && req.method === 'POST') {
      const input = await readBody(req);
      const next = normalize(input, { ...DEFAULTS, ...detect(), ...config });
      const problem = validate(next);
      if (problem) return send(res, 400, { error: problem });
      const restartRequired = next.port !== port;
      writeConfig(next);
      loadConfig();
      invalidate();
      cached = null;
      tested = false;
      return send(res, 200, { ok: true, config, shadowed: shadowedKeys(), restartRequired });
    }

    // Groups you can actually create a project in. Owner or maintainer only,
    // because anything less means the create call fails after you have picked it.
    if (url.pathname === '/api/gitlab/groups') {
      return gitlabApi('/groups?min_access_level=40&per_page=100&order_by=name&sort=asc')
        .then((groups) => send(res, 200, groups.map((g) => ({ id: g.id, name: g.full_name, path: g.full_path }))))
        .catch((error) => send(res, 400, { error: error.message }));
    }

    if (url.pathname === '/api/gitlab/token' && req.method === 'POST') {
      const token = String((await readBody(req)).token || '').trim();
      if (!token) return send(res, 400, { error: 'No token given.' });
      try {
        // Checked with the candidate token *before* it is written, so a rejected
        // paste leaves nothing behind for the next run to think it is signed in
        // with. And the scope is checked now rather than at the moment it is
        // needed: a read_api token lists groups perfectly well and then 403s on
        // the one call that matters, which is a confusing way to find out
        // twenty minutes later.
        const info = await gitlabApi('/personal_access_tokens/self', {}, token);
        const scopes = info?.scopes || [];
        if (!scopes.includes('api')) {
          return send(res, 400, {
            error: `That token has scope [${scopes.join(', ') || 'none'}] but creating a group and project needs "api".\n\n`
              + 'Make a new one with the api box ticked, then paste it again.',
          });
        }
        const user = await gitlabApi('/user', {}, token);
        saveToken(token);
        glUser = user.username;
        return send(res, 200, { ok: true, user: user.username });
      } catch (error) {
        return send(res, 400, { error: error.message });
      }
    }

    // The whole "credits ran out" dance in one call: make the group if asked, make
    // the project, point the workbench at it, push. The safe is pushed first
    // inside the job, so a failure anywhere here cannot cost you work.
    if (url.pathname === '/api/gitlab/newproject' && req.method === 'POST') {
      const input = await readBody(req);
      if (job.running) return send(res, 409, { error: 'Something is already running.' });
      const projectName = String(input.projectName || config.projectName || path.basename(ROOT)).trim();
      if (!projectName) return send(res, 400, { error: 'No project name. Set one under Settings.' });
      try {
        let namespaceId = input.groupId || null;
        let groupPath = null;
        if (input.newGroupName) {
          const name = String(input.newGroupName).trim();
          const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
          // Availability cannot be checked first: GitLab answers GET /groups/:path
          // with 404 both for "no such group" and "exists but is private to someone
          // else", so a name taken by a stranger looks free. The create call is the
          // only honest test, and its 403 is what a taken path looks like.
          let group;
          try {
            group = await gitlabApi('/groups', {
              method: 'POST',
              body: JSON.stringify({ name, path: slug, visibility: 'private' }),
            });
          } catch (error) {
            if (/403/.test(error.message)) {
              return send(res, 400, {
                error: `GitLab refused to create "${slug}".\n\n`
                  + 'Top-level group paths are global across all of gitlab.com, not per account, '
                  + 'so ordinary words are long gone and GitLab reports that as a bare 403.\n\n'
                  + `Try something unlikely to collide, like "yourname-${slug}".`,
              });
            }
            throw error;
          }
          namespaceId = group.id;
          groupPath = group.full_path;
        }
        if (!namespaceId) return send(res, 400, { error: 'Pick a group or name a new one.' });
        const project = await gitlabApi('/projects', {
          method: 'POST',
          body: JSON.stringify({
            name: projectName,
            path: projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
            namespace_id: namespaceId,
            visibility: 'private',
            initialize_with_readme: false,
          }),
        });
        const { safeRemote: safe, workbenchRemote: bench, branch } = config;
        workbenchUrl = null;
        startJob('move to new project',
          `git push ${safe} ${branch} --tags`
          + ` && ${wireRemote(bench, project.http_url_to_repo)}`
          + ` && git push ${bench} --all && git push ${bench} --tags`);
        return send(res, 200, {
          ok: true,
          url: project.http_url_to_repo,
          web: project.web_url,
          // Starting an Ultimate trial is not an API call, so this is where you
          // finish the job by hand. It is the only manual step left.
          trial: `https://gitlab.com/-/trials/new?namespace_id=${namespaceId}`,
          group: groupPath,
        });
      } catch (error) {
        return send(res, 400, { error: error.message });
      }
    }

    // Everything you own on GitLab, newest activity first, with the current
    // workbench marked so you cannot delete it by accident.
    if (url.pathname === '/api/gitlab/projects') {
      const current = (read(`git remote get-url ${config.workbenchRemote}`) || '').replace(/\.git$/, '');
      return Promise.all([
        gitlabApi('/projects?membership=true&min_access_level=40&per_page=100&order_by=last_activity_at&sort=desc'),
        gitlabApi('/groups?min_access_level=40&per_page=100&order_by=name&sort=asc'),
      ])
        .then(([projects, groups]) => send(res, 200, {
          projects: projects.map((p) => ({
            id: p.id,
            path: p.path_with_namespace,
            web: p.web_url,
            activity: p.last_activity_at,
            current: p.http_url_to_repo.replace(/\.git$/, '') === current,
          })),
          groups: groups.map((g) => ({ id: g.id, name: g.full_name, path: g.full_path })),
        }))
        .catch((error) => send(res, 400, { error: error.message }));
    }

    // Deleting is the point of the list -- an expired group is dead weight -- but
    // GitLab may only mark it for deletion rather than remove it, so whatever it
    // says about that is passed straight back rather than assumed.
    const del = url.pathname.match(/^\/api\/gitlab\/(project|group)\/(\d+)$/);
    if (del && req.method === 'DELETE') {
      const [, kind, id] = del;
      return gitlabApi(`/${kind}s/${id}`, { method: 'DELETE' })
        .then((body) => {
          if (kind === 'project') workbenchUrl = null;
          send(res, 200, { ok: true, note: body?.message || null });
        })
        .catch((error) => send(res, 400, { error: error.message }));
    }

    if (url.pathname.startsWith('/api/action/') && req.method === 'POST') {
      const name = url.pathname.slice('/api/action/'.length);
      const input = await readBody(req);
      if (job.running) return send(res, 409, { error: 'Something is already running.' });
      if (!configured) return send(res, 400, { error: 'Not set up yet. Finish setup first.' });

      if (name === 'relocate') {
        const target = String(input.url || '').trim();
        if (!target) return send(res, 400, { error: 'No URL given.' });
        const { safeRemote: safe, workbenchRemote: bench, branch } = config;
        // The safe first: if the push to the new workbench fails, the work is
        // already safe, which is the whole point of the ordering.
        workbenchUrl = null;
        startJob('relocate',
          `git push ${safe} ${branch} --tags`
          + ` && ${wireRemote(bench, target)}`
          + ` && git push ${bench} --all && git push ${bench} --tags`);
        return send(res, 200, { ok: true });
      }

      const build = COMMANDS[name];
      if (!build) return send(res, 404, { error: `Unknown action: ${name}` });
      const command = build();
      if (!command) {
        return send(res, 400, {
          error: `No ${name} command is configured, so there is nothing to run.\n\n`
            + 'Open Settings and set one.',
        });
      }
      if (CLEARS_TEST.has(name)) tested = false;
      startJob(name, command, (code) => {
        if (name === 'test') tested = code === 0;
        if (code !== 0 && HINTS[name]) job.output += `\n${HINTS[name]()}\n`;
      });
      return send(res, 200, { ok: true });
    }

    return send(res, 404, { error: 'not found' });
  });
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

const HELP = `Relay Bridge ${VERSION}

  A local dashboard for a GitHub-as-safe / GitLab-as-disposable-workbench
  git workflow. Run it from inside the repository you want to manage.

Usage
  relay-bridge [options]

Options
  --port <n>      Port to listen on (default 4317, or the configured one)
  --no-open       Do not open a browser
  -v, --version   Print the version
  -h, --help      Print this

Configuration
  Written to relay-bridge.config.json in the current repository on first run.
  Every key can be overridden for one run with an environment variable:
  RELAY_BRIDGE_SAFE_REMOTE, RELAY_BRIDGE_WORKBENCH_REMOTE, RELAY_BRIDGE_BRANCH,
  RELAY_BRIDGE_TEST_COMMAND, RELAY_BRIDGE_RUN_COMMAND, RELAY_BRIDGE_PROJECT_NAME,
  RELAY_BRIDGE_PORT, RELAY_BRIDGE_NO_OPEN.

  Your GitLab token lives outside the repository, at
  ${TOKEN_FILE}
`;

function parseArgs(argv) {
  const out = { open: process.env.RELAY_BRIDGE_NO_OPEN !== '1', port: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') { console.log(HELP); process.exit(0); }
    else if (arg === '-v' || arg === '--version') { console.log(VERSION); process.exit(0); }
    else if (arg === '--no-open') out.open = false;
    else if (arg === '--port') { out.port = Number(argv[i + 1]); i += 1; }
    else if (arg.startsWith('--port=')) out.port = Number(arg.slice('--port='.length));
    else {
      console.error(`relay-bridge: unknown option "${arg}"\n\nTry --help.`);
      process.exit(1);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (!read('git rev-parse --git-dir')) {
  console.error('relay-bridge: this is not a git repository.\n'
    + '\nRun it from inside the repository you want to manage.');
  process.exit(1);
}

loadConfig();

const problem = validate(config);
if (problem) {
  console.error(`relay-bridge: ${problem}\n\nFix ${CONFIG_FILE} (or the RELAY_BRIDGE_* environment) and start again.`);
  process.exit(1);
}

const PORT = args.port || config.port;
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`relay-bridge: "${args.port}" is not a usable port.`);
  process.exit(1);
}

const server = serve(PORT);

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`relay-bridge: port ${PORT} is already in use.\n`
      + '\nEither another copy is already running, or something else has the port.'
      + '\nTry: relay-bridge --port ' + (PORT + 1));
    process.exit(1);
  }
  throw error;
});

// Bind to the IPv4 loopback specifically: that is the security boundary, and
// it is unreachable from any other machine. The address shown and opened is
// `localhost`, which is friendlier and which browsers resolve to this server
// (falling back from ::1 to 127.0.0.1 when the host prefers IPv6).
server.listen(PORT, '127.0.0.1', () => {
  const address = `http://localhost:${PORT}/`;
  const line = (label, value) => `  ${label.padEnd(11)}${value}`;
  console.log(`\n  Relay Bridge ${VERSION}\n  ${address}\n`);
  if (configured) {
    console.log(line('safe', `${config.safeRemote}  (GitHub)`));
    console.log(line('workbench', `${config.workbenchRemote}  (GitLab)`));
    console.log(line('branch', config.branch));
    console.log(line('token', loadToken() ? TOKEN_FILE : `${TOKEN_FILE}  (none saved yet)`));
  } else {
    console.log('  First run — finish setup in the browser.');
  }
  console.log('\n  Ctrl+C to stop.\n');

  if (!args.open) return;
  const open = process.platform === 'win32' ? `start "" "${address}"`
    : process.platform === 'darwin' ? `open "${address}"` : `xdg-open "${address}"`;
  try { execSync(open, { stdio: 'ignore' }); } catch { /* the URL is printed above */ }
});
