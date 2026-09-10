# Summary: 2026-09-09-bug-lows-hygiene

Low/compat/hygiene bundle (L1–L9, downgraded M10/M11, compat 1–7, refactor-review Missing #2–4). Out-of-scope items untouched: H2, `legacy-branch.ts`, harness helpers (`createSurfaceSplit`/`isMuxAvailable`/etc.), P5/S13, M10 prefix unification.

## Files touched
- `tools/safe-bash.ts` (L1): `${…}` bodies now scanned (the old comment claimed `$(), ``, ${}` but code only did the first two); intentional overblocks pinned in comments (`chmod 777 /tmp/x`, read-only `dd if=`); "not a sandbox" framing kept.
- `plugin/hooks/on-stop.sh` (L2): `json.dumps` (python) / `JSON.stringify` (node) for non-string `last_assistant_message` — sentinel stays valid JSON.
- `cli/claude.ts` (L8): new `createClaudeSentinelFile` (pre-creates sentinel `0600`; hook redirect preserves mode) wired into the Claude launch path; `copyClaudeSession` allowlisted to `~/.claude/projects` with logged refusal; same-user framing documented.
- `index.ts`: L3 (recovery `startTime` from `.ask` mtime), L4 (dead `windowExists` import dropped, preference comment), L6 (steer size-cap in `subagent_message` description), L7/compat-3 (`sweepStaleArtifacts` on `session_start` + reserved-suffix protocol registry docblock), M11 (`steerSubagentAsync` + `maybeCloseSurfaceAsync` adopted in tool/resume/completion paths; sync versions kept for startup/tests), Missing #2 (single-read completion via `readEntriesAfter` + `summarizeEntriesStats`), Missing #3 (one retry on control-plane-unknown steers; dead tabs fail fast), Missing #4 (`logCorruptDrop` at ask-drop sites), compat-2 (registry `version` write + marker carry-over).
- `kitty.ts`: `sendCommandAsync`/`closeSurfaceAsync` (same errors, async transport); `logCorruptDrop` + `corruptDropCountsForTest`; torn-`.exit` drop logged.
- `status.ts` (compat-5): unknown keys warn-and-ignore (forward compat); wrong types still throw.
- `session/registry.ts` (compat-2): `version: 1` on write, `version` carried across RMW, readers ignore it as a name entry; M6 salvage behavior preserved.
- `session/stats.ts` + `session.ts` (Missing #2): `summarizeEntriesStats(entries)`; `summarizeSessionStats` delegates.
- `session/index-cache.ts` (L5): quarantined via docblock (full-walk + newest-wins traps documented, no new callers); behavior untouched.
- `session/seed.ts` (compat-6): hand-tracked `version: 3` re-check note.
- Docs: HOW-IT-WORKS (kept-tabs drivable L9, steer size cap, suffix registry, seed note, index-cache quarantine), README (`cli: claude` spawn-only), KITTY-LESSONS (persisted-handle re-validation, compat-7).
- Tests: `test/bugfixes.test.ts` — 10 new describes (L1/L2/L3/L8/compat-2/compat-pins/M11+retry/single-read/drop-logging/sweep); updated the old unknown-keys test to warn-and-ignore. `test/test.ts` — updated 2 strictness assertions to compat-5 and 3 interruption tests to `await` the now-async `handleSubagentSteer` (contract change required by the M11 adoption the task mandates; `__test__` exports intact).

## Verification
- `test/bugfixes.test.ts`: 57/57 pass (incl. live stop-hook run + live kitty prune-path coverage where available).
- Full `npm test`: 269/273 — the 4 failures are the documented pre-existing `subagent discovery` subtests (AGENTS.md; untouched).
- Integration harness untouched; no builder renames; no registry/sidecar format break (additive `version` only).
