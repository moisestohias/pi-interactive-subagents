# System prompt (`system-prompt`)

The `system-prompt` frontmatter field controls how the agent definition body is delivered to the child session.

```markdown
---
name: scout
system-prompt: append
---

You are a scout agent. Quickly investigate...
```

* `append` — body is passed as `--append-system-prompt`. Default pi prompt is kept, identity is added. This is what the bundled `scout` / `researcher` / `worker` agents use.
* `replace` — body is passed as `--system-prompt`. Default pi prompt is replaced.
* Omitted or invalid — body is not a system prompt; it is prepended to the `task` prompt instead.

Notes:
* Resume replays the mode from `<session>.loadout.json`, so changing the field only affects new spawns.
* `cli: claude` agents always use `--append-system-prompt`; the `replace` mode only applies to the pi CLI path.
