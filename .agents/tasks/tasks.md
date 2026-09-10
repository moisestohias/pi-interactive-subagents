# Task Board

Work queue for agents. **Read this file first** — it's the single source of truth for what work is available, in progress, or done. Only implement what is listed here.

## States

- `[ ]` available — pick one
- `[-]` in progress — mark when you start
- `[x]` done — brief + summary moved to `done/`

## Guideline

1. Pick the next available task `[ ]` in order; mark it `[-]` (in progress).
2. Read the task's markdown file **and every approved note it links**.
3. When done: mark the task `[x]`, create summary file with the same task's file name suffixed with `_summary.md` summarizing what was changed (files touched, behavior added). Keep it short.
4. Move the brief + summary into `done/`.

> **Order matters by phase:** tasks are listed in dependency order — later tasks assume earlier phases' file collisions are settled. Never start a later phase while an earlier one has available work, unless a task is blocked.
> Tasks within a phase are independent — don't rely on another agent's in-progress work. If two tasks touch the same module, implement yours to work regardless of the other.

> Do not read or attempt to implement anything not listed below even if the md file exists.

## Task list

> Phases group tasks that must land in sequence.

### Phase 0 — Safety net (tests only, no source changes; gates everything)

- [x] `2026-09-09-phase0-command-snapshots.md` — exact pi/claude/resume command snapshots + env-order pin in test/launch.test.ts (links: `refactor-suggestions.md` T2/T3, `refactor-suggestions-review.md` #1, `bug-findings.md` M10) — done, summary: `2026-09-09-phase0-command-snapshots_summary.md` (15/15 launch tests pass; 3 full-suite failures pre-exist, verified via stash)

### Phase 1 — Bug highs: RCE, hangs, corruption

- [x] `2026-09-09-bug-highs.md` — C1 preamble sink+boundary (all 3 sites), H1 tab-death probe, H6 resume reservation, H3+M1 atomic sidecars (links: `bug-findings.md` C1/H1/H6/H3/M1, `bug-findings-review.md` Confirmed+Missing #1/#5) — done, summary: `2026-09-09-bug-highs_summary.md` (launch 15/15, bugfixes 24/24; full suite 236/240, 4 pre-existing discovery failures only)

### Phase 2 — Bug mediums + session lifecycle

- [x] `2026-09-09-bug-mediums-lifecycle.md` — M4/M5/M6/M8 trust boundaries, M2/M3/M7/M9 watcher robustness, H4/H5 per-session timers + reload resurrection (links: `bug-findings.md` M2–M9/H4/H5, `bug-findings-review.md` #5–9) — done, summary: `2026-09-09-bug-mediums-lifecycle_summary.md` (bugfixes 42/42; full suite 254/258, 4 pre-existing discovery failures only)

### Phase 3 — Bug lows + compat + hygiene bundle

- [ ] `2026-09-09-bug-lows-hygiene.md` — L1–L8, downgraded M10/M11, async steer/close, GC, compat pins; H2/S10-deletions/P5/S13-generalization explicitly out (links: `bug-findings.md` L§§/Compat, `bug-findings-review.md` L§§/Severity/Missing #2–4)

### Phase 4 — Refactor foundation (wrappers, constants, renderers)

- [ ] `2026-09-09-refactor-foundation.md` — T1a/T1b wrapper deletion + adapter relocation (clean names), S1/S2/S5/S11/S12, T6+P3 renderers.ts from details.summary (links: `refactor-suggestions.md` T1/T6/P3, `refactor-suggestions-review.md` T1/T6/P3/S-sections)

### Phase 5 — Refactor launch unification + results

- [ ] `2026-09-09-refactor-launch-results.md` — T2/T3 single plan pipeline (one env order), S3/S4 + env-contract table, T4 results.ts + resume-catch via notifyError (links: `refactor-suggestions.md` T2–T4, `refactor-suggestions-review.md` T2/T3/D6)

### Phase 6 — Refactor handlers + lifecycle + lazy tail + docs

- [ ] `2026-09-09-refactor-handlers-lifecycle.md` — T5 validators then executes, P1 lifecycle.ts, P2 runtime-tail, sidecars.ts, S6/S7/S8 with aliases, AGENTS.md sync; P5/S10-deletions/S13-generalization explicitly not scheduled (links: `refactor-suggestions.md` T5/T7/T8/P1/P2, `refactor-suggestions-review.md` D3–D5/D7/M2/M3/M5)


## Done
