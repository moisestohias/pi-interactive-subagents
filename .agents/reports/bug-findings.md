# Bug findings — pi-interactive-subagents

Review-only pass. No source edited. Evidence below is code refs + trigger steps + impact + suggested fix.
Conventions: `index.ts` = `pi-extension/subagents/index.ts`. Line numbers are approximate (±15).

# Summary

| Severity | Count |
|---|---|
| Critical | 1 |
| High | 6 |
| Medium | 11 |
| Low | 10 |
| **Total** | **28** |

Plus: # Compat risks (7 items) and # Tests to add (mapping to suites).

---

# Critical

## C1 — Shell injection via subagent display `name` into launch/resume script preamble

- Files:
  - `pi-extension/subagents/index.ts` ~1282–1290 (launch `sendLongCommand(..., { scriptPreamble: scriptPreambleForCanonical("launch", { name: params.name, ... }) })`)
  - `pi-extension/subagents/index.ts` ~2314–2322 (resume `scriptPreambleForCanonical("resume", { name, ... })`)
  - `pi-extension/subagents/launch.ts` ~68–81 (`scriptPreambleFor` interpolates `meta.name`, `meta.sessionFile`, `meta.surface`, `meta.resumeMsgFile` raw into `# …` lines)
  - `pi-extension/subagents/kitty.ts` `sendLongCommand` (writes `preamble + "\n" + command` to a file and executes it with `bash <script>`)
- Trigger/repro:
  1. Call `subagent({ agent: "scout", name: "x\ntouch /tmp/pwned-from-name\n#", task: "hi" })`. `name` is LLM-controlled tool input; only `.trim()` is applied before use, interior newlines survive, and `uniqueRunningName` preserves them (appends `-2` at most).
  2. `scriptPreambleFor` emits `# Subagent launch script for x\ntouch /tmp/pwned-from-name\n#…` — the injected line is no longer a comment once written to the script file.
  3. `sendLongCommand` runs it via `bash`. Same vector on the resume path, where `name` comes from the persistent registry (so one malicious spawn poisons every later resume of that name).
  4. Secondary interpolations with the same flaw: `sessionFile`/`resumeMsgFile` derive in part from `params.cwd` (LLM-controlled, `resolveSubagentPaths` → `join()` preserves `\n`), and land in the same comment block.
- Impact: arbitrary shell execution as the user on spawn and on every resume. This is the only true RCE-shaped finding in this pass.
- Suggested fix: sanitize inside `scriptPreambleFor` (single home): strip `\r\n` from every interpolated field (e.g. `String(v).replace(/[\r\n]+/g, " ")`), and/or use `slugifyName(name)` for the comment. Add a regression test that passes `"a\ntouch /tmp/x\n#"` and asserts the emitted preamble is a single comment line per field. Validate `params.name`/`params.cwd` at the tool boundary too (reject control characters).

---

# High

## H1 — `pollForExit` never detects tab death: closing a running tab hangs the watcher forever

- Files: `pi-extension/subagents/kitty.ts` ~412–end (`pollForExit`); callers `index.ts` ~1456 (`watchSubagent`), ~613 (`monitorKeptTab`).
- Trigger/repro:
  1. Spawn a subagent, then close its kitty tab while it runs (or kill kitty / crash).
  2. The loop only checks: completion sidecars → Claude sentinel file → `readScreenAsync` for `__SUBAGENT_DONE__`. On a dead window `get-text` throws every tick; the `catch` only re-checks sidecars and loops. There is no `windowExistsOrNull` probe anywhere in the loop.
  3. No sidecar/sentinel ever appears (the `; echo DONE` suffix dies with the shell), so the watcher polls forever: widget row stuck, `runningSubagents` entry leaked until session shutdown/reload, no `subagent_result` ever fires, and resume-by-name degrades to “still running → steer” into a dead tab.
- Impact: silent permanent hang per closed tab; contradicts KITTY-LESSONS §2 (“the next 1s poller tick surfaces the death anyway”) — nothing in this loop surfaces death.
- Suggested fix: probe liveness in the loop (e.g. every tick or every Nth tick / after K consecutive `get-text` failures): `windowExistsOrNull(surface) === false` → return `{ reason: "error", exitCode: 1, errorMessage: "tab closed …" }`; `null` (control-plane unknown) → keep polling (N3). Unit-test with an injected liveness fn.

## H2 — Registry read-modify-write loses entries under parallel spawn

