# How the plugin works

`pi-interactive-subagents` lets a pi session delegate work to **subagents** — separate pi sessions running in their own **kitty tabs**. The parent keeps working; when a subagent finishes, its result is delivered back as a notification that wakes the parent up. Everything is **async and fire-and-forget**: you never wait, poll, or check.

## Requirements

- pi running **inside kitty**, with remote control over a socket. In `kitty.conf` (then restart kitty):

```bash
allow_remote_control yes
listen_on unix:/tmp/kitty-$USER
```

The socket is mandatory: it keeps all plugin control traffic off your terminal. Without it the plugin refuses to run rather than risk corrupting your session.

## Core ideas

| Concept | Meaning |
|---|---|
| **Agent** | A profile from a `.md` file (model, tools, system prompt, e.g. `scout`, `worker`). Defines *how* the subagent works. |
| **Subagent** | One running instance: an agent + a task, living in its own kitty tab with its own session file. Has a unique display **name** (`scout`, `scout-2`, …). |
| **Fire-and-forget** | Spawning returns immediately. Results arrive later, automatically, as a new turn. Never poll or wait. |
| **Steer** | A message injected into a session's next turn boundary — the delivery mechanism in both directions. |

## Lifecycle of a subagent

1. **Spawn.** You (or the model) call `subagent({ agent: "scout", task: "Map the auth module" })`. The plugin:
   - picks a unique name (defaulted *and* explicit names are deduplicated against running, in-flight, and finished runs — an explicit `"X"` that is taken becomes `"X-2"`, reported in the ack details as `requestedName`/`renamed`),
   - creates a session file for the child,
   - snapshots its sandbox (tool allowlist, model, identity — so a later resume replays the exact same restrictions),
   - opens a **new kitty tab without stealing focus** and starts `pi` there with the task.
   - The tool returns instantly ("started"). A widget above your input now counts the running subagent.
2. **Run.** The subagent works in its tab. A small activity file reports liveness (`active`, `waiting`, …), which
   drives the widget. Your session is fully usable meanwhile.
3. **Finish.** The subagent's last message becomes its summary; its process exits — unless the run is kept open
   (`tabs.keepOpen` in `config.json` plus `auto-exit: false` in the agent: session stays interactive, tab left
   open; see `EXIT-KEEP-PRECEDENCE.md`). Either way the plugin's watcher reads the summary from the session file,
   updates the widget **immediately**, and sends you a `subagent_result` notification — this triggers a new turn
   so you can act on the result. Kept tabs stay supervised afterwards: later `ask_question` calls still reach you.
4. **Follow up** (optional). The finished subagent stays addressable by name: `subagent_message({ name: "scout",
   message: "Also check the middleware" })` resumes that same session with the message as its next task, and the new
   result is delivered the same way.

If the run fails (e.g. provider overload after retries), you get a failure notification with the underlying error
instead of a silent fake completion.

## Talking to a running subagent

`subagent_message({ name, message })` does three different things based on state — same name, no need to know which:

- **Running** → the message is typed into the subagent's tab only (never your input) and picked up at its next turn.
  Returns an immediate ack; the eventual result still arrives as a notification. Keep steers human-scale (a paragraph
  or two) — multi-KB pastes risk terminal line-wrap mangling; put long content in a file and point at the path.
- **Kept open** (first result delivered, tab still alive) → steered into the live tab, same as running. Only a
  *relaunch* is refused while the tab lives — close it and retry for that.
- **Finished** → resumes the session (see step 4 above).

A subagent can also ask *you* something first via its `ask_question` tool. Its session parks as `waiting`, you get a
notification with the question, and your `subagent_message` reply becomes its next turn. It never exits while a
question is unanswered.

Humans should only drive **kept** tabs (see `EXIT-KEEP-PRECEDENCE.md`): an auto-exit tab shuts itself down when its
turn ends even if you are typing in it — typing does not hold the tab open. Kept tabs stay interactive after their
first result and are safe to work in directly.

## The widget

