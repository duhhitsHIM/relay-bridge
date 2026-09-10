<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/duhhitsHIM/relay-bridge/main/assets/relay-bridge-lockup-dark.png">
    <img src="https://raw.githubusercontent.com/duhhitsHIM/relay-bridge/main/assets/relay-bridge-lockup-light.png" alt="Relay Bridge" width="430">
  </picture>
</p>

<p align="center">
  A local dashboard for a git workflow where one remote is <b>permanent</b><br>
  and the other is <b>disposable</b>. One file, zero dependencies, plain Node.
</p>

```bash
npx relay-bridge
```

Run it from inside your repository. It opens `http://localhost:4317/`.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/duhhitsHIM/relay-bridge/main/assets/screenshot-dark.png">
    <img src="https://raw.githubusercontent.com/duhhitsHIM/relay-bridge/main/assets/screenshot-light.png" alt="The Relay Bridge dashboard: a pipeline from GitLab through the laptop to GitHub, a Workflow panel where every step prints the command it runs, and the output of a passing test suite." width="830">
  </picture>
</p>

---

## The problem it solves

If you have ever handed a repository to something that can only reach *one* remote — a CI sandbox, a
hosted agent, a trial account that expires in a fortnight — you have had this thought: *if that
remote disappears, what exactly do I lose?*

Relay Bridge answers it by never letting the answer be "anything". It splits three places into three
jobs:

| | | |
|---|---|---|
| **GitHub** | the safe | Permanent. Holds every commit. Never moves. |
| **GitLab** | the workbench | Disposable. Where the work happens. Swapped for a fresh project when the trial runs out. |
| **Your laptop** | the bridge | Carries work between them, and is the only place tests actually run. |

The one rule the whole tool exists to enforce:

> **Nothing reaches the safe until the suite has passed.**

Getting work down from the workbench and publishing it to the safe are deliberately **two separate
buttons**. Collapsing them into one is the mistake this prevents. Whether the suite has passed since
work last came down is tracked by the server, not trusted to your memory — and if you try to publish
without it, you get a confirmation dialog that says so.

## What you get

The three places are drawn as a pipeline, in the direction work actually travels, with the pending
count sitting in the gap it has to cross:

```
  GitLab · workbench        2         Laptop · main         0        GitHub · the safe
      91fc99d          ──────────▶      c5d16b1        ──────────▶       c5d16b1
                    commits to get                 commits to publish
```

An arrow lights up when something is waiting to move across it. Three cards would say the same thing
and leave you to infer the direction.

Then the workflow, in the order you actually use it. **Each step prints the exact command it will
run** — a screen trusted with a hard reset shouldn't ask to be taken on faith, and the string comes
from the same builder the server executes, so the caption can't drift from the deed:

| | Step | What it runs |
|---|---|---|
| 1 | **Get work** | `git diff --stat HEAD <workbench>/<branch> && git merge --ff-only <workbench>/<branch>` |
| 2 | **Test it** | your configured test command |
| 3 | **See it running** | your configured run command |
| 4 | **Publish** | `git push <safe> <branch> --tags && git push <workbench> <branch> --tags` |
| — | **Throw away** | `git reset --hard <safe>/<branch>` |

A badge on the panel reads `suite passed` or `not tested`, and step 4 carries a warning line
whenever the gate is open. Fast-forward only, on purpose: if the workbench and your laptop have
diverged, the merge fails loudly rather than inventing a merge commit while you are not looking.
**Throw away** counts the commits it is about to destroy and lists them in the confirmation.

Job output streams into a terminal panel below, tagged with the exit code. Errors arrive as toasts
rather than `alert()`, so a failure never steals the keyboard or stalls the poll loop.

The interface follows your system light/dark preference until you touch the toggle, after which your
choice sticks — the OS flipping at sunset isn't a reason to overrule a deliberate decision. It
carries the same tokens, spacing and components as the Relay dashboard, so the two read as one
family: dark wears terracotta, light wears indigo.

Below that, two things for the day the credits run out:

**New workbench.** Creates a GitLab group and a private project through the API, pushes to the safe
*first* so nothing can be lost if the rest fails, repoints the workbench remote, pushes everything
up, then hands you the trial link. Starting the trial is the single step GitLab has no API for.

**Your GitLab.** Lists every project and group you own, sorted by recent activity, and deletes any of
them — behind a type-the-name confirmation. Your current workbench is tagged so you cannot nuke it by
reflex.

## Requirements

- **Node 18 or newer** (it uses the built-in `fetch`)
- **git** on your `PATH`
- A repository with two remotes: one you trust, one you don't

## Setup

There is no config to write by hand. On first run the dashboard shows a setup card with values
detected from your repository, and you correct whatever is wrong:

| Key | Detected from |
|---|---|
| `safeRemote` | the remote whose URL contains `github.com` |
| `workbenchRemote` | the remote whose URL contains `gitlab.` |
| `branch` | `git symbolic-ref --short HEAD` |
| `testCommand` | `scripts.test` in `package.json`, or `test/run-tests.js` if it exists |
| `runCommand` | `scripts.dev`, `scripts.start` or `scripts.restart` |
| `projectName` | the repository folder name — the default for projects created on GitLab |
| `port` | `4317` |

Saving writes `relay-bridge.config.json` in the repository. Change anything later under
**Settings**.