- Files: `pi-extension/subagents/session/registry.ts` (`registerName`: `readNameRegistry` → mutate → tmp+rename).
- Trigger/repro: fire two `subagent` calls in one block (the documented, encouraged pattern). Both `execute` bodies read `{}` before either writes; A writes `{A}`, B writes `{B}`, clobbering A. The completion-time re-`registerName` repeats the pattern (read → write), so the loser’s handle can stay missing permanently.
- Impact: `subagent_message({ name })` for the loser fails with “No subagent named …” even though it ran; completion re-registration can re-clobber concurrently finishing runs.
- Suggested fix: serialize registry writes in-process (a mutex/queue around `registerName`, or a per-artifact-dir write chain) and/or store one file per name (`registry.d/<name>.json`, atomic rename per key, `readNameRegistry` merges) so concurrent writers touch disjoint paths. Regression test: two overlapping `registerName` calls preserve both keys (needs a barrier to force the interleave, or test the new merge function directly).

## H3 — Child writes `.exit`/`.done` non-atomically; parent’s rename-claim can eat a torn signal

- Files:
  - Writer: `pi-extension/subagents/subagent-done.ts` (`agent_end`: `writeFileSync(${sessionFile}.exit/.done, …)` direct).
  - Reader: `pi-extension/subagents/kitty.ts` `takeCompletionSidecar` (`.exit` claimed via rename, then parsed; corrupt claim is deleted).
- Trigger/repro: the parent 1s tick lands inside the child’s open-truncate-write window. The parent renames a partially-written file, `JSON.parse` fails, the claim is `rm`’d as “corrupt” — while the child’s remaining bytes go to the renamed inode (lost). The `.ask` path already fixed exactly this with tmp+rename (`writeAskSignalAtomic`, C3); `.exit`/`.done` never got the same treatment.
- Impact: an error signal (`.exit`) is silently consumed → parent falls through to `.done`/sentinel path and may report success or hang (keep-open runs have no sentinel fallback — the child stays interactive, so a lost `.done` hangs the spawn watcher until tab close). Same for `.done` on keep runs.
- Suggested fix: write `.exit`/`.done` via tmp+rename in `subagent-done.ts` (reuse the `writeAskSignalAtomic` pattern). Keep the parent’s claim-then-parse.

## H4 — `session_shutdown` tears down process-global timers; `latestCtx`/`latestPi` are last-writer-wins (multi-session breakage)

- Files: `index.ts` ~134–160 (module-level `widgetInterval`/`statusInterval` + `Symbol.for` keys), `latestCtx`/`latestPi`, `session_start` handler (~1590+), `session_shutdown` handler (~1647+).
- Trigger/repro: run two pi sessions in one process (explicitly supported per LIFECYCLE §6, which keys kept-tabs by artifact dir). Close session A: `session_shutdown` clears `widgetInterval`/`statusInterval` and their `Symbol.for` keys globally, killing session B’s widget refresh and stall/recovery supervision. Meanwhile `latestCtx`/`latestPi` always point at whichever session started last, so B’s widget renders into A’s UI and orphan-question delivery can target the wrong session (the threaded-`pi` fixes cover watchers/monitors, but not the widget/timers).
- Impact: one session exiting silently disables live UI + status notifications for all surviving sessions in the process.
- Suggested fix: scope timers per spawner session (map keyed by artifact dir) or refcount owners; on shutdown only tear down that session’s timers. Route widget updates to the owning session’s ctx. Regression test: simulate two `session_start`s + one `session_shutdown`, assert the survivor’s timers still run.

## H5 — `/reload` orphans in-flight non-kept runs (watchers not rebuilt, surface handle not persisted)

- Files: `index.ts` `session_start` handler (~1590–1645: replays orphan `.ask` + re-attaches *kept* monitors only); spawn `registerName` at launch (stores `sessionFile`+`sessionId`, no `surface` for normal runs); `SubagentStore` is per-import (fresh empty maps after reload) while `Symbol.for` abort/timers survive by design.
- Trigger/repro: spawn a subagent, `/reload` before it finishes. The new module has an empty `running` map; `session_start` only resurrects kept tabs (registry `surface`) and orphan questions. The still-live tab has a watcher in the dead module (aborted) and none in the new one.
- Impact: the run’s result is never delivered, its widget row is gone, its tab leaks unsupervised; `.ask` recovery may still fire questions (with `elapsed 0s`, see L3) but completion is lost. Users experience “subagent vanished after reload”.
- Suggested fix (pick one, document the other): persist `surface` for running runs at launch and re-`watchSubagent` them on `session_start` (with stale-`.done`/`.exit` hygiene); or make this a documented limitation with a loud `subagent_status` steer listing resurrected-vs-orphaned runs. Either way, never leave a live tab with no owner silently.

