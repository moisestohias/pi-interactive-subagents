# Task: Bug lows + compat + hygiene bundle

**Filename**: `tasks/2026-09-09-bug-lows-hygiene.md` — date = creation date (approval date), never changes; summary file on completion: `tasks/2026-09-09-bug-lows-hygiene_summary.md`.

---

## Context

- Everything low-severity / cosmetic / perf / docs from `bug-findings.md` (L1–L10, downgraded M10/M11) plus compat risks 3–7 and refactor-review Missing #2–4. Individually trivial; batched so they don't each cost a PR cycle. All confirmed in `bug-findings-review.md` with severity corrections (M10/M11 → Low, L8 reframed same-user).
- Explicitly **out of scope** (disputed/deferred per review): H2 work, `legacy-branch.ts` + alias deletions (breaks `test/integration/harness.ts`), `formatDuration` deletion without test update, P5 validator unification, S13 generalization.
- Depends on: bug-highs + mediums (touches adjacent lines; land last among bug tasks). Independent of refactor tasks (different lines; may run in parallel with Phase 1 but must not rename builders Phase 2 owns).
- Links: `bug-findings.md` (L1–L10, M10, M11, Compat 1–7), `bug-findings-review.md` (Confirmed L§§, Severity adjustments, Missing #2–4, Compat notes).

---

## Task-Description

1. **Guards/docs (L1, L4, L9, L10, M10-note):** scan `${…}` bodies in `safe_bash` or correct the comment (keep "not a sandbox" framing; pin `chmod 777 /tmp/x` + `dd if=` dispositions); drop dead `windowExists` import (keep `windowExistsOrNull` preference comment); user-docs nudge that only kept tabs are human-drivable (L9); L10 stays a code note (no change).
2. **Claude + hooks (L2, L8):** `json.dumps`/`JSON.stringify` non-string `last_assistant_message` in `plugin/hooks/on-stop.sh`; sentinel `0600` + transcript-path allowlist (must live under known transcript dirs) in `cli/claude.ts`; document Claude runs as spawn-only (or the resume refusal they hit) — unvalidated copy + no-loadout halves are the real content, not "squatting".
3. **Cosmetics (L3, L6, L7):** orphan-question elapsed from `.ask` mtime/registry (not `Date.now()`); document a steer size cap or temp-file path for long steers; best-effort artifact GC (keep-last-N or age sweep in `session_start`, incl. stale `.consuming-*`/`.tmp-*` + orphaned activity files).
4. **Perf/hygiene (M10, M11, Missing #2–4, L5):** M10/M11 stay Low: sync→async steer/close adoption (`sendCommandAsync`/`closeSurfaceAsync` for steer/completion, keep sync for startup/tests); completion path single-read via `readEntriesAfter` (adopt its baseline everywhere); log-and-count every corrupt-claim drop; one retry/queue for steers on control-plane `null`. L5 `session/index-cache.ts`: quarantine with `legacy-branch.ts` or fix early-out + ambiguity surfacing — do not leave the silent newest-wins + full-walk trap for the next reader.
5. **Compat pins:** literal test for all `Symbol.for`/global keys; unknown config keys warn-and-ignore (types still throw); document all sidecar suffixes as reserved + sweep; note seed-header `version: 3` hand-tracking and `--match id:` numeric-only invariant in docs.

---

## Files to Touch

- `pi-extension/subagents/tools/safe-bash.ts`, `pi-extension/subagents/plugin/hooks/on-stop.sh`, `pi-extension/subagents/cli/claude.ts`, `pi-extension/subagents/index.ts` (import, recovery elapsed, steer note), `pi-extension/subagents/kitty.ts` (async variants), `pi-extension/subagents/session/index-cache.ts` (quarantine/fix), `pi-extension/subagents/session/io.ts` (baseline adoption), docs (`docs/*`, env-contract table if cheap).
- **Tests:** `test/bugfixes.test.ts` (L1 `${…}`, compat pins), existing blocks for M9/M3/C4 extensions.

---

## Acceptance Criteria

- [ ] `${sudo}`-style bodies scanned or comment corrected with dispositions pinned; dead import dropped.
- [ ] Structured Claude messages survive the Stop hook as valid JSON/text; sentinel created `0600`; transcript copy allowlisted; Claude spawn-only documented.
- [ ] Recovered questions show real elapsed; steer size policy documented; artifact/tmp/claim sweep exists.
- [ ] Steer/close hot paths async; completion reads file once; corrupt drops logged; `index-cache` quarantined or fixed (no silent newest-wins).
- [ ] Key-literal test, unknown-keys-warn test, suffix-sweep all green; `npm test` green; integration harness untouched and unbroken.

---

## Notes

- Do not delete `createSurfaceSplit`/`isMuxAvailable`/`muxSetupHint`/`isSurfaceAvailable` (harness uses them) or `legacy-branch.ts` (quarantined, harmless). Only collapse index's private `kittyUnavailableResult → muxUnavailableResult` alias if trivial.
- Do not generalize `getShellReadyDelayMs` (S13 disputed) — move as-is only if touching that file anyway.
