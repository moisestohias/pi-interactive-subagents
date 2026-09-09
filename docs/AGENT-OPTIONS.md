# Agent options (quick reference)

Brief overview of the three frontmatter fields used together by the bundled `worker` agent. See `NESTED-SPAWNING.md` and `SYSTEM-PROMPT.md` for details.

```markdown
---
name: worker
subagent_agents: scout, researcher
system-prompt: append
auto-exit: true
---
```

* `subagent_agents: scout, researcher` — grants the child the spawning toolset (`subagent`, `subagent_message`, `subagents_list`; canonical in `pi-extension/subagents/agents.ts`, allowlist built by `buildSubagentToolAllowlist` in `pi-extension/subagents/launch.ts`) and restricts it to spawning only the listed agents. `true` grants the same toolset with no restriction (may spawn any agent). Omitted, empty, or `false` means the child cannot spawn at all (how `scout` / `researcher` work).
* `system-prompt: append` — the body below the frontmatter is passed as `--append-system-prompt`, so the identity is added on top of the default pi prompt. `replace` swaps the default prompt out instead; omitted means the body is prepended to the task prompt.
* `auto-exit: true` — the session shuts down when the agent's turn ends, with its last message returned to the parent as the result. There is no "done" tool — it just stops. Exit is deferred while an `ask_question` is unanswered or its own child subagents are still running.
