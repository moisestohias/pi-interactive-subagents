# Summary: 2026-09-09-bug-highs

Fixed C1 (Critical RCE), H1, H6, H3+M1. H2 explicitly excluded (disputed false positive). No registry/sidecar format change; fire-and-forget semantics unchanged.

## Files touched
- `pi-extension/subagents/launch.ts` — new `sanitizePreambleField` (collapses `[\r\n]` in every interpolated preamble field); applied in `scriptPreambleFor` (covers launch + resume paths).
- `pi-extension/subagents/kitty.ts` — new exported `sanitizeScriptPreamble` sink guard (non-`#` lines get `# ` prefix; covers the inline Claude preamble too), applied in `sendLongCommand`; new `claimSidecarFile` shared by `.exit`/`.done` (M1: `.done` now rename-claimed, presence-only signal, delivers once); `pollForExit` accepts injected `exists` + `maxReadFailuresBeforeLivenessProbe` (default 3, default `windowExistsOrNull`): sustained get-text failure + probe `false` → error result, `null` (N3) keeps polling (H1).
- `pi-extension/subagents/subagent-done.ts` — new `writeSidecarJsonAtomic` core + exported `writeCompletionSidecarAtomic(sessionFile, "exit"|"done", data)`; all 3 completion writes (auto-exit error, keep-open error, keep-open done) now tmp+rename; `writeAskSignalAtomic` delegates (H3).
- `pi-extension/subagents/index.ts` — `subagent` execute rejects control chars (`[\r\n\0]`) in `name`/`cwd` at the tool boundary; `subagent_message` rejects them in `name`; resume path reserves `resume::<artifactDir>::<name>` in `reservedNames` before the first await (Missing #5: before stale-sidecar unlink), releases on every early return / catch / successful registration, and re-checks running + kept guards after the shell-ready delay, steering into the winner instead of double-opening (H6).
- `test/launch.test.ts` — Phase-0 injection-baseline test updated to assert the fix (all preamble lines stay comments, all fields/kinds).
- `test/bugfixes.test.ts` — 5 new describes (8 tests): C1 helper+sink, H1 gone-vs-unknown, H6 key namespacing, H3 round-trip + ask no-regression, M1 deliver-once.

## Verification
- `node --test test/launch.test.ts`: 15/15 pass. `node --test test/bugfixes.test.ts`: 24/24 pass.
- `npm test` (after `npm install`, which fixed the pre-existing import failures): 236 pass / 4 fail — the 4 are the documented pre-existing `subagent discovery` failures in `test/test.ts` (AGENTS.md: ignore, do not fix by editing tests).
