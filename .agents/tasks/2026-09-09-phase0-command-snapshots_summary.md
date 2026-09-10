# Summary: 2026-09-09-phase0-command-snapshots

Tests-only change gating all refactor work. No source files modified.

## Files touched
- `test/launch.test.ts` — extended imports (`shellEscape`, `getSubagentsDir`, `buildClaudeCommand`, `buildPiParts`, `writeTaskArtifact`, `SCRUB_PREFIX`, `mkdirSync`/`writeFileSync`); appended describe "Phase 0 — exact command snapshots" with 5 tests.

## Behavior added
- Pinned byte-identical snapshots: pi launch full command (scrub + quoted cd + inline env + parts + sentinel), claude launch (command + sentinel + inline preamble verbatim), resume command (loadout replay, AUTO_EXIT last, no SURFACE).
- Env-order pin documents the live three-way disagreement: canonical AGENT-before-NAME vs inline-launch NAME-before-AGENT vs resume AGENT-before-NAME/no-SURFACE/AUTO_EXIT-last.
- Preamble baseline: canonical vs Claude-inline disagreement pinned; C1 injection vector (raw `\n` escapes `#` comment) pinned as failing-today baseline for the bug-highs fix.

## Verification
- `node --test test/launch.test.ts`: 15/15 pass (10 existing + 5 new).
- `npm test`: 36 pass / 3 fail — identical 3 failures pre-exist without this change (verified via `git stash`; bugfixes, session-status-split, test.ts — environment/discovery, unrelated).
- `git status` confirms only test changes (plus pre-existing untracked review docs).
