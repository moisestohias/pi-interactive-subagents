# Task: Refactor launch unification + results (Phases 2 + 3)

**Filename**: `tasks/2026-09-09-refactor-launch-results.md` — date = creation date (approval date), never changes; summary file on completion: `tasks/2026-09-09-refactor-launch-results_summary.md`.

---

## Context

- The live rule-1 violation: `launch.ts` owns `buildEnvPrefix`/`SCRUB_PREFIX`/`writeTaskArtifact`/`writeResumeMessageFile`/`buildPiParts`/`scriptPreambleFor`, but `launchSubagent` (`index.ts:1015–1326`) and the resume path (`index.ts:2240–2330`) rebuild all of it inline — with a three-way env-order disagreement (review T2 evidence). Shell quoting is load-bearing (rule 2). Strongest-endorse item in review.
- Also extracts triplicated result wording (`watchSubagent` pi/claude branches + resume `.then`) into `results.ts`, preserving the intentional launch-vs-resume wording distinction via a `label` param, reusing existing `cli/claude.ts:cleanupClaudeSentinel` (no new cleanup fn), and routing the resume `.catch` (`index.ts:2397` direct `sendMessage`) through `notifyErrorCanonical` (Missing M1 — live sole-owner violation).
- Depends on: Phase-0 snapshots (byte-identical gate), foundation task (clean imports), bug-highs (C1 sink + sidecar policies preserved). Blocks: handlers/lifecycle task.
- Links: `refactor-suggestions.md` (T2, T3, T4, S3, S4), `refactor-suggestions-review.md` (T2/T3 endorsed, D6 cleanup-correction, S3 23-char note, S4 dead-fallback correction, M1/M4), `bug-findings.md` M10.

---

## Task-Description

1. **Single plan pipeline in `launch.ts`:** add `buildPiLaunchPlan({ sessionFile, loadout, artifactDir, name, surface, taskArg, effectiveSkills, taskDelivery })` and `buildPiResumePlan({ sessionPath, loadout, artifactDir, name, surface, id, activityFile, message, resumeCwd })` reusing `buildEnvPrefix` (first-class `autoExit`, not via `extra`), `SCRUB_PREFIX`, `buildPiParts`/`applySandboxToParts`, `writeTaskArtifact`/`writeResumeMessageFile`, `scriptPreambleFor`/`scriptPathFor`, `withDoneSentinel`. Guards stay in handlers (kept double-open refusal, stale-sidecar unlink after reservation, loadout refusal, `entryCountBefore`). Migrate launch + resume call-site by call-site against Phase-0 snapshots; the env-order test now asserts one order. Stay in `launch.ts` (defer the P4 split until it actually doubles).
2. **Timestamp/slug + env table:** `timestampTag(now?, len?)` in `format.ts` + separate `sessionTimestamp()` (or explicit `+"Z"`) so the 23-char session filename isn't "unified" into artifact format; route resume naming through `names.ts:resumeScriptName`/`contextArtifactName` and delete dead `|| "resume"` (slugify never returns `""`). Add the `PI_SUBAGENT_*` writer/reader/compat table (Missing M4) in docs or as a comment.
3. **`results.ts`:** sync `summaryFallback({ entriesSummary, errorMessage, exitCode, label })` + `extractPiSummary(sessionFile, afterLine, outcome)` + async `extractClaudeSummary` taking an injectable screen-reader (mirror `steerSubagent`'s injected `send` seam); `finally`-cleanup via existing `cleanupClaudeSentinel`. Route resume `.catch` through `notifyErrorCanonical`. Unify `RunningSubagent`/`RunningEntry` toward one interface only if trivial; otherwise note as known hazard (Missing M2) for the handlers task.

---

## Files to Touch

- **Assembly:** `pi-extension/subagents/launch.ts` (new plans), `pi-extension/subagents/index.ts` (launch ~1015–1326 + resume ~2240–2330 shrink to plan calls), `pi-extension/subagents/results.ts` (new), `pi-extension/subagents/cli/claude.ts` (reuse cleanup, no signature change), `pi-extension/subagents/notifications.ts` (resume-catch routing).
- **Helpers:** `pi-extension/subagents/format.ts` (timestamps), `pi-extension/subagents/names.ts` (naming routes).
- **Tests:** `test/launch.test.ts` (snapshots updated to single order deliberately).

---

## Acceptance Criteria

- [ ] Launch, resume, and `buildEnvPrefix` produce identical prefixes for identical inputs; zero inline `envParts`/`artifactName`/`"unset …"` literals remain in `index.ts`.
- [ ] Phase-0 snapshots updated and green, with the order-unification shown as a reviewed diff (not accident); preamble for both backends via `scriptPreambleFor`.
- [ ] `results.ts` serves launch + resume + claude paths; sentinel cleanup in `finally` via existing helper; resume `.catch` uses `notifyErrorCanonical`.
- [ ] `PI_SUBAGENT_*` contract table exists; `npm test` green; no registry/sidecar format change.

---

## Notes

- Byte-identical commands except the reviewed order/preamble unification. If any snapshot diverges unexpectedly, stop and re-pin rather than "fixing forward".
- Do not move tool handlers or watcher orchestration here (next task owns them).
