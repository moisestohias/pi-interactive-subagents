# Task: Refactor handlers + lifecycle + lazy tail (Phases 4a/4b + deferred)

**Filename**: `tasks/2026-09-09-refactor-handlers-lifecycle.md` — date = creation date (approval date), never changes; summary file on completion: `tasks/2026-09-09-refactor-handlers-lifecycle_summary.md`.

---

## Context

- Final structural cut: the three tool handlers (`subagent` execute ~1696–1980, `subagent_message` ~2044–2400, `/subagent` command ~2423) plus watcher/kept/session lifecycle still inline in `index.ts` (~1500 lines combined). Review: split into validators-now (pure, directly unit-tested, no DI) and executes+lifecycle together (one coherent cut with `lifecycle.ts`, gated by kitty integration). Lands `index.ts` at ~350 lines of pure registration.
- Also absorbs the deferred tail: dependency-free `session/sidecars.ts` (per-policy migrations with tests), `runtime.ts` narrowed last, one-file-at-a-time T7 only if touched, S6/S7/S8 with compat aliases, Phase-6 docs sync. Explicitly **not scheduled**: P5 validator unification (throw-vs-return policy clash), S10 deletions (harness breakage), S13 generalization (YAGNI — move as-is only).
- Depends on: all prior tasks (foundation imports, unified plans, bug-fixed watchers — this move must preserve them). Nothing depends on it except docs sync (fold in here).
- Links: `refactor-suggestions.md` (T5, T7, T8, P1, P2, P4-lazy, S6/S7/S8/S10/S13, "What NOT to abstract"), `refactor-suggestions-review.md` (D3 split, D4/D5 defer, D7 `__test__` impact, M2/M3/M5, Recommended #6–8).

---

## Task-Description

1. **Phase 4a validators (pure, no DI):** extract `validateSpawnParams` (self-spawn, allowlist gating) and `decideSteerResume` (incl. ambiguity→error vs missing→resume-fallthrough rule at ~2130–2145, loadout-refusal) as pure functions with direct unit tests importing their homes (M3 rule). Move `/subagent` command + `subagents_list` as-is (trivial).
2. **Phase 4b executes + `lifecycle.ts` + `runtime.ts`-tail (one PR):** `handlers/spawn.ts`, `handlers/message.ts` (thin, DI limited to already-existing seams) + `lifecycle.ts` (`launchAndWatch`, `teardownSession(deps, artifactDir)` with fake-store unit test proving M1 scoping per Missing M5, `recoverSession`, `monitorKeptTab`/`watchSubagent` orchestration). `runtime.ts` last and narrow: the four `Symbol.for` keys + import-time rotation ordering preserved exactly, free of `agents.ts` imports (cycle risk — agents publishes into the global). Unify `RunningSubagent`/`RunningEntry` on one interface (extend store's with optionals) and remove boundary casts (Missing M2).
3. **Lazy tail in the same or follow-up PR:** `session/sidecars.ts` (`node:fs`/`path` only — child-safe; `atomicWriteJson`/`claimFile`/`readJsonClaim`/`takeSidecar` claiming **both** `.exit` and `.done`; preserve restore-vs-drop policies per callsite with tests; keep `writeAskSignalAtomic` as alias). S6: delete `launch-types.ts`, import `agents.ts` directly + AGENTS.md map line. S7: frontmatter once-to-`Map` (keep `getFrontmatterValue` wrapper). S8: `resolveLaunchPolicy` table with deprecated aliases (check `__test__` pinning first). T7 only for files this task already touches.
4. **Docs sync:** AGENTS.md map (add `handlers/`, `lifecycle.ts`, `runtime.ts`, `renderers.ts`, `results.ts`, `session/sidecars.ts`; record deletions), HOW-IT-WORKS flows, "Common tasks" recipes (new-backend/config-key), "new tests import homes" rule.

---

## Files to Touch

- **New:** `pi-extension/subagents/handlers/spawn.ts`, `handlers/message.ts`, `handlers/list.ts` (or moves), `pi-extension/subagents/lifecycle.ts`, `pi-extension/subagents/runtime.ts`, `pi-extension/subagents/session/sidecars.ts`.
- **Shrink:** `pi-extension/subagents/index.ts` → registration only (`registerTool`×3, `registerCommand`, `registerMessageRenderer`×3 via `renderers.ts`, `on(session_start|shutdown)` delegating to lifecycle).
- **Touch carefully:** `pi-extension/subagents/agents.ts` (frontmatter map, keep wrapper), `pi-extension/subagents/launch.ts` (policy table aliases), `AGENTS.md`, `docs/HOW-IT-WORKS.md`.
- **Tests:** new validator suites + `teardownSession`/`recoverSession` fake-store tests; kitty integration gates the 4b cut.

---

## Acceptance Criteria

- [ ] Validators pure with direct unit tests (no `__test__` indirection for new code); `/subagent` + `subagents_list` moved unchanged.
- [ ] `teardownSession` fake-store test proves per-session scoping (M1); `recoverSession` covers ask-recovery + kept reattach.
- [ ] `index.ts` ~350 lines of registration/delegation; no behavior change (fire-and-forget, rule-3 formats, `__test__` keys re-pointed never removed).
- [ ] `sidecars.ts` dependency-free; each migration preserves its policy with tests; `launch-types.ts` gone with map updated.
- [ ] `npm test` + `npm run test:integration` (kitty socket, serial) green; docs map current.

---

## Notes

- Do-not-do list stands: byte-identical commands; `session.ts` barrel intact; no `__test__` key removal; no registry/sidecar format change; no watcher-semantics change.
- If 4b grows unreviewable, split as 4a-validators (land first) then 4b-cut — never interleave with Phase-2/3 work.
