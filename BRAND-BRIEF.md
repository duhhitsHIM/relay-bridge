# Relay Bridge — brand brief

Everything a designer or design-AI needs to create a logo and identity that reads as a
sibling to **Relay**, not a stranger.

---

## 1. What Relay Bridge is

A **single-file desktop tool with a local web dashboard** that manages a git workflow
split across two hosts.

The problem it solves: an AI coding agent can only reach a **GitLab** project, but that
project runs on trial credits and dies. The user's real, permanent home for the code is
a private **GitHub** repo. So work has to keep crossing between two places that never
talk to each other, and the temporary side keeps getting replaced.

Relay Bridge is the thing standing between them. It:

- Shows three states at a glance — **laptop**, **GitHub**, **GitLab** — and says in one
  sentence what is out of step.
- Moves work in one direction at a time, in deliberate stages:
  **Get** (pull the agent's work down) → **Test** (run the suite) →
  **Publish** (push to the permanent side). Getting and publishing are separate on
  purpose.
- **Throws work away** — resets the laptop back to the safe copy when the agent's work
  fails its tests.
- **Builds a new workbench** when credits run out: creates a fresh remote project,
  pushes the safe side first so nothing can be lost, then re-points at the new one.
- Lists and deletes the disposable projects as they pile up.

### The one idea underneath all of it

**One side is permanent and one side is disposable.**

- **GitHub is the safe.** Never moves, never expires, holds everything.
- **GitLab is the workbench.** Where the messy work happens. Thrown away and rebuilt.
- **The laptop is the crossing.** Nothing gets from the workbench to the safe without
  passing through it and being tested.

Nothing reaches the safe until it has earned it. That is the emotional core of the
product: **a guarded crossing, not a pipe.** Traffic does not flow freely; it is
checked, and it can be turned back.

### Tone

Calm, deliberate, load-bearing. A bridge is infrastructure — you trust it, you do not
think about it. It should not feel like a sync utility or a dashboard toy. It should
feel like something with a weight rating.

---

## 2. The parent brand: Relay

**Relay** is an API proxy and load balancer. It sits in front of several AI providers
and routes each request to whichever one is healthy, failing over automatically when one
breaks. Same family of idea: *something in the middle, moving traffic, keeping it alive.*

The two names should read as one family:

| | |
|---|---|
| **Relay** | routes **requests** across providers |
| **Relay Bridge** | routes **commits** across remotes |

### Relay's existing visual identity — match this

**Mark:** an abstract, geometric **"R"** — flat, no gradient on dark; a blue-to-violet
gradient on light. Square canvas, currently 128×128, drawn as a solid glyph with
generous internal negative space. It has to survive being rendered at **34px** in a
collapsed sidebar and **16px** as a browser tab icon.

**Lockup:** mark + "Relay" wordmark, horizontal, 612×210, rendered ~139px wide. The
mark-to-wordmark gap is deliberately wide, because a narrow sidebar clips the lockup to
a 52px window and the mark must survive alone in it.

**Dark theme** (the primary, most-used surface):

```
background        #17171a   soft charcoal, deliberately NOT black
panel             #232327
raised panel      #2d2d32
hairline          #34343a
text              #ececed   deliberately NOT pure white
secondary text    #adaeb6
quiet text        #96979f
ACCENT            #d65b39   terracotta
accent as text    #e57a5d
accent tint       #1e1a1b   near-neutral, 13% saturation
second accent     #e3a854   amber
```

**Light theme:**

```
background        #f6f8fc
ACCENT            #377cf4   indigo
second accent     #7357e8   violet
accent tint       #eaf2ff
```

**Typography:** system sans for prose (`-apple-system, Segoe UI, Roboto`), monospace for
every number, hash, and identifier. Uppercase micro-labels with wide letter-spacing
(~0.07em) for section headers. Tight, dense, 10% below typical dashboard scale.

### The design principles Relay was built on — inherit these

These were arrived at deliberately, after a version that was too loud got rejected:

1. **The field is neutral; the accent arrives as ink.** Large surfaces are desaturated
   charcoal. Colour appears in small marks, glyphs and text — never as big saturated
   fills. An earlier version used 86%-saturated accent tints for chips and every one
   read as a stain; they are now 13%.
2. **Soft, not neon.** Explicitly rejected: "black and colour, neon type stuff that
   starts to hurt the eye after long exposure." Backgrounds lifted off pure black, text
   pulled off pure white, because maximum contrast on near-black blooms glyph edges.
3. **Warm on dark, cool on light.** Dark wears terracotta; light wears indigo/violet.
   Nothing cool appears in dark-mode chrome and nothing warm in light-mode chrome.
4. **Meaning keeps its colour.** Status hues (green/amber/red) stay legible and are
   never decorative. Everything else defers to neutral.

---

## 3. What the identity needs to deliver

- A **mark** that is unmistakably a sibling of Relay's "R" — same construction logic,
  same weight, same negative-space feel — but reads as *bridge/crossing*, not as a
  second "R".
- Works at **16px** (tab icon) and **34px** (collapsed rail) without turning to mud.
- A **dark variant** and a **light variant**, following the warm/cool split above.
- A **horizontal lockup** with the "Relay Bridge" wordmark, where the mark still works
  alone when the wordmark is clipped.
- Should sit next to Relay's lockup and read as *the same company shipped both*.

### Avoid

- Literal suspension bridges, literal arrows, literal git-branch diagrams.
- Anything that reads as generic "sync" — circular arrows, two-way chevrons.
- Gradients on the dark variant; Relay's dark mark is deliberately flat.
- A second letterform that competes with Relay's "R".

### Worth exploring

- The **crossing/gate** idea: two fixed points, one guarded span between them, where
  passage is conditional rather than automatic.
- **Asymmetry between the two sides** — one heavy and permanent, one light and
  temporary. That asymmetry *is* the product.
- Relay's "R" already has strong internal negative space; a bridge form could live in
  that same void rather than beside it.
