# Kitty tabs migration — signaling-flow analysis

**Question:** can `pi-interactive-subagents` (currently tmux-only) run subagents in kitty tabs instead of tmux panes?
**Verdict: yes, feasible.** The multiplexer is isolated behind a small surface layer (`pi-extension/subagents/tmux.ts`);
almost all parent↔child signaling is **filesystem + pi extension-host messages**, not tmux. Only 7 surface
primitives need a kitty equivalent, and kitty's remote-control protocol (`kitten @`, documented in
`~/.local/kitty.app/share/doc/kitty/html/_sources/`) covers every one of them. Tabs are the right first target
(full-width per agent, no layout rebalancing needed). One environment prerequisite and two behavioral caveats need
handling (see §5).

Environment checked: kitty `0.44.0`, `allow_remote_control yes` already set in `~/.config/kitty/kitty.conf`,
`KITTY_PID`/`KITTY_WINDOW_ID` present, but **no `listen_on` socket** (`KITTY_LISTEN_ON` empty, `kitty @ ls` from a
detached process fails with `open /dev/tty`). Details in §5.1.

> Scope note: per the request, `tmux.ts` is **not** renamed/deleted yet — this file is the analysis deliverable.
> The planned archive step is `git mv pi-extension/subagents/tmux.ts pi-extension/subagents/tmux.ts.archived`
> at implementation time (§7).

---

## 1. Current implementation (what exists today)

| File | Role | Mux-dependent? |
|---|---|---|
| `pi-extension/subagents/tmux.ts` (~280 lines) | **Only** mux layer: create/split pane, type command, read screen, close pane, poll-for-exit, layout rebalance | **Yes — the single file to replace/archive** |
| `pi-extension/subagents/index.ts` (~2500 lines) | Tools (`subagent`, `subagent_message`, `subagents_list`, `/subagent` command), launch/resume command builders, watchers, widget, `pi.sendMessage` steer delivery | Only via imports from `tmux.ts` + 1 error string (`"via tmux"`) |
| `pi-extension/subagents/session.ts` | Session seeding (`lineage-only`/`fork`), name registry (`subagent-registry.json`), sandbox snapshot (`.loadout.json`), session-file parsing/stats | No |
| `pi-extension/subagents/activity.ts` | Child-side activity recorder → parent-side reader (`subagent-activity/<id>.json`) | No |
| `pi-extension/subagents/status.ts` | `starting/active/waiting/stalled/running` classification + stall/recovery transitions | No |
| `pi-extension/subagents/subagent-done.ts` | Child-side extension: auto-exit on `agent_end`, `.exit` sidecar on error, `ask_question` tool (`.ask` file) | No (reads `PI_SUBAGENT_*` env only) |
| `pi-extension/subagents/tools/safe-bash.ts` | Tool allowlist member | No |
| `pi-extension/subagents/plugin/hooks/{hooks.json,on-stop.sh}` | Claude-Code `Stop`-hook → sentinel file | No |
| `test/integration/harness.ts`, `tmux-surface.test.ts`, `subagent-lifecycle.test.ts` | Tests import directly from `tmux.ts` | Yes (test-only) |

`grep` confirms `index.ts` touches the mux **only** through the 7 imported primitives
(`isMuxAvailable`, `createSurface`, `sendCommand`, `sendLongCommand`, `pollForExit`, `closeSurface`, `readScreen`)
plus `shellEscape` (pure string quoting — reusable as-is).

---

## 2. Message / signaling flow (the part that must survive migration)

There are **six** distinct flows between the main (orchestrator) session and a subagent session. Only flow 2a/6
touch the terminal multiplexer; everything else is files or extension-host messages, i.e. **mux-agnostic**.

### Flow 1 — Parent → child: launch (spawn)

Path: `subagent.execute()` → `launchSubagent()` (`index.ts`) → `createSurface()` + `sendLongCommand()` (`tmux.ts`).