## H6 — Parallel resume of the same name double-opens one `.jsonl` (no reservation on the resume path)

- Files: `index.ts` `subagent_message` resume branch (~2180–2360): running-check (`for r of runningSubagents … resolve compare`), kept-tab check, stale-sidecar unlink, then `createSurface` + `sendLongCommand` + `runningSubagents.set` — all check-then-act with `await`s (shell-ready delay) in between. Spawn path reserves names synchronously (`reservedNames`); resume reserves nothing.
- Trigger/repro: two concurrent `subagent_message({ name: "X", … })` calls (model retry, or two turns racing). Both pass the “still running?” scan before either registers, both launch `pi --session <same file>`.
- Impact: two pi processes appending to one session `.jsonl` — the exact corruption the guard comment says must never happen.
- Suggested fix: reserve the resume name synchronously (reuse `reservedNames`/`SubagentStore.reserve`: `reserve("resume::<artifactDir>::<name>")` before the first `await`, release on registration/failure) and re-check guards after the shell-ready delay, immediately before sending.

---

# Medium

## M1 — `.done` consumed without atomic claim (`.exit` claims, `.done` doesn’t)

- Files: `kitty.ts` `takeCompletionSidecar` (`.exit`: rename-claim; `.done`: `existsSync` + `rmSync`).
- Trigger: two consumers observe the same `.done` — spawn-watcher 1s tick vs kept-monitor 2s tick vs `session_start` recovery running concurrently. Both can return `done` → double delivery / a second `.done` (see M9) killing kept supervision early.
- Fix: claim `.done` via rename exactly like `.exit`. Test: concurrent `takeCompletionSidecar` calls deliver once.

## M2 — Failed question delivery restores the claim over a newer `.ask`, destroying the newer question

- Files: `index.ts` `claimAskFile` + `deliverPendingQuestion` restore paths (`renameSync(claim, askFile)` on no-target and on send-throw).
- Trigger: Q1 claimed; before restore, the child asks Q2 (`writeAskSignalAtomic` creates a fresh `.ask` since the target is momentarily absent); the Q1-failure restore renames over Q2. Q2 is lost without a trace.
- Fix: restore with no-clobber semantics (rename to `.ask` only if absent, e.g. `link`/`rename` with existence check loop, or write to a `.pending-N` queue file the next tick drains). Never overwrite an existing `.ask`.

## M3 — Cancelled runs still steer a notification (possibly into a dead session); notify-throw escapes as unhandled rejection

- Files: `index.ts` `watchSubagent` abort branch (~1567: returns `{ summary: "Subagent cancelled.", error: "cancelled" }` instead of throwing) → spawn `.then` (~1880) and resume `.then` (~2383) call `notifyResultCanonical(pi…)` even during shutdown; if that `sendMessage` throws, `.catch` (~1897, ~2397) calls `notifyErrorCanonical`/`pi.sendMessage`, which can throw again with no further handler.
- Trigger: close the session / shutdown while runs are in flight; watch the framework log for unhandled rejections and/or “cancelled” steers firing into a dead session.
- Fix: in the completion handlers, skip all notification when `result.error === "cancelled"` (or the watcher signal aborted); wrap every `notify*` call in try/catch.

## M4 — Invalid config throws inside render/timer paths, not just tool paths

- Files: `index.ts` ~712 (`renderSubagentWidgetLines` → `getExtensionConfig().status.enabled`), ~895/~931 (`startStatusRefresh`), `shouldKeep*` (~399–409); `status.ts` `parseExtensionConfig` (requires a `status` object — a tabs-only `{ "tabs": {…} }` config throws); `config.ts` (only missing-file falls back).
- Trigger: `config.json` with `{ "tabs": { "keepOpen": true } }` and no `status` section, or any schema violation. Spawns fail loudly (intended per AGENTS.md §5), but the widget render callback and the 1s status timer also throw — inside the TUI render loop / timer, which can break the whole UI rather than one tool call.
- Fix: default absent `status`/`tabs` sections independently (missing section ⇒ defaults, present-but-invalid ⇒ throw); use the safe/cached config in render + timer paths so a bad file degrades to last-good instead of throwing per frame.

