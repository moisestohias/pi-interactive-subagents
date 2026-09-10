# Summary: 2026-09-09-refactor-foundation

T1a/T1b wrapper deletion + adapter relocation (clean names), S1/S2/S5/S11/S12, T6+P3 renderers.ts from details.summary. Zero behavior change except the intended T6 renderer source switch (new messages render from structured summary; old messages use the stripping fallback).

## Files touched
- `pi-extension/subagents/index.ts` — −484 lines (3270→2786): deleted ~30 pure-alias wrappers (agents/format/paths/launch/notifications/widget/keep borrows now imported clean, no `*Canonical` scar tissue); deleted dead triple cache (`extensionConfig/statusConfig/tabsConfig` + `safeConfigInit`/`refreshConfigCache`, replaced with `warnOnInvalidConfig()` + `invalidateExtensionConfigCache()` in `session_start` per S1); deleted dup `ICON_*`/`ACCENT`/`RST` (S2, dead — no import needed); deleted `void …CANONICAL` + `DEFAULT_SUBAGENT_TOOLS` aliases (S12, canonical imported clean); T1b adapters: `renderRunningWidgetLines` (renamed to avoid shadowing, `__test__.renderSubagentWidgetLines` re-pointed), `buildSubagentToolAllowlist` wrapper deleted (default moved to launch.ts), `formatWidgetRightLabel` dropping wrapper deleted (canonical with full `opts` used, fixing the lost claude label), `shouldKeepSurface*` kept with clean imports (`resolveKeepDecision` pure wrapper deleted), `maybeCloseSurface`/`Async` + `shouldCloseSurface` now require `keepSurface: boolean` (3 callers pass `running.keepSurface === true`), `keptTabAlive` deleted (N3 default folded into `store.ts:findKept`; session_start kept-reattach inlined to `windowExistsOrNull(surf) !== false`); S11 both `resolve()===resolve()` loops replaced with `subagentStore.findRunningBySessionFile()` (removed now-unused `resolve` import); P3 all 5 tool `renderCall`/`renderResult` closures + 3 message renderers replaced with `renderers.ts` imports (see below); `__test__` keys intact (53/53, re-pointed only — `renderSubagentWidgetLines` → renamed adapter, `buildCdPrefix/buildEnvPrefix/scriptPreambleFor` → shorthand clean).
- `pi-extension/subagents/renderers.ts` — new (312 lines): owns 5 tool renderers (`renderSubagentToolCall/Result`, `renderSubagentsListToolResult`, `renderSubagentMessageToolCall/Result`) + 3 message renderers (`renderSubagentResultMessage/StatusMessage/QuestionMessage`, byte-identical copies except T6 summary source). Runtime imports only `notifications.ts` (`summaryForDisplay`), `format.ts`, framework `Box/Text/keyHint` + type-only `SessionStats` — no `store`/`kitty`.
- `pi-extension/subagents/notifications.ts` — T6: `notifyResult` details gains `summary` (one line); new `summaryForDisplay(details, rawContent)` (prefers structured summary, stripping-fallback for old messages; S9 reuses shared `escapeRegExp` from `agents.ts`).
- `pi-extension/subagents/store.ts` — S5/T1b: `findKept` gains N3 default `exists = (s) => windowExistsOrNull(s) !== false` (imports `kitty.ts`; acyclic); `findKeptTab` in index passes through (no default) to use it.
- `pi-extension/subagents/launch.ts` — T1b: `buildSubagentToolAllowlist` default `spawningTools` now `SPAWNING_TOOLS` from `agents.ts` (single home; was a literal duplicate of the same values).
- `test/bugfixes.test.ts` — +4 tests (61/61): T6 `details.summary` + fallback with special-char name, P3 result-renderer from summary, T1b `__test__` widget-lines + `formatWidgetRightLabel` opts (claude label).
- `pi-extension/subagents/widget.ts`, `config.ts` — no edits required (constants already canonical; cache invalidation uses existing `invalidateExtensionConfigCache`).

## Verification
- `node --test test/launch.test.ts`: 15/15 pass (Phase-0 snapshots guard byte-identical commands; builders untouched per constraints).
- `node --test test/bugfixes.test.ts`: 61/61 pass (was 57/57; +4 new).
- `node --test test/test.ts`: 168/172 pass — 4 failures are the documented pre-existing `subagent discovery` subtests (AGENTS.md; untouched).
- `node --test test/format.test.ts test/names-keep.test.ts test/store-notifications.test.ts test/session-status-split.test.ts test/system-prompt-mode.test.ts`: 29/29 pass.
- `npm test`: 273/277 pass — 4 pre-existing discovery failures only.

## Deviations / notes for later phases
- Doc said “six” `renderCall`/`renderResult` closures; actual is five (`subagent` 2 + `subagents_list` 1 + `subagent_message` 2) — moved all five.
- `summaryForDisplay` escapes both `name` and `elapsed` via `escapeRegExp` (original escaped only `name`); `elapsed` values (`45s`, `3m 12s`) are unaffected, `?`-fallback becomes literal (more correct, old-message-only edge).
- `renderers.ts` type-imports `SessionStats` from `session.ts` (erased at runtime); runtime deps are notifications/format/framework only, satisfying “imports nothing from store/kitty”.
- `widget.ts`/`config.ts` needed no edits (see above).
- Out-of-scope untouched per task: builders/commands (T2/T3), validators/executes (T5), `status.ts`/`activity.ts`/`kitty.ts` splits, P5/S10-deletions/S13-generalization, `launch-types.ts`, `legacy-branch.ts`, harness helpers.
- Integer invariants preserved (existing suites pin them): C1 sink (`sanitizePreambleField` + `sanitizeScriptPreamble` + boundary rejects untouched), H1 probe, H6 reservation + re-check (now via store helper, same semantics), M1 rename-claim, M2 no-clobber, M3 gate, M9 `ignoreDone`/`tabClosed`.
