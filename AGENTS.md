# AGENTS.md — working in `pi-interactive-subagents`

Async subagents for [pi](https://github.com/badlogic/pi-mono): spawn a subagent
into its own kitty tab, keep working, get the result steered back as a new turn.
Fire-and-forget throughout — never add polling loops, sleep-waits, or
log-tailing to "check" on a subagent; the harness delivers results automatically.

All extension source lives under `pi-extension/subagents/`. Paths below are
relative to the repo root unless noted.

## Commands

```bash
npm test                  # full unit suite (node --test, 8 files in package.json:test)
npm run test:integration  # kitty-dependent integration (needs kitty + socket, serial)
node --test test/<file>.test.ts  # one suite while iterating, e.g. test/bugfixes.test.ts
```

- Unit tests run anywhere. Integration tests need kitty remote control over a
  socket (`allow_remote_control yes` + `listen_on unix:/tmp/kitty-$USER` in
  `kitty.conf`, then restart kitty) and run with `--test-concurrency=1`.
- 4 tests in `test/test.ts` → `subagent discovery` assert bundled-agent
  defaults that the local `agents/*.md` don't satisfy; pre-existing. Ignore
  unless you touch `pi-extension/subagents/agents.ts` discovery or
  `agents/*.md` — then expect them to fail if a global
  `~/.pi/agent/agents/` file shadows a bundled agent. Don't "fix" them by
  editing tests — fix or restore the agent files if you touch that area.

## Map (read this before editing)

`pi-extension/subagents/index.ts` (~3300 lines) is the orchestrator but **not**
thin yet — it is a legacy monolith mid-extraction toward thin wiring
(tool/command/renderer registration + `session_start`/`shutdown`). Pure policy
goes in the home module; session-lifecycle wiring (watchers, reload recovery,
artifact sweep, steer fan-out) still lives in `index.ts` until it is
extracted. `index.ts` keeps a delegating wrapper only when `__test__` compat
needs it (`index.ts:__test__` — `test/test.ts` imports internals through it).

| Concern | Canonical home |
|---|---|
| Agent profiles (frontmatter, discovery tiers, spawn gate, tool→extension map) | `pi-extension/subagents/agents.ts` |
| Launch/resume command pieces (env/cd/preamble/sandbox/allowlist/prompts) | `pi-extension/subagents/launch.ts` (+ `launch-types.ts` types; `cli/claude.ts` for the Claude path: `buildClaudeCommand`, sentinel (`createClaudeSentinelFile`, `0600`) + allowlisted transcript copy) |
| Live identity (running runs, kept tabs, spawn reservations) | `pi-extension/subagents/store.ts` (`SubagentStore`) |
| Parent-bound steer messages | `pi-extension/subagents/notifications.ts` (sole `sendMessage` owner) |
| Widget rendering | `pi-extension/subagents/widget.ts`; formatters in `format.ts` |
| Keep/exit rule (`keep ⇔ keepOpen && !autoExit`) | `pi-extension/subagents/keep.ts` (`resolveKeepDecision`, `resolveKeepForAgent`) |
| Config (`config.json`, refreshed on `session_start`) | `pi-extension/subagents/config.ts` (fresh reads + cache invalidate; strict `getExtensionConfig` for tool paths, last-good `getSafeExtensionConfig` for render/timer paths; parse/validate in `status.ts`: `parseTabsConfig` / `parseStatusConfig`, unknown keys warn-and-ignore, wrong types throw) |
| Child liveness (writer) / classification / bridge | `pi-extension/subagents/activity.ts` → `status.ts` → `status-bridge.ts` (`observeRunningSubagent`, `activityLabel`) |
| Session files | `pi-extension/subagents/session/` via the `session.ts` barrel (`io`, `index-cache` — quarantined, do not build on it, `registry` — `version` marker + corrupt backups, `loadout` — `isValidSubagentLoadout` refuses bad snapshots, `seed`, `stats` — `summarizeEntriesStats` for single-read completions, `types`; dead branch ops quarantined in `legacy-branch.ts` — do not use) |
| Child-side pure policy | `pi-extension/subagents/subagent-done-pure.ts` (`subagent-done.ts` is extension wiring: auto-exit, `.exit`/`.done`/`.ask`, `ask_question` tool) |
| Terminal contact (+ async variants, corrupt-drop log) | `pi-extension/subagents/kitty.ts` (`sendCommand`/`sendCommandAsync`, `closeSurface`/`closeSurfaceAsync`, `takeCompletionSidecar`, `logCorruptDrop` + `corruptDropCountsForTest`) |
| Session lifecycle (recovery, sweep, per-session UI, ask queue) | `pi-extension/subagents/index.ts` (`resurrectRunningTab` / `decideResurrectAction`, `sweepStaleArtifacts`, `sessionCtxs`, `promotePendingAskFile` / `restoreAskClaimNoClobber`, `steerSubagent` / `steerSubagentAsync` sharing `flattenSteerMessage`) |
| Slugs/paths | `pi-extension/subagents/names.ts` (`slugifyName`, `uniqueRunningName`) / `paths.ts` (`getSubagentsDir`, `getArtifactDir`) |
| Opt-in guardrail tool | `pi-extension/subagents/tools/safe-bash.ts` (scans `$()` / backtick / `${}` bodies; intentional overblocks pinned in comments) |
| Child stop-hook (Claude path) | `pi-extension/subagents/plugin/hooks/` (`hooks.json`, `on-stop.sh` — serializes non-string fields, never aborts) |

Docs — read in this order; first three are the living contracts:

1. `docs/HOW-IT-WORKS.md` (flows, reserved sidecar-suffix registry, kept-tab/human-driving contract), `README.md` (tools/config/frontmatter reference)
2. `docs/EXIT-KEEP-PRECEDENCE.md` (keep/exit contract + config reference), `docs/LIFECYCLE-LESSONS.md` (supervision rules), `docs/KITTY-LESSONS.md` (terminal rules, persisted-handle re-validation)
3. Reference: `docs/AGENT-OPTIONS.md`, `docs/YAML-options/NESTED-SPAWNING.md` (`subagent_agents` gate), `docs/YAML-options/SYSTEM-PROMPT.md` (`system-prompt` modes)
4. Archive (history, intentionally stale — consult the living contracts first): `docs/KITTY-TABS-ANALYSIS.md` (pre-migration record + follow-on ledger §12), `docs/ASK-QUESTION-FINDINGS.md` (kept-tab round-trip incident, superseded by `LIFECYCLE-LESSONS.md`)

Config: copy `config.json.example` → `config.json` (gitignored). Applies on
`/reload`, no pi restart needed.

## Rules that will bite you

1. **Single home, no second builders.** Never duplicate command assembly, formatters, or label logic — the last duplication (`cli/pi.ts`, `buildClaudeParts`) was deleted on purpose. If two places build the same string, one of them is the bug. Sync/async pairs (`steerSubagent`/`steerSubagentAsync`, `maybeCloseSurface` pair, `sendCommand` pair) share one core helper — never reimplement logic across the pair.
2. **Shell quoting is load-bearing.** All command assembly goes through `shellEscape` (`pi-extension/subagents/kitty.ts`); kitty `--match` only ever takes numeric `id:` (`matchFor`), and persisted handles are re-validated through it at every use. Preamble comments are sanitized at the sink (`sanitizeScriptPreamble`) *and* `name`/`cwd` are rejected at the tool boundary — cover every preamble site, not just the helper. When moving builder code, snapshot-test the exact command string before/after — byte-identical first, refactored second.
3. **Registry + sidecar formats are compat boundaries.** `subagent-registry.json` persists across restarts and carries a `version` marker (readers ignore it as an entry, writers carry it over); corrupt registries are backed up, never clobbered. `.exit` wins over `.done`, both delete-on-read and fire once (claimed atomically in `pi-extension/subagents/kitty.ts:takeCompletionSidecar`). Claim sidecars/`.ask` files via rename-before-read, never check-then-act. Torn JSONL lines are skipped, never fatal. New filename suffixes go in the protocol-registry comment in `index.ts` + `docs/HOW-IT-WORKS.md` — never reuse a reserved suffix.
4. **`Symbol.for` globals survive `/reload` by design.** `WIDGET/STATUS_INTERVAL_KEY`, `POLL_ABORT_KEY` (`pi-extension/subagents/index.ts`), `RUNNING_CHILDREN_COUNT_KEY` (`index.ts` + `subagent-done-pure.ts`), the tool-extensions map (`agents.ts`), `__pi_interactive_subagents` — do not "clean these up" into module locals. A literal-pinning test guards renames. Related: the process-global poll controller is rotated only at import; per-session UI lives in `sessionCtxs`, and `session_shutdown` forgets only its own context, clearing shared timers only when no runs remain.
5. **Config: loud types, lenient keys.** Wrong *types* on known keys throw to the tool path (framework hooks log + degrade); unknown keys warn-and-ignore so newer configs don't hard-fail older extensions. `config.ts` falls back to defaults only when no config file exists — don't reintroduce silent total-fallback. Render + 1s-timer paths use non-throwing `getSafeExtensionConfig()` (last-good-or-defaults); tool paths stay strict. `status.lineLimit` is a validated positive int; absent `status` means defaults.
6. **`safe_bash` is opt-in best-effort, not a sandbox.** Baseline `bash` is pi's native tool, unwrapped; the wrapper (`pi-extension/subagents/tools/safe-bash.ts`) loads only when listed and its regexes are bypassable. Never present it as enforced.
7. **Names are unique per spawner session** (running + reserved + registry; explicit names dedupe `X` → `X-2` via `uniqueRunningName` in `pi-extension/subagents/index.ts` / `names.ts`, keyed per-session by `keptKey` in `store.ts`). Resume reserves the name *before* the stale-sidecar unlink + shell-ready delay and re-checks after (never double-open one `.jsonl`). Never steer by `Array.find` — use `resolveRunningByName` (`store.ts` + `index.ts`) so ambiguity errors. Never resume into a live tab (two writers corrupt one `.jsonl`); steer instead.
8. **Control-plane failure ≠ tab gone.** `windowExistsOrNull()` (`pi-extension/subagents/kitty.ts`, tri-state) — prune/report-death only on positive absence; on unknown, keep entries and refuse double-open. `pollForExit` probes liveness on repeated read failures (`false` ⇒ tab-death error, `null` ⇒ keep polling); `sendCommand`'s pre-check is advisory (TOCTOU). Steers get one retry on control-plane-unknown; dead tabs fail fast.
9. **Tests:** add regression tests with the fix (`test/bugfixes.test.ts` for cross-cutting bug fixes, or the module's suite). Keep `__test__` exports working — `test/test.ts` imports internals through it. Every corrupt-drop path logs via `logCorruptDrop` (stable `[pi-subagents corrupt-drop]` prefix + counter) — never drop a signal silently.

## Pitfalls (never do these)

- Never shell out to `kitty @` outside `pi-extension/subagents/kitty.ts` — transport (`--to $KITTY_LISTEN_ON`), id validation, existence check, extent choice, and error wrapping live in exactly one place.
- Never match by title (regex, non-unique, child-controlled) — always numeric `--match id:<n>`.
- Never put message bytes in argv — payloads go via `--stdin`, submit with a separate `send-key enter`; steer text still flattens newlines first.
- Never unlink `.ask`/`.exit`/`.done` before a successful send — send-then-delete so a failed send retries next tick.
- Never restore a claim over a live file — `restoreAskClaimNoClobber` parks as `.pending-*` when a newer `.ask` exists; the queue drains next tick.
- Never double-watch a session — recovery skips tracked/kept entries (`decideResurrectAction`); resume never starts while a watcher lives.
- Never trust the module-global `latestPi` for delivery — thread the spawner's own `pi` into watchers/monitors.
- Never sweep outside the spawner's artifact dir, and never sweep the registry, transcripts, or live sidecars — `sweepStaleArtifacts` has a claim grace period so reload can't race a live tick.

## Common tasks

- **New agent frontmatter field** → parse in `pi-extension/subagents/agents.ts`, thread through `SubagentLoadout` (`pi-extension/subagents/session/loadout.ts`) if resume must replay it, document in `README.md` frontmatter reference + `docs/AGENT-OPTIONS.md` (or `docs/YAML-options/NESTED-SPAWNING.md` / `SYSTEM-PROMPT.md` for those fields).
- **New bundled agent** → add `agents/<name>.md` (discovery priority: project `.pi/agents/` > global `~/.pi/agent/agents/` > bundled; see `agents.ts` tiers + spawn gate).
- **New config key** → `pi-extension/subagents/status.ts` parse/validate (known keys strict, unknown keys warn-and-ignore) + `config.ts` + example (`config.json.example`) + `docs/EXIT-KEEP-PRECEDENCE.md` config reference.
- **New sidecar/claim suffix** → add to the protocol-registry comment in `index.ts` + `docs/HOW-IT-WORKS.md` signals section; teach `sweepStaleArtifacts` whether it is swept or kept.
- **New corrupt-drop path** → route through `logCorruptDrop` (kind + path + reason) so the counter test covers it.
- **New notification shape** → `pi-extension/subagents/notifications.ts` helper + renderer in `index.ts`; keep `{triggerTurn: true, deliverAs: "steer"}` in the helper, data at call sites.
- **Child-side behavior** → pure policy in `pi-extension/subagents/subagent-done-pure.ts` (testable), wiring in `subagent-done.ts`; remember `awaitingAnswer` clears on both `input` and `agent_start`, and exit defers while children run (`RUNNING_CHILDREN_COUNT_KEY`).