## M5 — Resume trusts the `.loadout.json` sidecar; `toolAllowlist: null` relaunches unrestricted, and the child can rewrite its own loadout

- Files: `pi-extension/subagents/session/loadout.ts` (`readSubagentLoadout`: shape-unchecked cast); `index.ts` resume (~2260+: `applySandboxToParts(parts, loadout, …)` skips `--no-extensions/--tools` when `toolAllowlist` is null); `launch.ts` `applySandboxToParts`.
- Trigger: current spawns always write non-null allowlists, but any hand-crafted / legacy / child-modified sidecar with `toolAllowlist: null` resumes with the parent’s full extensions + toolset. The child knows its session path (`PI_SUBAGENT_SESSION`) and has `write`/`edit`/`bash`, so it can null its own allowlist before the parent resumes it.
- Fix: validate the loadout on read (required types; `toolAllowlist` must be a non-empty string — otherwise refuse resume or re-derive from the agent definition); consider making resume recompute the sandbox from the agent profile and only use the snapshot as a cross-check.

## M6 — A corrupt registry is silently clobbered by the next write

- Files: `session/registry.ts` (`readNameRegistry` returns `{}` on corrupt with warn-once; `registerName` then writes `{ [newName]: entry }`).
- Trigger: one torn write / disk-full / manual edit → next spawn or completion permanently discards every prior name→session handle for that spawner session.
- Fix: on corrupt read, preserve the bytes (`subagent-registry.json.corrupt-<ts>`) and — if any entries are salvageable — merge rather than overwrite; at minimum refuse to overwrite a corrupt registry without a backup.

## M7 — Resume “new entries” window skews when the transcript has torn lines

- Files: `index.ts` resume (~2242: `entryCountBefore = countSessionEntryLines(sessionPath)` counts every non-blank line) vs completion (~2386: `getNewEntries(sessionPath, entryCountBefore)` slices the *parsed* array, which excludes torn lines).
- Trigger: any torn line before the resume point shifts the slice by the skipped count → the follow-up summary can miss the first new message(s) or include a stale one.
- Fix: capture the baseline with `readEntriesAfter(sessionPath, 0).total` (same counting basis as the later slice), or store the parsed length.

## M8 — Runtime tool-extension registrations are lost on `/reload`

- Files: `pi-extension/subagents/agents.ts` (`EXTRA_TOOL_EXTENSIONS` is a module-local `Map`; only the `registerToolExtension` *function pointer* is published on `globalThis.__pi_interactive_subagents`).
- Trigger: project-local extension registers a custom tool → `/reload` re-imports the module (fresh empty map, global fn overwritten) → the tool’s `-e` path no longer resolves (`getToolExtensionPath` returns `undefined`, silently dropped from the child command) while the old registration object still references the dead map.
- Fix: hold the map itself on a `Symbol.for` global (like the other reload-surviving state) so registrations persist across imports.

## M9 — A kept tab’s second `.done` (e.g. after `/reload` in the child) silently ends kept supervision while the tab is still alive

- Files: `subagent-done.ts` (`completionSignaled` is in-memory only) + `index.ts` `monitorKeptTab` (~613: `pollForExit` watches the same `sessionFile`, and any `done` result falls into the “clean close is silent” + `untrackKept` + `clearKeptSurface` path).
- Trigger: `/reload` (or any module re-import) inside a kept tab resets `completionSignaled`; the next turn end writes `.done` again; the parent’s kept monitor consumes it as completion and unregisters the tab. Later `ask_question`s from that live tab sit orphaned until the parent’s next `session_start` recovery.
- Fix: make the kept monitor ignore `.done` (watch `.exit` + `.ask` only after the first result), or persist the fired flag next to the session (e.g. only write `.done` if no `.done-consumed` marker / registry flag exists).

## M10 — Env-prefix assembly has re-duplicated into three variants that already drift