Decide what to do with that file straight away, because until you do, the dashboard will honestly
report it as an uncommitted change and the banner will nag at you about it. There are no secrets in
it, so either **commit it** if your team shares the workflow, or add it to your `.gitignore` if the
setup is only yours.

Nothing is detected as a *test command* if `package.json` still has the `npm init` placeholder that
only exits 1 — gating publication behind a command that can never pass is worse than no gate at all.
Leave `testCommand` empty and the Test button stays disabled and says why.

### Overriding for one run

Every key has an environment variable, and the environment beats the config file:

```bash
RELAY_BRIDGE_BRANCH=release RELAY_BRIDGE_PORT=5000 npx relay-bridge
```

`RELAY_BRIDGE_SAFE_REMOTE`, `RELAY_BRIDGE_WORKBENCH_REMOTE`, `RELAY_BRIDGE_BRANCH`,
`RELAY_BRIDGE_TEST_COMMAND`, `RELAY_BRIDGE_RUN_COMMAND`, `RELAY_BRIDGE_PROJECT_NAME`,
`RELAY_BRIDGE_PORT`, `RELAY_BRIDGE_NO_OPEN`.

Because the environment wins, a variable you set in a shell weeks ago can quietly outrank a setting
you save today. So the dashboard says which one is doing it: a field held by the environment is
marked in **Settings** with the variable's name, and saving over it tells you the file was written
but this run keeps the old value.

### Flags

```
--port <n>      Port to listen on
--no-open       Do not open a browser
-v, --version   Print the version
-h, --help      Print help
```

## Security

**The GitLab token lives outside your repository.** It is an account credential, not a project one,
so it is stored at `~/.config/relay-bridge/token` (`%APPDATA%\relay-bridge\token` on Windows) with
the directory at `0700` and the file at `0600`. No `git add .` can reach it. It is never sent to the
page and never written into job output — the browser triggers actions, the server holds the secret.

**On Windows, `0600` is advisory.** File permissions there are governed by ACLs, so the mode this
tool sets does not constrain access the way it does on Linux or macOS. If that matters to you, set
the ACL on `%APPDATA%\relay-bridge` yourself.

**The token is checked before it is saved.** A paste with the wrong scope is rejected and nothing is
written, so the next run cannot believe it is signed in with a credential that will 403 on the one
call that matters. It needs the **`api`** scope; `read_api` lists your groups perfectly well and then
fails at project creation.

**The server only answers this machine.** It binds `127.0.0.1`, and it rejects any request whose
`Host` header is not localhost or whose `Origin` is cross-site. Without that, a page open in the same
browser could reach a fixed, guessable port that hands out `git reset --hard` and project deletion.

**It runs the shell commands you configure.** That is the entire point of `testCommand` and
`runCommand`, and they are passed to a shell without quoting or inspection. Remote names and the
branch *are* validated, because they are interpolated into git commands. Treat
`relay-bridge.config.json` as executable: don't accept one from someone else without reading it.

**Never commit a GitLab token.** If you have committed one, rotating it is the only fix — deleting
the commit is not, because the value is already in every clone and in GitHub's or GitLab's event
history.

## Scope, plainly

This is **gitlab.com-specific**, and deliberately so. The group and project creation calls are the
GitLab v4 API, and the whole New Workbench flow exists to spin up a fresh **Ultimate trial** when the
last one expires — a concept a self-managed instance does not have. There is no config key for a
custom GitLab host because it would open a door that leads nowhere.

**GitHub is only ever a git remote.** No GitHub API, no token, no OAuth app. If your "safe" is
actually Codeberg or a bare repo on a machine you own, everything except the two GitLab panels works
exactly the same — set `safeRemote` and go. Only the card labels will lie to you.

## Known limitations

- **GitLab cannot tell you whether a group name is free.** `GET /groups/<path>` answers 404 both for
  "nothing there" and "someone else's private group", so a name taken by a stranger looks available.
  The create call is the only honest test, and a taken top-level path comes back as a bare `403`.
  The tool attempts it and explains that 403 rather than pretending it could have known.
  Top-level paths are global across all of gitlab.com, so ordinary words are long gone — prefix
  with something of your own.
- **One job at a time.** There is no queue, by design: a queue would let you start a publish while
  the test that decides whether publishing is a good idea is still running.
- **`git fetch` is on a 20-second clock.** The dashboard polls so job output stays live, but network
  refreshes run on their own slower schedule. State can be up to 20 seconds stale unless something
  just finished, which forces a refresh.

## Development

```bash
npm run lint   # node --check relay-bridge.mjs
```

There is no build, no bundler, no dependency tree, and no framework. It is one `.mjs` file — the
extension matters, because it means a copy dropped into a repository that isn't ESM still runs. The
stylesheet is inline and hand-written, the icons are an inline SVG sprite, and the brand mark and tab
icon are base64 PNGs embedded in the source — palette-quantised at the size they actually render, so
all four variants cost about 16 KB rather than the 3.2 MB the originals weigh. Nothing is fetched
from a CDN, so the dashboard is fully functional with no network at all.

Full-resolution artwork lives in [`assets/`](assets), and [`BRAND-BRIEF.md`](BRAND-BRIEF.md) records
why the identity looks the way it does.

## License

MIT — see [LICENSE](LICENSE).
