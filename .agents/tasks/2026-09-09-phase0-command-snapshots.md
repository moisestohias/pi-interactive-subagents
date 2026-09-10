# Task: Phase 0 — exact command snapshots (no source changes)

**Filename**: `tasks/2026-09-09-phase0-command-snapshots.md` — date = creation date (approval date), never changes; summary file on completion: `tasks/2026-09-09-phase0-command-snapshots_summary.md`.

---

## Context

- The refactor plan (`refactor-suggestions.md` T2/T3, endorsed in `refactor-suggestions-review.md` §§T2/T3 + priority §7) unifies three diverged command builders. Per AGENTS.md rule 2 (shell quoting is load-bearing) this is only safe behind byte-identical snapshot tests.
- Today `test/launch.test.ts` (~138 lines) covers builders in isolation, never the assembled `piCommand` / resume command. The three-way env-order disagreement (canonical `AGENT`-before-`NAME` in `launch.ts:50-66` vs inline launch `NAME`-before-`AGENT` at `index.ts:1241-1244` vs resume `AGENT`-before-`NAME` at `index.ts:2284-2289`) is unpinned.
- This task changes **zero source files** — tests only. It gates every Phase-5 refactor task.
- Links: `refactor-suggestions.md` (T2/T3, Suggested order Phase 0), `refactor-suggestions-review.md` (Recommended order #1, T2 evidence), `bug-findings.md` M10, `AGENTS.md` rules 1–2.

---

## Task-Description

1. In `test/launch.test.ts` (extend, do not rewrite) add three snapshot blocks:
   - **pi launch**: full `piCommand` string for a representative spawn (model + thinking + identity + tools + skills + `subagent_agents` list). Build it by calling the same assembly the launch path uses today; assert the exact string (quoting, key order, `SCRUB_PREFIX`, `cd` prefix, `withDoneSentinel` suffix).
   - **claude launch**: full command from `cli/claude.ts:buildClaudeCommand` + sentinel suffix + preamble lines as sent via `sendLongCommand` (pin the current inline preamble at `index.ts:1136-1140` verbatim — the unification PR will show the intended change as a reviewed diff).
   - **resume command**: full command for a loadout-replay resume (model + allowlist + spawnable + `AUTO_EXIT=1` + `@resumeMsgFile`), pinning current key order verbatim.
2. Add one explicit **env-order assertion**: for identical inputs, record the key order produced by (a) `buildEnvPrefix`, (b) inline launch `envParts`, (c) inline resume `resumeEnvParts`. Assert they are recorded (not necessarily equal — they disagree today); the Phase-5 unification task will update this test to assert equality with the single chosen order.
3. Cover preamble sites: assert current `scriptPreambleFor("launch"|"resume")` output plus the inline Claude preamble, so the C1 fix (Phase 1) has a baseline.
4. Keep everything unit-runnable (`npm test`, no kitty).

---

## Files to Touch

- **Tests only:**
  - `test/launch.test.ts` — extend with the three snapshot describes + env-order pin.
- **Read-only reference (do not edit):**
  - `pi-extension/subagents/index.ts` (~1118–1290 launch, ~2240–2330 resume)
  - `pi-extension/subagents/launch.ts` (builders), `pi-extension/subagents/cli/claude.ts`

---

## Acceptance Criteria

- [ ] `test/launch.test.ts` contains a pi-launch full-command snapshot (model+identity+tools+skills+spawning) asserting the exact string.
- [ ] Contains a claude-launch snapshot (command + sentinel + current inline preamble verbatim).
- [ ] Contains a resume-command snapshot (loadout replay, `AUTO_EXIT=1`, `@resumeMsgFile`).
- [ ] Contains an env-order pin recording all three current orders (documents the T2 three-way disagreement).
- [ ] `npm test` green; no source file modified (`git status` shows only test changes).

---

## Notes

- Do not "fix" the order disagreement here — pin it. The unification PR (Phase 5) changes the snapshots deliberately.
- Do not touch the 4 pre-existing `test/test.ts` discovery failures (AGENTS.md: ignore unless touching discovery).
- Keep snapshot strings readable (template-literal blocks, not minified) so the unification diff is reviewable.