- Files: `index.ts` ~1217–1244 (launch, inline), `index.ts` ~2278–2299 (resume, inline — different key order, `AUTO_EXIT` last, **omits `PI_SUBAGENT_SURFACE`**), `launch.ts` ~50–66 (`buildEnvPrefix`, canonical but used by neither; its test pins “historical order” while the two live paths disagree on `AGENT`-vs-`NAME` order). Scrub prefix likewise duplicated as a literal instead of `SCRUB_PREFIX`.
- Impact today: benign (`SURFACE` is documented write-only; order is cosmetic) — but this is exactly the “two places build the same string, one is the bug” pattern from AGENTS.md §1, already re-grown.
- Fix: route launch + resume through `buildEnvPrefix` (+ `SCRUB_PREFIX` + `buildCdPrefix`/`withDoneSentinel`, which are already shared); extend `launch.test.ts` order test to assert the three call sites produce identical prefixes for identical inputs.

## M11 — Sync kitty spawns on the steer/close path block the extension host

- Files: `kitty.ts` (`sendCommand` = `ls` + `send-text` + `send-key` via `execFileSync`; `closeSurface`, `createSurface`, `readScreen` sync); completion handlers call `maybeCloseSurface` → `closeSurface` synchronously.
- Impact: every steer pays 3 blocking process spawns; tab close blocks result delivery. Responsiveness only — but the codebase already has async variants (`readScreenAsync`, `kittenAsync`) for the hot poll loop, so the pattern exists.
- Fix: add/adopt `sendCommandAsync` + `closeSurfaceAsync` for steer/completion paths; keep sync versions for startup/tests.

---

# Low

## L1 — `safe_bash` `${…}` expansions unscanned despite the comment claiming otherwise; documented bypasses + overblocks

- Files: `tools/safe-bash.ts` (`hasBlockedSubstitution` comment says “$() , ``, `${}`” but only scans `$()` and backticks; `BLOCKED_IN_SUBSTITUTION` never sees `${sudo}`/`${IFS}` tricks). Separately: `rm -rf "$HOME"` / `rm -rf ..` / `bash <(curl …)` / `python3 -c …` bypass (acknowledged best-effort), while `chmod 777 /tmp/x` and read-only `dd if=…` overblock.
- Fix: either scan `${…}` bodies too or correct the comment; keep the “not a sandbox” framing (already good). Tests: `${…}` case in `bugfixes.test.ts` M9 block.

## L2 — Claude Stop hook degrades non-string `last_assistant_message` (python repr / `[object Object]` sentinel)

- Files: `plugin/hooks/on-stop.sh` (`json_field` prints `str(value)`; node fallback `console.log(obj)`).
- Trigger: Claude emits structured `last_assistant_message` → sentinel file contains a python-dict repr, shown verbatim as the parent-side summary.
- Fix: `json.dumps` non-string values in the python branch (and `JSON.stringify` in node) so the sentinel stays valid JSON/text.

## L3 — Recovered orphan questions report `elapsed 0s`

- Files: `index.ts` `recoverPendingQuestions` (synthesizes `startTime: Date.now()`).
- Trigger: question orphaned across reload → parent sees “asks (0s)” regardless of actual age (cf. LIFECYCLE §8, which fixed this for kept tabs but not recovery).
- Fix: derive elapsed from the `.ask` file mtime or the registry entry; cosmetic only.

## L4 — Dead import `windowExists` in `index.ts`; legacy boolean wrapper is a prune-footgun

- Files: `index.ts` ~31 (imports `windowExists`, never used — all prune paths correctly use `windowExistsOrNull`); `kitty.ts` ~218 (`windowExists` maps control-plane failure → `false`).
- Fix: drop the unused import; keep the “prefer `windowExistsOrNull` in prune paths” comment (already present) so no future caller adopts the lossy wrapper.

## L5 — Session-id index is write-only dead code with a perf trap and a silent-ambiguity prefix match

- Files: `session/index-cache.ts` (`getSessionIndex` calls `indexDir` on *all* branches, so the top-level signature never short-circuits — every lookup walks the whole tree with sync `readdir`+`stat`; `lookupSessionIndex` prefix-matches and silently returns newest-mtime on collision). No production callers (only barrel re-export + tests).
- Fix: either adopt it properly (early-out on unchanged signature, surface ambiguity instead of newest-wins) or quarantine it with `legacy-branch.ts` so nobody builds on it.

## L6 — Long steers go over the char-stream path (wrap-break risk from KITTY §4 applies)

- Files: `index.ts` `steerSubagent` (flattens newlines, then `sendCommand`) — no `sendLongCommand`/script-file equivalent for steers.
- Trigger: multi-KB steer message; terminal line-wrapping can mangle bytes the way launch avoided via script files.
- Fix: document a practical size cap for `subagent_message`, or type long steers via a temp file the child sources. Low priority (steers are human-scale today).

