# Exit vs keep-open precedence (`tabs.keepOpen` × `auto-exit`)

Two knobs control whether a finished sub-agent closes its pi session + kitty
tab or stays open and interactive. They used to conflict — this file is the
contract.

## The two knobs

| Knob | Where | Scope | Meaning |
| ---- | ----- | ----- | ------- |
| `keepOpen` | `config.json` → `tabs.keepOpen` (boolean, default `false`) | **Global** — every sub-agent | Main switch. `false` = always close. `true` = allow staying open. |
| `auto-exit` | `agents/<name>.md` frontmatter → `auto-exit: true/false` | **Per-agent** | `true` = autonomous, shut down when the turn ends. `false` = user-driven, stay open. |

## Precedence table (the rule)

`config.json` wins. `keepOpen: false` forces exit no matter what the agent says.
`keepOpen: true` delegates the decision to the agent's `auto-exit`.

| `tabs.keepOpen` | agent `auto-exit` | Result | Session | Kitty tab | Parent signal |
| --------------- | ----------------- | ------ | ------- | --------- | ------------- |
| `false` | `true` | **EXIT** | `ctx.shutdown()` | closed | sentinel / `.exit` on error |
| `false` | `false` | **EXIT** (forced) | `ctx.shutdown()` | closed | sentinel / `.exit` on error |
| `true` | `true` | **EXIT** | `ctx.shutdown()` | closed | sentinel / `.exit` on error |
| `true` | `false` | **KEEP** | stays interactive | left open | `.done` once (`.exit` on error) |

In short:

```
keep ⇔ (keepOpen && !autoExit)
exit ⇔ !keep  ⇔  (!keepOpen || autoExit)
```

Only the last row keeps anything open. Every other combination closes both the
pi session and the tab.

## How it is wired (no `PI_SUBAGENT_KEEP_TAB`)

The legacy `PI_SUBAGENT_KEEP_TAB` env wire is **removed**. It is never set,
never read, and explicitly scrubbed:

- Parent (keep/exit rule canonical in `pi-extension/subagents/keep.ts` as
  `resolveKeepDecision`, wired in `index.ts`) loads `tabs.keepOpen` from
  `config.json` (sole truth, re-read fresh — refreshed on `session_start`)
  and the agent's `auto-exit` from frontmatter, computes per-run
  `keepSurface = keepOpen && !autoExit` and `effectiveAutoExit = !keepSurface`.
  - `effectiveAutoExit` is encoded into the child's `PI_SUBAGENT_AUTO_EXIT=1`.
    Note this means a `keepOpen: false` + `auto-exit: false` agent still gets
    `PI_SUBAGENT_AUTO_EXIT=1` — the global forces exit.
  - `keepSurface` is stored on `RunningSubagent` and drives `maybeCloseSurface()`
    + `surfaceKept` (tab close + "tab left open" notice + registry `surface?`).
  - Launch/resume commands start with `unset PI_SUBAGENT_KEEP_TAB;` so a stale
    export in the user's dotfiles/shell can never leak into the child via shell
    inheritance. The parent process also deletes it on load.
- Child (`pi-extension/subagents/subagent-done.ts`) only reads
  `PI_SUBAGENT_AUTO_EXIT`. It deletes `PI_SUBAGENT_KEEP_TAB` if inherited and
  never consults it.
  - `autoExit=true` (all exit rows) → `ctx.shutdown()` on a finished turn.
  - `autoExit=false` (only the keep row) → stay interactive, write
    `${session}.done` once (or `${session}.exit` on `stopReason: error`).
- Watcher (`kitty.ts` `pollForExit`) is unchanged: `.exit` wins, then `.done`,
  then the `__SUBAGENT_DONE_<code>__` terminal sentinel. `.done` only ever
  appears on keep runs.

## Kept tabs stay supervised (second life after `.done`)

The spawn watcher exits on the first `.done`, but the tab is still alive and
interactive — the user (or the agent) can keep working there and call
`ask_question` again. A second lightweight monitor (`monitorKeptTab`) starts
when the first result is delivered:

- Relays later `.ask` signals live (same `subagent_question` steer).
- Reports a later agent-loop error (`.exit`) as a failure result.
- Ends silently when the tab closes (clears the registry `surface` so a later
  resume is allowed).
- Re-attaches on `session_start` from registry entries whose tab is still
  alive, so kept tabs survive `/reload` too.

## Messaging a kept tab

`subagent_message({ name, message })` routes running → kept (steer text into
the live tab, same process — safe) → resume relaunch. A kept tab is one live
pi process, so steering into it is exactly like steering a running subagent.
Only a *relaunch* is refused while the tab is alive (two pi processes must
never append to one `.jsonl`); close the tab and retry for that case.

## Resume

`subagent_message({ name })` resume is always autonomous (`autoExit: true`), so
per the table it **always exits** — even with `tabs.keepOpen: true`. Resume
always sets `PI_SUBAGENT_AUTO_EXIT=1`, never keeps, stores `keepSurface: false`.

## Deferred exit (unchanged)

Exit is deferred while work is in flight, on every row:

- `ask_question` unanswered (`awaitingAnswer`) → park as `waiting`.
- Own child sub-agents still running (`runningChildrenCount() > 0`) → park.
- `stopReason: aborted` (Escape) → never counts as a finished turn, stays open.

## Examples

```jsonc
// config.json — global switch
{ "status": { "enabled": true }, "tabs": { "keepOpen": true } }
```

```markdown
---
name: scout
auto-exit: true   // with keepOpen:true → EXIT (closes)
---
```

```markdown
---
name: my-interactive
auto-exit: false  // with keepOpen:true → KEEP (stays open + .done once)
                  // with keepOpen:false → EXIT (forced, global wins)
---
```

## Config reference

```jsonc
// config.json — global switch (+ status options)
{
  "status": { "enabled": true, "lineLimit": 4 },
  "tabs": { "keepOpen": true }
}
```

- `status.lineLimit` (positive int, default `4`) caps how many stall/recovery
  lines one notification carries. Unknown/invalid config keys fail loudly
  (invalid files are logged and surfaced, never silently defaulted) — only a
  *missing* config falls back to defaults.

## Files

- `pi-extension/subagents/keep.ts` — `resolveKeepDecision()` (the rule) +
  per-agent/resume variants; `index.ts` keeps thin `shouldKeep*` wrappers.
  `maybeCloseSurface(surface, keepSurface?)`, `RunningSubagent.keepSurface/autoExit`.
- `pi-extension/subagents/subagent-done.ts` — child exit/`.done` on `PI_SUBAGENT_AUTO_EXIT` only.
- `pi-extension/subagents/kitty.ts` — `takeCompletionSidecar` (`.exit` > `.done`, claimed atomically so a corrupt sidecar can't poison the poll loop).
- `pi-extension/subagents/status.ts` — `parseTabsConfig` / `parseStatusConfig` / `loadExtensionConfig`; `config.ts` — fresh reads + `session_start` refresh.
