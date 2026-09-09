# Nested spawning (`subagent_agents`)

Sub-agents can spawn their own sub-agents only if their agent definition opts in via the `subagent_agents` frontmatter field.

```markdown
---
name: worker
tools: read, write, edit, bash, web_search, web_fetch
subagent_agents: scout, researcher
---
```

* **`true`:** child is launched with `--tools` including `subagent, subagent_message, subagents_list` (see `buildSubagentToolAllowlist` in `pi-extension/subagents/index.ts`) and this extension loaded via `-e`, with no `PI_SUBAGENT_ALLOWED` pin — it may spawn any discoverable agent.
* **Non-empty list:** same toolset grant, but `PI_SUBAGENT_ALLOWED=<list>` is set. It may spawn only the listed agents (enforced via `permittedSet` in `subagent.execute`).
* **Omitted, empty, or `false`:** no spawning tools, no `PI_SUBAGENT_ALLOWED` — the child cannot spawn at all. This is how `scout` / `researcher` work today.

To unplug nesting from `worker`: delete the `subagent_agents:` line from `agents/worker.md` (or set it to `false`) and remove its `## Delegation` prompt section (otherwise it will try to call a tool it no longer has). No code change needed.

Notes:
* Resume replays the grant from `<session>.loadout.json` (tool allowlist + spawn list), so pre-existing workers keep their old grant; only new spawns are affected. Unrestricted (`true`) persists as "spawning tools granted, no list pinned".
* Trade-off: without delegation the orchestrator must `scout` first and hand `worker` explicit file paths.