## L7 — Launch/resume artifacts never GC’d (unbounded growth per run)

- Files: `index.ts` launch (`context/…-sysprompt-…`, `context/<name>-<ts>.md`, `subagent-scripts/…`), resume (`subagent-resume/…`), activity files (`subagent-activity/<id>.json`, orphaned on resume since resume mints a new id).
- Fix: best-effort cleanup on completion (keep last N per subagent, or sweep files older than X in `session_start`).

## L8 — Claude backend hardening gaps (predictable sentinel, unvalidated transcript copy, no sandbox/resume)

- Files: `cli/claude.ts` (`/tmp/pi-claude-<8-hex>-done` ≈ 32-bit, squattable; `copyClaudeSession` copies whatever path the sentinel names — basename-jailed but content-unvalidated); `index.ts` Claude launch (~1115–1160: no `--tools` allowlist, no loadout snapshot, no `PI_SUBAGENT_*` identity/activity env) → Claude runs can’t resume (loadout-missing refusal) and are status-blind.
- Fix: `0600` sentinel + transcript-path allowlist (must live under known transcript dirs); document Claude runs as spawn-only, or persist a Claude loadout so resume works uniformly.

## L9 — `userTookOver` tracked but ignored: auto-exit tabs can shut down under an interacting user

- Files: `subagent-done-pure.ts` `shouldAutoExitOnAgentEnd` (param kept, behavior documented as ignored in the M8 comment) + `subagent-done.ts` (`userTookOver` reset logic).
- Impact: typing in an auto-exit child’s tab doesn’t prevent `ctx.shutdown()` when the turn ends — the tab vanishes mid-interaction. Contractually documented, so filed as Low/awareness: make sure user-facing docs tell humans to only drive kept tabs.

## L10 — `/subagent` slash command bypasses the spawn allowlist gate

- Files: `index.ts` `/subagent` handler (`loadAgentDefaults` directly; the `PI_SUBAGENT_ALLOWED` / known-agent gate lives only in the `subagent` tool `execute`).
- Assessment: acceptable (invoker is the local human, children can’t invoke slash commands — they only type into their own tab). Noted for completeness; no change needed unless command invocation is ever delegated.

---

# Compat risks

1. **Mixed-version upgrade window is lossy.** The new parent assumes atomic `.ask` (drops non-JSON claims as corrupt) while pre-C3 children write `.ask` directly: a partial flush from an old child is *deleted* by a new parent instead of retried. Likewise the new `.exit`-claim logic deletes torn `.exit`s that an old parent would have retried. Rolling upgrades (new parent + old running child) can lose exactly one question/error signal. Mitigation: version-gate the drop-corrupt path, or retain-then-retry once before deleting.
2. **`subagent-registry.json` is append-only-by-overwrite with no schema version.** Any future field change must remain backward readable (current readers tolerate extra keys; writers overwrite whole file — an old writer downgrades new fields silently). Add a `version` field sooner rather than later, and make writers merge unknown keys.
3. **Sidecar filenames are a protocol (`${session}.exit/.done/.ask/.loadout.json`, `.consuming-*`, `.tmp-*`).** Stale `.consuming-*`/`.tmp-*` files from crashed processes are never swept (see L7) and could collide with future suffixes; document all suffixes as reserved and sweep them in `session_start`.
4. **`Symbol.for` / string-global keys are a compat surface** (`pi-subagents/widget-interval`, `pi-subagents/status-interval`, `pi-subagents/poll-abort-controller`, `pi-subagents/running-children-count`, `__pi_interactive_subagents`). Renaming any of them orphans pre-reload state the same way the original `/reload` bug did. Pin them with a test asserting the literal key strings.
5. **Config strictness breaks forward compat.** `rejectUnsupportedKeys` in `status.ts` means a config written by a newer version (new key) hard-fails an older extension. Prefer warn-and-ignore for unknown keys; keep loud failure for wrong *types*.
6. **Seeded session header (`session/seed.ts` writes `{ type: "session", version: 3, … }`)** tracks pi’s internal session format by hand. If pi bumps the session schema, `fork`/`lineage-only` children start from a stale-shaped header while normal children get the current shape — silent divergence. Re-check against the installed pi version periodically (or seed via pi itself).
7. **`--match id:` + numeric-only surfaces** (kitty §3) is load-bearing for the “never type into the main session” guarantee: any future non-numeric surface handle must go through `matchFor`, never around it. The resume path’s `entry.surface` (persisted string from an older version) is validated at use — keep that validation on every new use of a persisted handle.

