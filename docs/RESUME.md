# Resume behavior (`subagent_message` to a finished run)

`subagent_message({ name, message })` routes by state under one name:

- **Running** → steer text into the live tab (same process, picked up at the
  next turn boundary). Fire-and-forget; the eventual completion still arrives
  as `subagent_result`.
- **Kept open** (`tabs.keepOpen: true` + agent `auto-exit: false`, first result
  already delivered, tab still alive) → steer into the live tab, same as
  running. Only a *relaunch* is refused while the tab lives (two pi processes
  must never append to one `.jsonl`); close the tab and retry for a resumed run.
- **Finished (tab gone)** → resume the session: relaunch `pi --session
  <sessionFile>` with the message as the next task. Fire-and-forget, result
  steered back later. The resumed run reclaims its original name.

This file is the contract for the third case.

## TL;DR: resume always exits

Resume is always autonomous. It **always closes** its session + tab when the
follow-up turn ends — even if the agent has `auto-exit: false` and
`tabs.keepOpen: true`.

```
spawn:  keep ⇔ (keepOpen && !autoExit)   // EXIT-KEEP-PRECEDENCE.md
resume: keep ⇔ false                     // always EXIT
```

Concretely, with `config.json { "tabs": { "keepOpen": true } }` and
`worker.md { auto-exit: false }`:

1. `subagent({ agent: "worker", task: "…" })` → **KEEP**: no
   `PI_SUBAGENT_AUTO_EXIT`, writes `<session>.done` once, tab left open,
   completion reported once.
2. `subagent_message({ name: "worker", message: "…" })` after the tab closed
   → **EXIT**: `PI_SUBAGENT_AUTO_EXIT=1`, `ctx.shutdown()`, tab closed — the
   agent flag is not consulted.

This is intentional, not a bug. There is no interactive resume: an
`autoExit: false` agent resumed as kept would park a tab the parent is not
watching as interactive. Resume stays fire-and-forget so every follow-up
completes with a single steered result, exactly like a fresh spawn.

## How it is wired

- Parent decision: `pi-extension/subagents/keep.ts:resolveResumeKeepDecision()`
  returns `resolveKeepDecision({ keepOpen: false, autoExit: true })` →
  `{ keepSurface: false, effectiveAutoExit: true }`. Spawn uses
  `resolveKeepDecision({ keepOpen, autoExit: agentFlag })` instead, which is
  why the same agent keeps on spawn but exits on resume.
- Command: `pi-extension/subagents/launch.ts:buildPiResumePlan()` sets
  `autoExit: true` first-class (never via `extra`) → env prefix always contains
  `PI_SUBAGENT_AUTO_EXIT=1`. Launch (`buildPiLaunchPlan`) passes the effective
  per-run decision instead.
- Dispatch: `pi-extension/subagents/handlers/message.ts:resolveResumeLaunchBehavior()`
  returns `{ autoExit: true, interactive: false }`; the resume execute stores
  `keepSurface: false`.
- Child: `pi-extension/subagents/subagent-done.ts` reads only
  `PI_SUBAGENT_AUTO_EXIT`. `== "1"` → `ctx.shutdown()` on a finished turn;
  absent → stay interactive + write `.done` once (or `.exit` on error).
- Watcher: `lifecycle.ts:maybeCloseSurface(surface, keepSurface)` closes on
  resume runs (`keepSurface === false`); the result is reported once via the
  terminal sentinel / claimed sidecar, same as a spawn exit.

Deferred-exit rules still apply on resume: `awaitingAnswer` (`ask_question`
unanswered) and live child sub-agents (`RUNNING_CHILDREN_COUNT_KEY > 0`) park
as `waiting` instead of exiting; `stopReason: aborted` never counts as finished.

## What resume replays (and what it does not)

Resume rebuilds the exact same restricted process from the spawn-time snapshot
`<session>.loadout.json` (tool allowlist, backing extensions, model, thinking
level, system prompt, `subagent_agents` spawn whitelist, cwd) — not an
unrestricted relaunch. What is *not* replayed is keep: keep is a per-run
surface decision, and resume forces `keepSurface: false` (see above).

Name identity is preserved: the resumed run reclaims its original name (the
pre-resume reservation + post-delay re-check in `handlers/message.ts` prevents
double-opening one `.jsonl`).

## Refusals

Resume is refused with a clear error (listing known names) when:

- the name is not in `artifacts/<sessionId>/subagent-registry.json`,
- the session file is gone,
- the session predates sandboxed resume (no `.loadout.json` snapshot),
- the agent is a `cli: claude` agent (Claude runs write no sandbox snapshot,
  so they cannot be resumed),
- a live tab for that name still exists (steer instead; close the tab and
  retry for a resumed run),
- the control plane cannot confirm tab absence (unknown ≠ gone — entries are
  kept, double-open refused).

## Example

```typescript
// config.json: { "tabs": { "keepOpen": true } }
// worker.md frontmatter: auto-exit: false

subagent({ agent: "worker", name: "hello-writer", task: "Write hello world to hello.txt" });
// → KEEP: tab left open, result steered once via .done

subagent_message({ name: "hello-writer", message: "Append a second line" });
// tab was closed → resume: EXIT, tab closes when the follow-up ends
```

## Files

- `pi-extension/subagents/keep.ts` — `resolveKeepDecision()` (spawn rule) +
  `resolveResumeKeepDecision()` (resume rule).
- `pi-extension/subagents/launch.ts` — `buildPiLaunchPlan()` (effective
  `autoExit`) vs `buildPiResumePlan()` (`autoExit: true`).
- `pi-extension/subagents/handlers/message.ts` — steer-vs-resume dispatch +
  `resolveResumeLaunchBehavior()`.
- `pi-extension/subagents/subagent-done.ts` — child `PI_SUBAGENT_AUTO_EXIT`
  read + `ctx.shutdown()` vs `.done`.
- `docs/EXIT-KEEP-PRECEDENCE.md` — spawn keep/exit table + `Resume` section
  (summary); `docs/HOW-IT-WORKS.md` — lifecycle steps 3–4.