A live box above the input lists every running subagent with elapsed time and state, e.g. `2 running`. It updates the moment a subagent starts or finishes, plus a 1-second refresh for timers. Stall/recovery transitions for autonomous
agents additionally notify you; user-driven agents stay quiet (you're already looking at their tab).

## Tools

| Tool | Who uses it | What it does |
|---|---|---|
| `subagent` | parent | Spawn a subagent (async) |
| `subagent_message` | parent | Steer a running subagent, or resume a finished one |
| `subagents_list` | parent | List available agent profiles |
| `ask_question` | subagent only | Ask the parent a question and wait for the reply |
| `/subagent <agent> <task>` | human | Slash-command shortcut for spawning |

Spawning is permissioned: every spawn must name a known agent, and a subagent may only spawn what its `subagent_agents` profile field allows (`true` = any agent; a list = only those; missing/`false` = cannot spawn at all) — so a child can never escalate into a full-toolset session. Agents without a `tools` header run with a `read, write, edit, bash` baseline (`ask_question` always added). Note the baseline `bash` is pi's native tool, unwrapped: the `safe_bash` wrapper only loads when an agent literally lists `safe_bash`, and it is a best-effort guardrail, not a sandbox.

## How the pieces fit (files)

- `pi-extension/subagents/index.ts` — thin extension wiring: tool/command/renderer registration plus `session_start`/`session_shutdown` delegation. The logic lives in the modules below; it runs in your session.
- `pi-extension/subagents/handlers/` — tool executes: `spawn.ts` (`subagent`), `message.ts` (`subagent_message`, steer-vs-resume dispatch), `list.ts` (`subagents_list` + `/subagent` command), plus pure gates in `validators.ts`.
- `pi-extension/subagents/lifecycle.ts` — run/kept/watch orchestration: launch + watch, reload recovery, per-session teardown, artifact sweep, the `.ask` queue, per-session UI.
- `pi-extension/subagents/runtime.ts` — process-global keys + import-time rotation (survive `/reload` by design).
- `pi-extension/subagents/agents.ts` — agent profiles: frontmatter parsing, discovery (bundled package dir → global `~/.pi/agent/agents/` → project `.pi/agents/`), spawn gating, tool→extension mapping.
- `pi-extension/subagents/launch.ts` + `cli/claude.ts` — command builders: sandbox flags, env prefixes, task artifacts, launch scripts (pi and Claude paths).
- `pi-extension/subagents/store.ts` — live identity: running runs, kept tabs, parallel-spawn reservations (single owner).
- `pi-extension/subagents/notifications.ts` — the sole owner of parent-bound steer messages (`subagent_result` / `subagent_question` / `subagent_status`).
- `pi-extension/subagents/widget.ts` + `format.ts` — widget rendering and elapsed/token/context formatters. `keep.ts` holds the keep/exit truth table; `names.ts`/`paths.ts` hold slug/path helpers; `config.ts` reads `config.json` fresh (refreshed on `session_start`).
- `pi-extension/subagents/kitty.ts` — the only terminal-dependent layer: open tab, send text, read screen, close tab, detect exit. Everything else is terminal-agnostic.
- `pi-extension/subagents/session/` (via the `session.ts` barrel) — session files (`io`), session-id index (`index-cache`, quarantined: newest-wins prefix matching, do not build on it), name registry (`registry`), sandbox snapshots (`loadout`), seeding (`seed` — headers hand-track pi's session format, `version: 3`; re-check against the installed pi on upgrades), stats (`stats`); retired branch helpers are quarantined in `legacy-branch.ts`.
- `pi-extension/subagents/activity.ts` + `status.ts` + `status-bridge.ts` — child liveness reporting, its classification, and the bridge between them.
- `pi-extension/subagents/subagent-done.ts` (+ pure helpers in `subagent-done-pure.ts`) — loaded *inside* each subagent: auto-exit on completion, error reporting, the `ask_question` tool.
- Agent profiles — resolved in three tiers (bundled package dir, global `~/.pi/agent/agents/`, project `.pi/agents/`; later tiers override). Put yours wherever fits your setup.

## Signals at a glance

Almost all coordination is **files + notifications**, not terminal tricks:

- **Terminal** (kitty remote control, always over the socket): open tab, type into a tab, read a tab's screen for the exit sentinel, close a tab.
- **Files**: session transcripts (results; torn lines are skipped, never fatal), `.exit` sidecar (failures; claimed atomically), `.ask` file (questions; written atomically, claimed via rename so concurrent watchers deliver exactly once), activity file (liveness), registry + sandbox snapshot (resume). Reserved filename suffixes (the parent↔child protocol — never reuse them): `.exit`, `.done`, `.ask`, `.loadout.json`, `.transcript` (Claude only), `.consuming-*` (transient rename-claims, swept when stale), `.pending-*` (parked questions), `.tmp-*` (transient writer temps), `.corrupt-retry` (torn-`.ask` retry marker), `.corrupt-<ts>` (registry backups, kept as evidence). `session_start` sweeps stale claims and week-old staged artifacts; the registry itself is never swept.
- **Notifications** (extension → you, as new turns): `subagent_result` (finished), `subagent_question` (it asked something), `subagent_status` (stalled/recovered).
