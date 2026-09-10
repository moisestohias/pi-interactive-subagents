# Summary: 2026-09-09-refactor-launch-results

T2/T3 single plan pipeline (one env order), S3/S4 + env-contract table, T4 results.ts + resume-catch via notifyError. Zero behavior change except the three reviewed unifications (env order, Claude preamble first line, resume SURFACE/AUTO_EXIT position — all comment- or write-only).

## Files touched
- `pi-extension/subagents/launch.ts` (+185/−~20): `buildPiLaunchPlan` (taskArg/skills/delivery → parts/env/cd/command/script via `buildPiParts`/`buildEnvPrefix`/`SCRUB_PREFIX`/`withDoneSentinel`/`launchScriptName`) and `buildPiResumePlan` (message → msg file → parts via `buildPiParts`; always `autoExit: true` first-class; `stamp`/`msgTimestamp` test seams); `writeTaskArtifact`/`writeResumeMessageFile` via `contextArtifactName` + `timestampTag` (S4 dead `|| "resume"` gone; msg-file gains optional ts override); sysprompt stamp via `timestampTag()`; M4 `PI_SUBAGENT_*` writer/reader/compat table on `buildEnvPrefix` (incl. SURFACE write-only/M10, KEEP_TAB removed wire).
- `pi-extension/subagents/index.ts` (−~150 net): launch pi path → `writeTaskArtifact` + `buildPiLaunchPlan` (inline `parts`/`envParts`/`artifactName`/`"unset …"` gone); resume → `buildPiResumePlan` (inline parts/env/msg/script gone); Claude preamble → `scriptPreambleFor("claude-launch")` + `launchScriptName`; session filename → `sessionTimestamp()`; `watchSubagent` pi → `piSummaryFromEntries` (single read kept), claude → `extractClaudeSummary` + `cleanupClaudeSentinel` in `finally` (D6, no new fn; catch block same helper); resume `.then` → `piSummaryFromEntries` (C4 `result.summary` fallback kept); resume `.catch` already `notifyError` (M1, preserved); removed now-unused `shellEscape`/`findLastAssistantMessage`/`SUBAGENTS_DIR`.
- `pi-extension/subagents/results.ts` — new: `summaryFallback` (4-way, `label` keeps launch/resume/claude wording), `piSummaryFromEntries` (pure, callers keep single-read/C4), `extractClaudeSummary` (sentinel → injected `readScreen` → quiet default; kitty-free).
- `pi-extension/subagents/format.ts` — S3: `timestampTag(now?, len?)` + `sessionTimestamp()` (23-char+Z distinct shape).
- `pi-extension/subagents/names.ts`, `cli/claude.ts`, `notifications.ts`, `session/*` — untouched (helpers already correct; cleanup reused as-is; no registry/sidecar format change).
- `test/launch.test.ts` (16/16): Phase-0 block rewritten to plans — one `UNIFIED_ORDER` asserted for `buildEnvPrefix` + both plans (reviewed diff replaces the old three-way-disagreement pins + inline replicas); pi/resume snapshots via plans (pinned ts/stamp); Claude preamble asserts unified `claude-launch` first line; kept C1 injection test; new S3/S4 helper test.
- `test/bugfixes.test.ts` (65/65, +4): `summaryFallback` matrix + label distinction, `piSummaryFromEntries`/`extractClaudeSummary` with injected readers.

## Verification
- `test/launch.test.ts` 16/16, `test/bugfixes.test.ts` 65/65, `test/test.ts` 168/172 (4 pre-existing discovery failures only), others 29/29; full `npm test` **278/282** (baseline was 273/277 — same 4 pre-existing failures).
- Acceptance: zero inline `envParts`/`artifactName`/`"unset …"` in `index.ts`; both backends via `scriptPreambleFor`; `results.ts` serves all three paths with `finally`-cleanup via existing helper and `notifyError` resume-catch; contract table in `launch.ts`; no `__test__` removal (53 keys intact).

## Notes / left for handlers task
- M2 (`RunningSubagent` vs `RunningEntry` duplication) kept as-is with casts — noted hazard for the handlers/lifecycle task, not unified here per task scope.
- Preamble `Generated:` line stays a live timestamp (comment-only, sink-covered); plan `stamp`/`msgTimestamp` seams cover determinism in tests.
- Out-of-scope untouched: T5 validators/executes, P1/P2, sidecars.ts, P4 split (stayed in `launch.ts`), P5/S10/S13.
