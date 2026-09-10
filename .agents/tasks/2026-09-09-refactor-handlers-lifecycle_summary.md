# Summary: 2026-09-09-refactor-handlers-lifecycle

T5 validators-then-executes, P1 lifecycle.ts, P2 runtime-tail, sidecars.ts, S6/S7/S8 with aliases, AGENTS.md sync. Zero behavior change (one reviewed structural composition: `launchAndWatch` shared setup for the spawn execute; resume keeps its exact inline flow). `index.ts` 2681 → 317 lines of registration/delegation.

## Files touched
- `pi-extension/subagents/handlers/validators.ts` — new, pure: `validateSelfSpawn`, `validateSpawnParams` (allowlist gating), `validateNameCwd` (C1 boundary), `decideSteerResume` (ambiguity→error vs missing→resume-fallthrough), `loadoutRefusalText`/`missingSessionFileText`.
- `pi-extension/subagents/handlers/spawn.ts` — `subagent` execute (thin; validates via validators, launches via `lifecycle.launchAndWatch`); owns `SubagentParams`.
- `pi-extension/subagents/handlers/message.ts` — `subagent_message` execute (resume flow moved verbatim; steer fns + `resolveResumeLaunchBehavior` live here); owns `SubagentMessageParams`.
- `pi-extension/subagents/handlers/list.ts` — `subagents_list` + `/subagent` command, moved as-is.
- `pi-extension/subagents/lifecycle.ts` — new (~1550 lines): `launchSubagent`/`watchSubagent`/`launchAndWatch`, `teardownSession(store, dir)` (M1-scoped), `recoverSession(store, dir, pi, opts?)` (injectable `exists`/`monitorKept`/`watchRunning`), `resurrectRunningTab` (+`exists` seam), `monitorKeptTab`/`trackKeptTab(store, …)`, `sweepStaleArtifacts`, ask queue (claim via sidecars), per-session UI (`sessionCtxs`, widget/status timers), `handleSessionStart/Shutdown`.
- `pi-extension/subagents/runtime.ts` — new: the four `Symbol.for` keys + import-time rotation ordering preserved exactly, free of `agents.ts` imports.
- `pi-extension/subagents/session/sidecars.ts` — new, dependency-free (`node:fs`/`path` only): `atomicWriteJson`/`claimFile`/`readJsonClaim`/`takeSidecar` (claims **both** `.exit` and `.done`, `.exit` wins, corrupt `.exit` consumed + reported via injected `onCorrupt`).
- `pi-extension/subagents/index.ts` — registration only (`registerTool`×3, `registerCommand`, 3 renderers, `on(session_start|shutdown)` → lifecycle); all 53 `__test__` keys intact, re-pointed never removed.
- `agents.ts` — S7 `parseFrontmatterBlock` map (`getFrontmatterValue` wrapper preserves the `(.+)` empty⇒undefined contract); S8 `resolveLaunchPolicy` table with the three deprecated aliases delegating (D7 `__test__` pins intact).
- `launch.ts` — S6: imports `agents.ts` directly; `launch-types.ts` **deleted** (`SubagentLoadoutShim` kept as `unknown` alias in launch.ts).
- `store.ts` — M2: `RunningEntry` extended with optional run fields, `RunningSubagent` alias (boundary casts gone); singleton unchanged.
- `keep.ts` — `shouldKeepSurface*` trio moved here (no production callers; `__test__` re-pointed).
- `kitty.ts` — `takeCompletionSidecar`/`claimSidecarFile` delegate to sidecars (corrupt-drop logging preserved via injected `logCorruptDrop`).
- `subagent-done.ts` — sidecar writes via `atomicWriteJson`; `writeAskSignalAtomic`/`writeCompletionSidecarAtomic` kept as aliases.
- `test/handlers-lifecycle.test.ts` — new, 15 tests (validators, `teardownSession` M1 scoping, `recoverSession` ask+kept+live+prune, sidecars policy + dependency-free pin, S6/S7/S8); registered in `package.json:test`. `test/bugfixes.test.ts` — compat-pins test follows the P2 move (literals pinned in `runtime.ts`; intent preserved).
- `AGENTS.md` (map + rules 3/4/7/9 + recipes), `docs/HOW-IT-WORKS.md` (files list).

## Verification
- Full `npm test`: **293/297** (baseline 278/282 + 15 new; only the 4 pre-existing `subagent discovery` failures, caused by the environment's global `~/.pi/agent/agents/*.md` shadowing — per AGENTS.md, ignored).
- `test/handlers-lifecycle.test.ts`: 15/15. Launch snapshots untouched and green (byte-identical commands).
- Integration (`npm run test:integration`): fails identically on the pristine baseline worktree (kitty focus/file timeouts — no focusable display in this environment). Environmental, not a regression.

## Notes / deviations
- Compat-pins test edit (forced by the in-scope P2 move; rename-guard intent kept).
- `launchAndWatch` composes spawn's launch→register→watch setup with injected hooks; resume routes through lifecycle primitives directly (its H6/kept guards stay verbatim in the handler).
- Deliberately untouched (out of scope): P5 validator unification, S10 deletions (`legacy-branch.ts`, mux aliases, `formatDuration`), S13 generalization (`getShellReadyDelayMs` moved as-is to lifecycle), T7 splits, P4 split.