---

# Tests to add

Map to `test/bugfixes.test.ts` unless noted (follow the file’s existing `describe` blocks; new `describe`s where indicated).

| # | Test | Suite / block |
|---|---|---|
| C1 | `scriptPreambleFor` with `name: "a\ntouch /tmp/x\n#"` (+ cwd/session paths with `\n`) emits no executable lines (every line starts with `#`); tool-boundary rejects control chars in `name`/`cwd` | `test/launch.test.ts` (extend preamble block) + new `describe("C1 preamble injection")` in `bugfixes.test.ts` |
| H1 | `pollForExit` with injected liveness `() => false` resolves error promptly; `() => null` keeps polling | `test/test.ts` (near `__pollForExitTest__` blocks) or `bugfixes.test.ts` new `describe("H1 tab-death detection")` (needs seam: accept `exists` param) |
| H2 | overlapping `registerName` calls preserve both keys (barrier-forced interleave, or test the new serialized writer) | `bugfixes.test.ts` `describe("H2 registry merge")` |
| H3 | child sidecar writer uses tmp+rename (assert no partial read: write-then-claim round-trip under forced interleave, or assert `write…Atomic` helper used) | `bugfixes.test.ts` `describe("H3 atomic sidecars")` |
| H4 | two `session_start`s + one `session_shutdown` leaves survivor timers alive; widget targets owning ctx | `bugfixes.test.ts` `describe("H4 per-session teardown")` (needs timer-ownership seam) |
| H5 | `session_start` rebuild re-watches running runs persisted with `surface` (or asserts the documented-limitation steer) | `test/session-status-split.test.ts` or `bugfixes.test.ts` `describe("H5 reload resurrection")` |
| H6 | concurrent resumes for one name produce one launch (second steers or errors; assert single `createSurface` for the session file) | `bugfixes.test.ts` `describe("H6 resume reservation")` |
| M1 | concurrent `takeCompletionSidecar` on one `.done` delivers once | `test/test.ts` (extend sidecar block) |
| M2 | `deliverPendingQuestion` failure with a newer `.ask` present preserves the newer file | `bugfixes.test.ts` (extend `C3/M4 atomic ask consume` block) |
| M3 | aborted `watchSubagent` produces no `sendMessage` calls; throwing `sendMessage` never rejects | `bugfixes.test.ts` new `describe("M3 cancelled-notify")` |
| M4 | tabs-only config loads with status defaults; widget render + status tick use safe config on invalid file | `bugfixes.test.ts` (extend `M5 status.lineLimit` block) |
| M5 | `readSubagentLoadout` rejects `toolAllowlist: null`/wrong shapes (or resume re-derives) | `test/session-status-split.test.ts` + `bugfixes.test.ts` |
| M6 | corrupt `subagent-registry.json` is backed up, not overwritten, on next `registerName` | `bugfixes.test.ts` new `describe("M6 registry backup")` |
| M7 | `readEntriesAfter` baseline: torn lines before resume point don’t shift the new-entries window | `bugfixes.test.ts` (extend `M3/C4 tolerant JSONL readers`) |
| M8 | `registerToolExtension` survives a module re-import (re-require or Symbol.global-backed map) | `bugfixes.test.ts` new `describe("M8 tool registry survives reload")` |
| M9 | kept monitor ignores a second `.done` while the tab lives (still relays later `.ask`) | `bugfixes.test.ts` new `describe("M9 kept second-done")` |
| M10 | launch/resume/`buildEnvPrefix` produce identical prefixes for identical inputs | `test/launch.test.ts` (extend order test) |
| L1 | `${…}` substitution bodies scanned (or comment corrected); `chmod 777 /tmp/x` disposition pinned | `bugfixes.test.ts` (extend `M9 safe_bash blocks`) |
| Compat | `Symbol.for` key literals pinned; unknown config keys warn (not throw); all sidecar suffixes documented + swept | `bugfixes.test.ts` new `describe("compat pins")` |

Note: 4 tests in `test/test.ts` → `subagent discovery` assert bundled-agent defaults the local `agents/*.md` don’t satisfy — pre-existing per AGENTS.md; left untouched (do not “fix” by editing tests).
