# pi-interactive-subagents

Async subagents for [pi](https://github.com/badlogic/pi-mono), running in kitty tabs. Spawn a sub-agent, keep working in the main session, and get the result steered back when it finishes. Fully non-blocking.

**kitty-tabs fork** (migrated from tmux; the old surface layer is preserved as `pi-extension/subagents/tmux.ts.archived`). See [Acknowledgements](#acknowledgements) for the upstream project, which also supports cmux, zellij, and WezTerm.

## How it works

`subagent()` returns immediately. The sub-agent runs in its own kitty tab — opened with `--dont-take-focus`, so tab creation never steals keyboard focus. Outbound traffic is always addressed to the subagent tab's window id, so nothing is ever typed into (or displayed in) the main session. A live widget above the input tracks every running sub-agent, and when one finishes, its result is steered into the main session as a notification that triggers a new turn.

```
╭─ Subagents ──────────────────────────── 2 running ─╮
│ 00:23  scout      active · bash 7m                 │
│ 00:45  scout-2    waiting 2m                       │
╰────────────────────────────────────────────────────╯
```

Spawn several in parallel — they run concurrently and steer results back independently as each finishes.

Each sub-agent gets a full-width tab, so there is no pane layout to maintain (the tmux-era `even-horizontal` rebalancing is gone with the archived surface layer).

If your shell startup is slow and launch commands get dropped before the prompt is ready, raise the delay:

```bash
export PI_SUBAGENT_SHELL_READY_DELAY_MS=2500   # default: 500
```

To leave finished sub-agent tabs open instead of closing them, set `tabs.keepOpen` in `config.json` (see
[configuration](#status-widget--configuration)).

With it on, the worker's pi session **stays open and interactive** after finishing its task — the tab is not
just left behind, pi itself keeps running there. The run still completes normally from the orchestrator's side
(widget counter drops, result is steered back once, completion message notes the open tab). After that, follow
up by typing directly in the kept tab. `subagent_message` to that name is refused while its tab is alive (two pi
processes must never share one session file) — close the tab and retry if you want a resumed run instead.
Aborted runs (session shutdown/reload) always clean up their tabs. Applies on `/reload`, no pi restart needed.

## Tools

| Tool | Description |
| --- | --- |
| `subagent` | Spawn a sub-agent in a dedicated kitty tab (async) |
| `subagent_message` | Message a sub-agent by name — steers it if running, resumes its session if finished |
| `subagents_list` | List available agent definitions |
| `ask_question` | *(sub-agent sessions only)* Ask the orchestrator a question and wait for the reply |

There is also a `/subagent <agent> <task>` command for spawning directly.

### Spawning

```typescript
subagent({ agent: "scout", task: "Analyze the auth module" });
subagent({ agent: "worker", name: "dark-mode", task: "Implement the dark mode toggle" });
```

| Parameter | Type | Default | Description |
| --------- | ---- | ------- | ----------- |
| `agent` | string | required | Which agent to spawn (must be known and permitted) |
| `task` | string | required | Task prompt |
| `name` | string | agent name | Display name for the tab and widget. Must be unique — duplicates are auto-suffixed (`scout`, `scout-2`, …) |
| `model` | string | agent's model | Override the model for this spawn |
| `cwd` | string | agent's `cwd` | Working directory (see [Role folders](#role-folders)) |

### Messaging

`subagent_message` is addressed **by name only**. Names are unique per session and persist after a sub-agent finishes, so the same name works either way:

```typescript
subagent_message({ name: "scout", message: "Also check the auth middleware" });
```

- **Running** — the message is sent to the live tab only (`send-text` addressed by window id, newlines flattened) and picked up at the next turn boundary. The call returns immediately; the eventual completion still arrives as a steer message.
- **Finished** — the session is resumed with the message as the follow-up task, like a fresh spawn: fire-and-forget, always autonomous, result steered back later. The resumed run reclaims its original name.

Every spawn records name → session file in `artifacts/<sessionId>/subagent-registry.json`, so names stay addressable across pi restarts. A nested sub-agent that spawns children gets its own registry keyed by its own session id. Resume is refused with a clear error (listing known names) if the name isn't registered, the session file is gone, or the session predates sandboxed resume.

**Resume replays the original sandbox.** At spawn time the fully-resolved loadout — tool allowlist, backing extensions, model, thinking level, system prompt, spawn whitelist, cwd — is snapshotted to `<session>.loadout.json`. Resume rebuilds the exact same restricted process from that snapshot rather than relaunching unrestricted.

### ask_question

A sub-agent can ask its orchestrator a single freeform question when requirements are ambiguous or a decision materially affects the work. The session **stays open** (parked as `waiting`) instead of exiting; the parent is notified with the sub-agent's name, replies via `subagent_message({ name, message })`, and the reply arrives as the sub-agent's next turn. Parallel questions are supported — each waiting sub-agent has its own name.

If the reply arrives while the sub-agent is still mid-turn, it is absorbed into the current turn — either way the question is marked answered and the session exits normally when the work is done. If the parent never replies, the tab stays open until a human closes it. Only available inside sub-agent sessions.

## Bundled agents

| Agent | Model | Tools | Role |
| ----- | ----- | ----- | ---- |
| **scout** | `openrouter/z-ai/glm-5.3` | `read`, `grep`, `find`, `ls` | Fast read-only codebase recon |
| **researcher** | `openrouter/z-ai/glm-5.3` | `web_search`, `web_fetch`, `safe_bash` | Web research, synthesized into a sourced brief |
| **worker** | `openrouter/z-ai/glm-5.3` | `read`, `write`, `edit`, `bash`, `web_search`, `web_fetch` + spawning | General implementer; may spawn `scout` and `researcher` |

All three are autonomous (`auto-exit: true`) and carry their identity in the system prompt (`system-prompt: append`).

## Custom agents

Place a `.md` file in `.pi/agents/` (project) or `~/.pi/agent/agents/` (global). Discovery priority: **project > global > package-bundled** — a project-local file overrides a bundled agent with the same name.

```markdown
---
name: my-agent
description: Does something specific
model: openrouter/z-ai/glm-5.3
thinking: medium
tools: read, edit, write, safe_bash, web_search
session-mode: lineage-only
auto-exit: true
---

You are a specialized agent that does X...
```

### Frontmatter reference

| Field | Type | Description |
| ----- | ---- | ----------- |
| `name` | string | Agent name (used in `agent: "my-agent"`) |
| `description` | string | Shown in `subagents_list` |
| `model` | string | Default model |
| `thinking` | string | `minimal`, `low`, `medium`, or `high` |
| `tools` | string | Strict tool allowlist. Built-ins: `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`. Extension-backed: `web_search`, `web_fetch`, `safe_bash`, `video_extract`, `youtube_search`, `google_image_search`. Only the extensions backing the listed tools are loaded into the child. Omit it and the child gets the `read, write, edit, bash` baseline (`ask_question` always added; spawning tools only via `subagent_agents`) |
| `subagent_agents` | boolean \| string | Whether this agent may spawn sub-agents. `true` grants the spawning toolset (`subagent`, `subagent_message`, `subagents_list`) with no target restriction; a comma-separated list grants it restricted to those agents. Omit it, leave it empty, or set `false` and the agent cannot spawn at all |
| `skills` | string | Comma-separated skill names to auto-load |
| `session-mode` | string | `standalone` (default), `lineage-only`, or `fork` — see below |
| `system-prompt` | string | `append` or `replace`: pass the body as the child's `--append-system-prompt` / `--system-prompt`. Omit and the body is prepended to the task prompt instead |
| `auto-exit` | boolean | Auto-shutdown when the agent finishes (see below) |
| `interactive` | boolean | Whether stall/recovery transitions wake the parent (see below) |
| `cwd` | string | Default working directory |
| `disable-model-invocation` | boolean | Hide from `subagents_list`; still spawnable by explicit name |
| `cli` | string | `claude` runs the agent via the Claude Code CLI instead of pi |

### session-mode

- `standalone` — fresh session, no lineage link to the caller (default)
- `lineage-only` — fresh session with `parentSession` linkage for discovery/fork UX, but no copied turns
- `fork` — child session seeded with the caller's conversation context

### auto-exit

With `auto-exit: true`, the session shuts down when the agent's turn ends — the agent just writes its final message and stops (there is no "done" tool). The last assistant message becomes the summary returned to the parent. Recommended for all autonomous agents.

Exit vs keep-open precedence (`tabs.keepOpen` × `auto-exit` — see `docs/EXIT-KEEP-PRECEDENCE.md`):

- `tabs.keepOpen: false` (global) forces **exit** for every agent, even `auto-exit: false` ones.
- `tabs.keepOpen: true` delegates to the agent: `auto-exit: true` ⇒ **exit** (session + tab close), `auto-exit: false` ⇒ **keep** (session stays interactive, tab left open, completion reported once via `.done`).
- The legacy `PI_SUBAGENT_KEEP_TAB` env var is removed — `tabs.keepOpen` in `config.json` is the sole truth.

Notes:

- **Manual input does not strand an auto-exit sub-agent.** If a human types into the tab, the session still closes once that turn completes normally — only an escape/abort leaves it open.
- **Auto-exit is suppressed while work is in flight:** the session parks as `waiting` instead of exiting when an `ask_question` is still unanswered, or when the agent's own child sub-agents are still running (a worker can stop after dispatching children and stays open until the last result returns).

### interactive

Controls whether `stalled`/`recovered` status transitions send a steer message to the parent session. Defaults to the inverse of `auto-exit`: autonomous agents get stall pings; user-driven agents stay quiet (the user is already working in that tab — the widget still updates). Set explicitly to override.

## Tool access control

Access is **whitelist-only**. Every sub-agent process is launched with `--no-extensions` (extension discovery disabled) and `--tools <allowlist>`; only the extensions backing the listed tools are loaded back in explicitly. An agent gets exactly what its frontmatter `tools` lists — or, when the header is omitted, the `read, write, edit, bash` baseline. `ask_question` is always added on top, and the spawning toolset only when `subagent_agents` grants it (`true` or a list). The restriction survives resume via the loadout snapshot.

Spawns must name a known agent at **every** depth. A top-level session may spawn anything discoverable; a sub-agent may only spawn what its `subagent_agents` allows — any agent for `true`, only the listed agents for a list (enforced via `PI_SUBAGENT_ALLOWED`; missing or `false` means it cannot spawn at all). There is no agentless spawn route, so a child can never escalate to a full-toolset profile by omitting its agent.

Extensions can register additional tools for sub-agents at runtime via `registerToolExtension(name, path)` on the `__pi_interactive_subagents` process global.

## Role folders

`cwd` starts a sub-agent in a directory with its own config, so role-specific setups (CLAUDE.md, skills, extensions) apply:

```
project/
└── agents/
    ├── game-designer/   ← CLAUDE.md, .pi/…
    └── sre/             ← CLAUDE.md, .pi/…
```

```typescript
subagent({ agent: "worker", cwd: "agents/sre", task: "Review the deployment pipeline" });
```

Set a per-agent default with `cwd:` in frontmatter.

## Status widget & configuration

The widget tracks each sub-agent from a runtime activity snapshot written by the child: `starting`, `active` (turn/provider/tool work), `waiting` (open for input or another stage), `stalled` (no valid snapshot for too long), or `running` (fallback). Sub-agent sessions also show their own tools widget — toggle it with `Ctrl+Alt+O`. Completion messages expand with `Ctrl+O`.

The extension is configured via `config.json` in the extension directory (copy `config.json.example`; it's
gitignored). Applies on `/reload`, no pi restart needed:

```json
{
  "status": { "enabled": true },
  "tabs": { "keepOpen": false }
}
```

| Key | Default | Description |
| --- | ------- | ----------- |
| `status.enabled` | `true` | Live per-subagent status in the widget (active tool, waits, stall/recovery pings) |
| `tabs.keepOpen` | `false` | Global keep switch: `false` always closes session + tab; `true` delegates to the agent's `auto-exit` (`true` closes, `false` leaves tab open with pi interactive — see `docs/EXIT-KEEP-PRECEDENCE.md`) |

## Requirements

- [pi](https://github.com/badlogic/pi-mono)
- [kitty](https://sw.kovidgoyal.net/kitty/) with remote control enabled

```bash
# in kitty.conf (both lines REQUIRED — then restart kitty):
allow_remote_control yes
listen_on unix:/tmp/kitty-$USER
```

Then run pi inside kitty as usual (`pi`). The `listen_on` socket is mandatory, not optional: without it every
`kitty @` call travels over the main session's own terminal, kitty's responses land in that same input stream,
and pi's TUI competes with the CLI for the bytes — worker output leaks into the main input box and the session
becomes unusably slow. The socket keeps all control traffic off the terminal. If subagents refuse with a setup
hint, it means the socket isn't visible (`echo $KITTY_LISTEN_ON` should print the path; if empty, kitty was not
restarted after editing `kitty.conf`).

## Acknowledgements

Forked from [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents), which originated the subagent architecture, the multi-multiplexer surface layer, and the status widget; its supervision features were inspired by [RepoPrompt](https://repoprompt.com/).

## License

MIT
