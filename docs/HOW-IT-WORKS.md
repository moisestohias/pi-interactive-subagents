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
   - picks a unique name,
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
  Returns an immediate ack; the eventual result still arrives as a notification.
- **Kept open** (first result delivered, tab still alive) → steered into the live tab, same as running. Only a
  *relaunch* is refused while the tab lives — close it and retry for that.
- **Finished** → resumes the session (see step 4 above).

A subagent can also ask *you* something first via its `ask_question` tool. Its session parks as `waiting`, you get a
notification with the question, and your `subagent_message` reply becomes its next turn. It never exits while a
question is unanswered.

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

Spawning is permissioned: every spawn must name a known agent, and a subagent may only spawn what its `subagent_agents` profile field allows (`true` = any agent; a list = only those; missing/`false` = cannot spawn at all) — so a child can never escalate into a full-toolset session. Agents without a `tools` header run with a `read, write, edit, bash` baseline (`ask_question` always added).

## How the pieces fit (files)

- `pi-extension/subagents/index.ts` — the orchestrator side: tools, launch/resume builders, watchers, widget, notifications. Runs in your session.
- `pi-extension/subagents/kitty.ts` — the only terminal-dependent layer: open tab, send text, read screen, close tab, detect exit. Everything else is terminal-agnostic. 
- `pi-extension/subagents/tmux.ts.archived` — the previous backend, kept for reference. Nothing imports it. 
- `pi-extension/subagents/session.ts` — session files, name registry, sandbox snapshots, result/stats parsing. 
- `pi-extension/subagents/activity.ts` + `status.ts` — child liveness reporting and its classification. 
- `pi-extension/subagents/subagent-done.ts` — loaded *inside* each subagent: auto-exit on completion, error reporting, the `ask_question` tool.
- `agents/` — bundled profiles (`scout`, `researcher`, `worker`). Add your own as `.md` files in `.pi/agents/`.

## Signals at a glance

Almost all coordination is **files + notifications**, not terminal tricks:

- **Terminal** (kitty remote control, always over the socket): open tab, type into a tab, read a tab's screen for the exit sentinel, close a tab.
- **Files**: session transcripts (results), `.exit` sidecar (failures), `.ask` file (questions), activity file (liveness), registry + sandbox snapshot (resume).
- **Notifications** (extension → you, as new turns): `subagent_result` (finished), `subagent_question` (it asked something), `subagent_status` (stalled/recovered).
