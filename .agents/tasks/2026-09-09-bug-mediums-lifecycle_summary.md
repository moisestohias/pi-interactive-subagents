# Summary: 2026-09-09-bug-mediums-lifecycle

Fixed M2–M9 trust/watcher bugs plus H4/H5 lifecycle bugs. No registry/sidecar format change (only additive optional `running` flag); fire-and-forget semantics unchanged; no `__test__` key removed (only added).

## Files touched
- `pi-extension/subagents/status.ts` — M4: absent `status` section ⇒ defaults (mirrors `parseTabsConfig`); present-but-invalid still throws. New `DEFAULT_STATUS_CONFIG`.
- `pi-extension/subagents/config.ts` — M4: new non-throwing `getSafeExtensionConfig()` (last-good-or-defaults with loud log) for render + timer paths; tool paths stay strict. Defaults consolidated in `defaultExtensionConfig()`.
- `pi-extension/subagents/index.ts` — M4: widget render + status-timer guard/lineLimit use safe config. M2: `promotePendingAskFile` queue drain + `restoreAskClaimNoClobber` (never overwrites a newer `.ask`) + compat-1 retain-then-retry-once gate (`.corrupt-retry` marker; success clears it). M3: `shouldNotifyResult` gate (cancelled ⇒ silent) + try/catch around every notify in spawn/resume/resurrect fan-out; resume `.catch` now routes via `notifyErrorCanonical` (sole-envelope rule). M7: resume baseline on parsed-entry basis (`total - skipped`; raw `total` alone still counts torn lines — documented in code). M9: kept monitor passes `ignoreDone`; tab-close after first result is silent via new `PollResult.tabClosed` marker (kitty.ts). H4: `sessionCtxs` per-session UI map (widget fans out to all live sessions), shutdown forgets only its own ctx and clears shared timers only when no runs remain. H5: launch persists `surface` + `running:true`; `resurrectRunningTab` re-watches orphaned live tabs on `session_start` (unknown liveness watches per N3; dead surfaces pruned); kept-reattach loop skips `running`-flagged entries. `__test__` gains: `shouldNotifyResult`, `restoreAskClaimNoClobber`, `decideResurrectAction`, `sessionCtxs`, `startWidgetRefresh`, `startStatusRefresh`, `timersActiveForTest`.
- `pi-extension/subagents/session/loadout.ts` — M5: `isValidSubagentLoadout` (allowlist must be a non-empty string; full shape checked); invalid sidecars refuse resume via the existing loadout-refusal path.
- `pi-extension/subagents/session/registry.ts` — M6: corrupt registries backed up (`*.corrupt-<ts>`) with salvageable entries merged; new `running?: boolean` registry field (H5 marker; absent = kept, preserving old behavior).
- `pi-extension/subagents/agents.ts` — M8: tool-extension map moved onto `Symbol.for("pi-subagents/tool-extensions")` so registrations survive `/reload`.
- `pi-extension/subagents/kitty.ts` — M9: `takeCompletionSidecar(sf, {ignoreDone})` + `pollForExit({ignoreDone})`; H1 errors carry `tabClosed: true`.
- `test/bugfixes.test.ts` — 10 new describes (M4, M5, M6, M8, M2 incl. drain, M3, M7, M9 ×2, H4 two-session timer scoping, H5 tri-state table + adaptive watch/prune wiring test); old single-strike corrupt-drop test updated to the two-strike gate.

## Verification
- `test/bugfixes.test.ts`: 42/42 pass. Full `npm test`: 254/258 — the 4 failures are the documented pre-existing `subagent discovery` subtests (AGENTS.md; untouched).
- Notable: this shell runs inside live kitty, which surfaced H5-prune + H1-probe behavior during testing (surface 99999 positively dead → prune path verified live).