1. Validate agent name against allowlist (`PI_SUBAGENT_ALLOWED` for nested spawns, else all discoverable agents).
2. Pick a unique display `name` (`uniqueRunningName`: running map + `reservedNames` + registry keys), reserve it synchronously so parallel spawns don't collide.
3. Pre-compute a deterministic child session file `<sessionDir>/<timestamp>_<uuid>.jsonl`; optionally seed it (`seedSubagentSessionFile`: `lineage-only` = header + `parentSession` link, `fork` = header + parent's turns up to last user message).
4. Allocate an activity file `artifacts/<parentSessionId>/subagent-activity/<id>.json`.
5. Snapshot the resolved sandbox to `<session>.loadout.json` (`SubagentLoadout`: agent, `--tools` allowlist, model+thinking, identity/system-prompt mode, spawn whitelist, autoExit, cwd, agentDir). Resume replays this verbatim.
6. Build the child command:
   - **pi path:** `cd <cwd> && PI_SUBAGENT_NAME=… PI_SUBAGENT_AGENT=… PI_SUBAGENT_AUTO_EXIT=… PI_SUBAGENT_SESSION=… PI_SUBAGENT_ID=… PI_SUBAGENT_ACTIVITY_FILE=… PI_SUBAGENT_SURFACE=… PI_CODING_AGENT_DIR=… PI_SUBAGENT_ALLOWED=… pi --session <file> -e <subagent-done.ts> [--no-extensions --tools … -e <per-tool extensions>] [@<task-artifact.md> | <direct task>] [/skill:…] ; echo '__SUBAGENT_DONE_'$?'__'`
   - Task goes via an artifact file (`@…md`) for `standalone`/`lineage-only`, direct argv for `fork`.
   - **claude path** (`cli: claude` agents): `PI_CLAUDE_SENTINEL=/tmp/pi-claude-<id>-done claude --dangerously-skip-permissions … ; echo '…'` (same sentinel pattern).
7. Write the full command to a launch-script file (`artifacts/…/subagent-scripts/<name>-<id>.sh`) and type `bash <script>` into the fresh surface.
8. Register `runningSubagents.set(id, …)`, persist `name → {sessionFile, sessionId}` in `subagent-registry.json`, start widget/status intervals, and `watchSubagent()` in the background (fire-and-forget). The tool returns immediately ("started").

Mux surface used: **create + type-and-enter only.** Focus must not move (`split-window -d`, split targets `$TMUX_PANE`).

### Flow 2 — Child → parent: completion (the wake-up)

Path: child `agent_end` (`subagent-done.ts`) → `pollForExit()` (`tmux.ts`) → `watchSubagent()` (`index.ts`) → `pi.sendMessage(…, {triggerTurn: true, deliverAs: "steer"})`.

Required signals, in order:

1. **Child side, clean exit:** auto-exit agents call `ctx.shutdown()` at `agent_end`; the shell then prints the **terminal sentinel** `__SUBAGENT_DONE_<code>__` (appended with `; echo …` at launch). No file is written on success.
2. **Child side, error exit** (`stopReason: "error"`, e.g. provider overload after auto-retry): child writes the **`.exit` sidecar** `${sessionFile}.exit` = `{type:"error", errorMessage, stopReason}` *before* shutdown. `ask_question` deliberately does **not** write this file.
3. **Claude path:** `on-stop.sh` (`Stop` hook) writes `$PI_CLAUDE_SENTINEL` (+ `${SENTINEL}.transcript`) only when the transcript shows exactly 1 human message (autonomous completion).
4. **Parent side, `pollForExit` loop (1 s tick):** (a) **fast path** — `${sessionFile}.exit` exists → parse via `interpretExitSidecar`, delete file, return; (b) **sentinel-file path** — Claude sentinel exists → return; (c) **slow path** — `readScreenAsync(surface, 5)` regex `__SUBAGENT_DONE_(\d+)__` → return exit code; read failure (surface destroyed) falls back to re-checking the `.exit` file (crash detection).
5. **Result extraction:** pi path reads the **session `.jsonl`** (`findLastAssistantMessage` for the summary — with `stopReason:"error"` → `errorMessage` fallback — plus `summarizeSessionStats` for tokens/cost and `getSessionId` for follow-ups). Claude path reads the sentinel file, falling back to the last 200 screen lines.
6. **Cleanup + wake-up:** `closeSurface(surface)`, `runningSubagents.delete(id)`, `updateWidget()`, then the extension-host signal (steer semantics per pi docs `extensions.md`: `"steer"` is queued while streaming and delivered after the current assistant turn finishes its tool calls, before the next LLM call; `triggerTurn: true` fires a turn when idle):
   `pi.sendMessage({customType: "subagent_result", content: presentation, details: {name, task, agent, exitCode, elapsed, sessionFile, sessionId?, errorMessage?, stats?}}, {triggerTurn: true, deliverAs: "steer"})` — this is what wakes the orchestrator with a new turn. Rendered by the `subagent_result` message renderer.

**Mux-dependent bits:** step 4c (screen read) and step 6 (pane kill). Steps 4a/4b/5/6-delivery are mux-agnostic.

### Flow 3 — Child → parent: liveness / progress (widget + stall pings)

Path: child recorder (`activity.ts` in child process) → `subagent-activity/<id>.json` → parent `observeRunningSubagent()` + 1 s `statusInterval` (`status.ts`) → widget re-render and/or `subagent_status` steer.

- Child writes `{version, runningChildId, updatedAt, sequence, latestEvent, phase: starting|active|waiting|done, activeScope, toolName, …}` on every agent/turn/provider/tool event (message-updates throttled 500 ms, atomic tmp+rename writes, disables after 3 failures). `wrong-id`/`invalid`/`missing` are distinguished on read.
- Parent classifies to `starting|active|waiting|stalled|running` (stale = no valid snapshot for 60 s; `claude` source is always `running`). `stalled → active|waiting` and `→ stalled` transitions (non-interactive agents only) are delivered as `pi.sendMessage({customType: "subagent_status", …}, {triggerTurn: true, deliverAs: "steer"})`.
- The widget (`setWidget("subagent-status")`, `aboveEditor`, 1 s refresh) reads the same state. **Fully mux-agnostic** — no tmux calls.

### Flow 4 — Child → parent: `ask_question` (park, don't exit)

Path: child `ask_question` tool (`subagent-done.ts`) → `${sessionFile}.ask` → parent `deliverPendingQuestion()` on every `pollForExit.onTick` → `subagent_question` steer → parent replies via `subagent_message`.

- Child sets `awaitingAnswer = true` (suppresses auto-exit for that turn), records `askQuestion()` (phase → `waiting`), writes `.ask` = `{name, agent, question}`.
- Parent's watcher tick sees the file, deletes it (fires once per question), and sends `pi.sendMessage({customType: "subagent_question", content, details: {name, agent, question, sessionId?}}, {triggerTurn: true, deliverAs: "steer"})`. Parallel questions work (one file per session).
- The reply arrives as the child's next turn (see flow 5); `awaitingAnswer` clears on `input` (covers mid-turn steer absorption) and `agent_start` (covers fresh turns). If never answered, the surface stays open. **Fully mux-agnostic.**

### Flow 5 — Parent → child: `subagent_message` (steer running / resume finished)

Same tool, two branches keyed by display `name`:

- **Running → steer:** `handleSubagentSteer()` → `observeRunningSubagent()` → `steerSubagent()` types the message into the live surface (**newlines flattened to spaces** — each newline would submit a partial turn in the child's TUI editor), then `forceStatusAfterInterrupt()` + widget update. Returns an immediate ack; **no new result is emitted** — completion still arrives via flow 2. **This is the second mux-dependent primitive** (`send-keys -l` + `Enter`).
- **Finished → resume:** resolve `name` in `subagent-registry.json` → refuse if unknown/session-file-gone/no-`.loadout.json` (never relaunch unrestricted) → guard against double-running the same `.jsonl` → `createSurface()` a fresh surface → `pi --session <existingFile> -e <subagent-done.ts>` + `applySandboxToParts(loadout)` + `@<resume-msg.md>` + resume env prefix (`PI_SUBAGENT_*` replayed from snapshot, always autonomous `autoExit: true`) → register under the **same name**, watch with `entryCountBefore` so only new entries become the summary → result delivered as flow 2. Mux use = same create/type primitives as flow 1.

### Flow 6 — Ambient / orthogonal signals

- **Env identity:** `PI_SUBAGENT_NAME / _AGENT / _SESSION / _ID / _ACTIVITY_FILE / _SURFACE / _AUTO_EXIT / _ALLOWED`, `PI_CLAUDE_SENTINEL`, `PI_CODING_AGENT_DIR`, `PI_DENY_TOOLS`. None are mux-specific except `PI_SUBAGENT_SURFACE` (opaque handle — works with any string id).
- **Layout rebalance:** `rebalanceSurfaces()` (`select-layout … even-horizontal`, debounced 120 ms) — **tmux-only cosmetic, deleted under kitty tabs** (each tab is full-width).
- **Session shutdown:** abort poll loops, clear intervals, clear `runningSubagents` — mux-agnostic.
- **Nested spawning:** a worker's children reuse flows 1–5 with its own registry/loadouts, gated by `PI_SUBAGENT_ALLOWED`; `runningChildrenCount()` (shared process-global symbol) suppresses the worker's auto-exit until children report back. Mux-agnostic.

### Signal inventory (what the kitty layer must preserve)

| # | Signal | Medium | Producer → consumer | Mux-dependent? |
|---|---|---|---|---|
| S1 | Surface handle (pane/tab id) | `RunningSubagent.surface` + `PI_SUBAGENT_SURFACE` | parent → parent/child | **Yes — changes representation (`%12` → kitty window id)** |
| S2 | Launch command delivery (type + Enter) | terminal input | parent → child shell | **Yes (`send-keys`)** |
| S3 | Terminal sentinel `__SUBAGENT_DONE_<code>__` | terminal screen | child shell → parent poller | **Yes (`capture-pane`)** |
| S4 | `.exit` sidecar (`{type:"error",…}`) | file next to session `.jsonl` | child → parent fast path | No |
| S5 | Claude sentinel + `.transcript` | `/tmp` files | hook → parent | No |
| S6 | Session `.jsonl` (summary, stats, session id) | file | child → parent extraction | No |
| S7 | Activity JSON (`phase/sequence/…`) | `subagent-activity/<id>.json` | child → parent widget/status | No |
| S8 | `.ask` (`{name,agent,question}`) | file next to session | child → parent question delivery | No |
| S9 | `subagent_result / _status / _question` | `pi.sendMessage` steer + renderers | extension → orchestrator | No |
| S10 | Steer text (flattened, +Enter) | terminal input | parent → running child | **Yes (`send-keys`)** |
| S11 | Surface teardown | mux kill | parent → mux | **Yes (`kill-pane`)** |
| S12 | Sandbox snapshot `.loadout.json`, name registry, launch scripts, task/resume artifacts | files | parent → future resume | No |
| S13 | `even-horizontal` rebalance | mux layout | parent → mux | tmux-only — **drop** |

Takeaway: **S1/S2/S3/S10/S11 are the entire migration surface.** S4–S9, S12, and all of `session.ts`/`activity.ts`/`status.ts`/`subagent-done.ts` move over untouched.

---

## 3. tmux primitive → kitty mapping (tabs)

All kitty commands below are from the local docs (`remote-control.rst.txt` tutorial, `generated/launch.rst.txt`,
`generated/rc.rst.txt`, `generated/matching.rst.txt`) and were cross-checked against `kitty @ {launch,send-text,send-key,get-text,close-tab,close-window} --help` on kitty 0.44.0. Capitalized tokens are values the new layer supplies.

| tmux.ts export (current) | kitty equivalent (tabs first) | Notes / doc source |
|---|---|---|
| `isTmuxAvailable()` (`$TMUX` + `command -v tmux`) | `isMuxAvailable()`: `KITTY_WINDOW_ID`/`KITTY_PID` set **and** `kitty @ ls` succeeds (respects `KITTY_LISTEN_ON` / `--to`) | `rc_via_socket`: outside a kitty window a `--listen-on` socket is mandatory; inside, the controlling tty is used |
| `muxSetupHint()` | `"Run pi inside kitty with remote control enabled (allow_remote_control yes) and a listen socket, e.g. kitty -o allow_remote_control=yes --listen-on unix:/tmp/kitty-$USER …"` | Mirrors current hint style |
| `createSurface(name)` → `split-window -d -h -t $TMUX_PANE` → `%ID` | `kitty @ launch --type=tab --keep-focus --dont-take-focus --tab-title NAME --cwd DIR? --env K=V …` → prints **window id** (numeric) | `launch --type=tab` opens a tab in the current OS window; `--keep-focus/--dont-take-focus` = `-d` equivalent (`launch.rst.txt`); `--location after` optionally places it next to current; launch output (window id) becomes the `surface` handle |
| `createSurfaceSplit(name, dir, from)` | **Not needed for tabs-first.** Keep the exported stub (throw `not supported with kitty tabs`, or map later to `--type=window --location=hsplit/vsplit`) | Current callers: only `createSurface` + tests call it (`index.ts`, `harness.ts`) |
| `sendCommand(surface, cmd)` (`send-keys -l` + `Enter`) | `kitty @ send-text --match id:ID -- COMMAND` then `kitty @ send-key --match id:ID Enter` | `send-text --match` selects by numeric `id:` (exact, no regex-injection risk); `send-key` delivers the submit keystroke (`rc.rst.txt`: `send-text.data`, `send-key.keys`) |
| `sendLongCommand(…)` (script file + `bash <script>`) | **Keep as-is** (writes the same `subagent-scripts/*.sh`, then `sendCommand(surface, "bash '<script>'")`) | Still avoids quoting/line-wrap issues; additionally sidesteps `send-text` Python-escape handling for long commands |
| `readScreen(surface, N)` / `readScreenAsync` (`capture-pane -p -S -N`) | `kitty @ get-text --match id:ID --extent screen` (sync) / same via async exec (async) | `get-text.extent: screen` = current screen; sentinel check parses the tail (`rc.rst.txt`); Claude 200-line fallback uses `--extent all` + tail |
| `closeSurface(surface)` (`kill-pane`) | `kitty @ close-window --match id:ID` (single-window tab ⇒ tab goes away; or `close-tab --match window_id:ID`) | Both accept the stored window id; prefer `close-window` (no tab-id bookkeeping) |
| `pollForExit(…)` (sidecars + `capture-pane` regex) | **Logic unchanged**; only the slow path calls the new `readScreenAsync`; destroyed-surface error path behaves the same (fall back to `.exit` re-check) | Fast paths (S4/S5) never touch the mux |
| `rebalanceSurfaces()` + `SUBAGENT_TMUX_LAYOUT` | **Delete.** Tabs are full-width; no even-out needed | Removes the only focus/layout-churn code |
| `shellEscape()` | **Reuse verbatim** (pure quoting) | |
| Focus guarantee ("never steals focus") | `--keep-focus` on every `launch` + `send-text`/`send-key --match` never focus (remote control targets background windows) | `launch.rst.txt: keep_focus`; verify with a focus test mirroring `tmux-surface.test.ts` |

Splits later (if wanted): `launch --type=window --location=hsplit|vsplit|split --keep-focus` re-adds in-tab splits without changing any other flow.

---

## 4. What stays identical (no changes)

- Launch/resume **command builders** (`applySandboxToParts`, `buildPiPromptArgs`, env prefixes, artifact paths, `cd` prefixes, `; echo '__SUBAGENT_DONE_'$?'__'` sentinel suffix) — the child shell sees the same bytes.
- `session.ts` (seeding, registry, loadouts, stats), `activity.ts` (recorder/reader + `wrong-id` validation), `status.ts` (classification/transitions), `subagent-done.ts` (auto-exit, `.exit`, `ask_question`), `safe-bash.ts`, Claude plugin hooks.
- `pi.sendMessage` steer flows + all three message renderers (`subagent_result/_status/_question`), widget rendering, `/subagent` command, `PI_SUBAGENT_SHELL_READY_DELAY_MS` delay (still needed — a fresh tab's shell needs the same settle time).
- `RunningSubagent` shape — only the `surface` string contents change (`%12` → e.g. `18`).

---

## 5. Feasibility caveats (must handle, all solvable)

Each caveat below is written as: **what it is → why it matters for our flows → what breaks if ignored →
how to handle it.**

### 5.1 Control channel: socket vs controlling tty (the one hard prerequisite)

- tmux works whenever `$TMUX` exists. Kitty remote control works **inside a kitty window via the controlling tty**, but **detached/background processes (no `/dev/tty`) must use a `--listen-on` socket** (`remote-control.rst.txt`, `rc_via_socket`).
- Observed here: `allow_remote_control yes` is already set, but `KITTY_LISTEN_ON` is empty and `kitty @ ls` from this (tty-less) tool context fails with `open /dev/tty: no such device`. The pi extension host **does** run under the user's kitty window (has a tty), so `kitty @ …` should work there — but to be robust (backgrounded pi, `pi --session` resume helpers, tests), document + auto-respect: `kitten @ --to $KITTY_LISTEN_ON` when set, and recommend users add e.g. `listen_on unix:/tmp/kitty-{user}` to `kitty.conf`. `isMuxAvailable()` should probe `kitty @ ls`, not just env vars.
- Auth: with plain `allow_remote_control yes` no password is needed. If the user later hardens to `allow_remote_control password`, every `kitty @` call needs `--password/--password-file/--password-env` (`KITTY_RC_PASSWORD`) — thread a `KITTY_RC_*` passthrough through the new layer from the start.

**Why two transports exist.** `kitty @ …` speaks the remote-control protocol: a JSON payload framed as
`<ESC>P@kitty-cmd<JSON><ESC>\` (`rc_protocol.rst.txt`). That payload must *reach* the kitty process by one of
exactly two routes (`remote-control.rst.txt`: tutorial + `rc_via_socket`):

1. **Controlling tty** (default): the CLI writes the escape sequence to `/dev/tty` of the calling process. Works
   only inside a kitty window with a live controlling terminal (even over SSH). Fails outright with
   `open /dev/tty: no such device` anywhere else — which is exactly the failure reproduced from this tty-less tool
   context.
2. **Listen socket** (`--listen-on` flag / `listen_on` in `kitty.conf` → `$KITTY_LISTEN_ON`): a unix (or TCP)
   socket the CLI dials via `kitty @ --to SOCKET …`. Works from *any* process that can reach the socket:
   detached children, background jobs, test runners, headless `pi -e` resume probes.

The pi extension host itself runs *under* the user's kitty window (it has a tty), so route 1 covers the normal
case. But anything that outlives or escapes that tty — backgrounded/nohup'd pi, pi launched from tmux/an IDE
task/SSH-without-tty, a future daemonization — loses *every* surface primitive at once (create, type, read,
close), so `isMuxAvailable()` goes false and **all** spawns and resumes are refused.

**What breaks if ignored.** Without a socket, the feature works only while pi keeps its controlling tty, and a
naive `isMuxAvailable()` (env-var check: `KITTY_WINDOW_ID` set ⇒ available) would report *available* and then fail
mid-spawn — stranding a half-built `RunningSubagent` (surface created? command typed? unknown) instead of refusing
cleanly up front.

**Handling (required).** (a) Recommend `listen_on unix:/tmp/kitty-{user}` in `kitty.conf` as standard setup
(kitty then exports `$KITTY_LISTEN_ON` to children automatically — per-user path avoids collisions, unix socket
avoids TCP exposure). (b) Centralize one `kitty @` helper in the new `kitty.ts` that appends `--to $KITTY_LISTEN_ON`
when set, tty route otherwise — transport decision in exactly one place. (c) Make `isMuxAvailable()` an *active*
probe (`kitty @ ls`, short timeout, success required; env vars as fast pre-filter only) so the worst case becomes a
clean refusal with a hint naming both fixes. (d) Auth passthrough from day one (env `KITTY_RC_PASSWORD` /
`--password-file`): zero behavior change now, no refactor and no surprise lockout if the user later hardens to
password mode (note the docs' SSH nuance: password mode encrypts via `KITTY_PUBLIC_KEY` and rejects >5 min clock
skew — irrelevant locally; never "fix" it by downgrading the user's auth setting).

### 5.2 `send-text`/`send-key` report success unconditionally

**What it is.** The kitty docs and `--help` state explicitly that addressing errors are *not* reported for these
two commands: "`send-text` always succeeds, even if no text was sent to any window" (identical wording for
`send-key`). This is inherent to their fire-and-forget broadcast design (`--match` can target many windows; there
is no single status to return). Contrast tmux: `send-keys -t <dead-pane>` exits non-zero and throws, and
`steerSubagent()` relies on exactly that — it catches the throw and returns
`{ error: "Failed to deliver message … via tmux: …" }`, which `subagent_message` surfaces to the orchestrator.

**Why it matters.** The affected call-site is precisely one: **flow 5, steer-to-running** (signal S10). Concrete
scenario: the orchestrator replies to a parked `ask_question` child (or steers mid-turn guidance) *after* the
child's tab was closed — by a human, by a crash, by an earlier `closeSurface`. Under tmux the tool returns an error
and the orchestrator learns the target is gone (can respawn/resume). Under naive kitty the tool would return
"Message delivered … picks this up at its next turn boundary" — a lie. The reply evaporates; the child, if it
somehow still lives, waits forever; the orchestrator waits for a result that will never reflect its reply. Silent
message loss is the worst failure mode in an orchestration system because *both sides believe the other side has it*.

**Blast radius is bounded.** Spawn, resume, and teardown don't depend on send-acknowledgment (launch prints the
new window id; close is idempotent-by-design — see §5.3 GC). Completion detection (flow 2) is *read-side*, and
`get-text` carries **no** silent-success disclaimer in its docs or `--help`, so a dead window surfaces as a read
error → the poller's existing destroyed-surface path (re-check `.exit`, else normal absence handling) behaves as
under tmux. File-side signals (`.exit`, `.ask`, activity JSON, session `.jsonl`) never touch the mux at all.

**Handling (required): verify-then-send.** Before `send-text`/`send-key`, confirm the window still exists via
`kitty @ ls` (JSON shape per `remote-control.rst.txt`: OS windows → `tabs` → `windows`, each window with a numeric
`id`). If our stored id is absent → return the *same* `{ error }` shape `steerSubagent()` returns today, so
`index.ts` needs no changes. Two honest notes: (a) an inherent TOCTOU race remains (window dies *between* check
and send) — the check shrinks silent loss from "whenever the tab is already gone at steer time" (common: human
closed it minutes ago) to "only if it dies in the millisecond between check and send" (rare, and the next 1 s
poller tick surfaces the death via flow 2/3 anyway); say so in the code comment. (b) Cost is one `ls` round-trip
per steer — steers are rare (human-scale replies), never per-tick, so no steady-state load; the 1 s poller keeps
using `get-text`, not `ls`. Always match by numeric `id:` (exact integer match, `matching.rst.txt`) — never by
title: titles are regexes, non-unique, and child-controlled (prompt escapes can rewrite them), i.e. an injection
and misdelivery vector.

### 5.3 Smaller semantic deltas

- **Matching:** always match by numeric `id:` (exact match, no regex). Never match by title (regex injection, duplicates). `close-window --match id:ID` needs no tab-id lookup.
- **Screen reads:** tmux `capture-pane -S -5` ≈ `get-text --extent screen` + take last lines; the 200-line Claude fallback needs `--extent all` (screen+scrollback) + tail. Both default to plain text (no `--ansi`), matching current behavior.
- **`send-text` escaping:** payload follows Python escaping rules — prefer routing all sends through the existing `sendLongCommand` script-file path so arbitrary task bytes never go through `send-text` inline; keep `sendCommand` for short control strings (`bash <script>`, flattened steer lines) with `\n` handling preserved (steer still flattens newlines — Enter submits in the child TUI either way).
- **No `$TMUX_PANE` targeting.** tmux splits must explicitly target the parent pane or they follow user focus;
  kitty `launch --type=tab` opens in the *current OS window* by default (`launch.rst.txt`) — already the right tab
  strip, with no parent-pane plumbing. Minor consequence: multi-OS-window users get the tab in the focused window
  rather than the pi window's; acceptable and documentable (single OS window is the norm).
- **Focus mechanism changes, guarantee preserved.** tmux uses `split-window -d`; kitty uses `--keep-focus` /
  `--dont-take-focus` on every `launch`, and `send-text`/`send-key --match` never move focus (remote control
  addresses background windows directly). The "creation never steals keyboard focus" guarantee (cf. tmux issue
  #12 in the code comments) is preserved — but must be re-proven by porting the focus integration test, since the
  mechanism is new.
- **GC / double-close.** tmux `kill-pane` on a gone pane throws; the code already tolerates it (watcher `try/catch`,
  best-effort rebalance). kitty `close-window`/`close-tab` expose `ignore_no_match` (`rc.rst.txt`) — set it (or
  swallow no-match errors) so double-close and already-exited windows can't fail a watcher, exactly as today.
- **Handle representation is safe.** Verified by grep: `PI_SUBAGENT_SURFACE` is *write-only* (set once in
  `launchSubagent`, never read back anywhere in `pi-extension/` or `test/`), and `RunningSubagent.surface` is only
  ever passed back into the surface layer. Changing the handle from tmux `%12` to kitty numeric window id (e.g.
  `18`) breaks no parser — none depends on the `%` prefix. `shellEscape()` is pure quoting and moves over verbatim.

---

## 6. Verdict

**Feasible with a contained, low-risk change.** The architecture already isolates the multiplexer (§1), and the
completion/liveness/question/result channels that actually carry agent semantics are files + extension-host steers
(§2, S4–S9/S12) that don't care whether the child shell lives in a tmux pane or a kitty tab. The kitty remote-control
protocol provides a documented equivalent for every one of the 5 mux-touching signals (S1/S2/S3/S10/S11, §3), with
`--keep-focus` preserving the extension's core "never steals focus" guarantee. Tabs additionally **remove** a whole
code path (layout rebalancing) and scale better than side-by-side panes. The only prerequisite is a working control
channel (§5.1); the only behavior to compensate is silent send success (§5.2). Recommended direction: implement
`kitty.ts` behind the **same export surface** as `tmux.ts`, archive (not delete) `tmux.ts`, and mirror the focus +
echo + close integration tests for tabs.

---

## 7. Implementation plan (after approval)

1. **Archive:** `git mv pi-extension/subagents/tmux.ts pi-extension/subagents/tmux.ts.archived` (keep, don't delete).
2. **New `pi-extension/subagents/kitty.ts`** exporting the identical API: `isMuxAvailable`, `muxSetupHint`,
   `createSurface`, `createSurfaceSplit` (stub/split-later), `sendCommand`, `sendLongCommand`, `pollForExit`
   (+ `__pollForExitTest__`), `closeSurface`, `shellEscape`, `readScreen`, `readScreenAsync`. Uniform helper for
   `kitty @ [--to …] …` invocation; `--to` from `KITTY_LISTEN_ON`, password via `KITTY_RC_PASSWORD`/file passthrough.
3. **Rewire (2 lines + strings):** `index.ts` import `./tmux.ts` → `./kitty.ts`; `via tmux` error text → mux-neutral;
   `muxUnavailableResult()` hint; drop `rebalanceSurfaces`/`SUBAGENT_TMUX_LAYOUT`. Same for `test/integration/harness.ts`.
4. **Robustness:** pre-send existence check (`ls` JSON) to recover steer error reporting (§5.2); `get-text --extent`
   selection per call-site; tolerant close.
5. **Tests:** clone `tmux-surface.test.ts` → `kitty-surface.test.ts` (launch tab `--keep-focus`, focus stays put,
   echo marker via `sendLongCommand`, `get-text` contains marker, close removes window; parallel tabs). Lifecycle tests
   run unmodified against the new layer. Run inside kitty with a listen socket set.
6. **Docs:** `README.md` (tmux-only fork note → kitty tabs, requirements, `listen_on` setup), `package.json`
   description, `config.json.example` untouched. Delete nothing else.

## 8. Open questions for implementation

- Listen socket path convention (`unix:/tmp/kitty-$USER`?) and whether `isMuxAvailable()` should offer to print the `kitty.conf` snippet when the probe fails.
- `close-window` vs `close-tab --match window_id:` — equivalent for single-window tabs; confirm with the focus test.
- Whether `createSurfaceSplit` should immediately map to `--type=window --location=hsplit` (splits revival) or stay a stub until tabs bake in.

## 9. Implementation (done)

Kept deliberately small — same architecture, new backend, no new features:

- `pi-extension/subagents/tmux.ts` → `git mv` to `tmux.ts.archived` (kept, not deleted; nothing imports it).
- New `pi-extension/subagents/kitty.ts` with the **same export surface** (`isMuxAvailable`, `muxSetupHint`,
  `createSurface`, `createSurfaceSplit`, `sendCommand`, `sendLongCommand`, `readScreen`, `readScreenAsync`,
  `closeSurface`, `shellEscape`, `pollForExit`, `__pollForExitTest__`). Tabs-first: `launch --type=tab
  --dont-take-focus`, no layout/rebalance code. All addressing is explicit numeric `--match id:` — sends can
  never land in the main session's input. `send-text` travels via `--stdin` + `send-key enter`; `sendCommand`
  verifies the tab exists first (honest errors instead of kitty's silent send success, §5.2). Screen reads use
  `--extent screen` for small reads, `all` only for deep ones.
- `index.ts`: import path + 3 user-facing strings only. Completion notify (`subagent_result` steer) and the
  immediate `updateWidget()` on spawn/exit are unchanged — the widget counter updates the moment a run registers
  or is removed, before the wake-up message is sent.
- Tests: `test/test.ts` import/label updates only; harness re-points to `kitty.ts` with kitty focus helpers;
  `tmux-surface.test.ts` → `kitty-surface.test.ts`. Unit suite: 147/148 (the 1 failure is pre-existing and
  unrelated — the bundled `worker.md` `subagent_agents` assertion is shadowed by ambient agent dirs).
- Docs: README + `package.json` description updated (kitty requirements + `listen_on` setup).
- Not verifiable in a tty-less sandbox: live tab open/send/read/close and the focus test — run
  `npm run test:integration` inside kitty with `--listen-on` set (see the test-file headers).

## 10. Root cause: tty-transport corruption (both live symptoms traced here)

Two reported symptoms — (a) worker output appearing in the main session's input box, (b) main session unusably
slow while a worker runs — share one root cause: `kitty @` without `--to` talks over the main session's own
controlling terminal. Kitty delivers command responses as input bytes on that same tty, so pi's TUI reader and the
CLI steal each other's bytes. Concretely: the 1s `get-text` poll's response payload *is* the worker's screen text,
and leaked response bytes get interpreted as typed/pasted input in the main composer (symptom a); the constant
query/response traffic plus mutual byte-stealing stalls input handling (symptom b). Fix applied: the socket route
(`KITTY_LISTEN_ON` + `--to`) is now REQUIRED — `isMuxAvailable()` refuses tty-only setups with an actionable hint
instead of corrupting the session. One-time user setup: `allow_remote_control yes` + `listen_on` in kitty.conf,
restart kitty.
