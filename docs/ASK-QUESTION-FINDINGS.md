# ask_question round-trip findings (2026-09-09)

Sub-agents could call `ask_question`, but the parent never received the
question live (only after a manual `/reload`), and the parent's reply never
reached the sub-agent.

## Evidence

Live trace (temporary file logging, since removed):

```
12:29:14  watch:start worker ... surface=63 hasPi=true
12:29:22  watch:exit-seen worker done code=0        ← .done consumed, watcher EXITED
12:29:44  (manual follow-up typed into the kept tab; child calls ask_question)
12:29:58  recover:found worker ... ask:sending ... ask:sent   ← only /reload delivered it
```

Child transcript
(`sessions/--home-moises-Documents-Notes--/2026-09-09T12-29-14-090Z_*.jsonl`):

- Turn 1 (12:29:15–12:29:21): task done, `## Completed` → child wrote `.done`.
- Turn 2 (12:29:44): manual `ask main/parent session what's next` → `ask_question`
  tool ran (`Question sent to the orchestrator…`), `.ask` written, session parked.
- Turn 3 (12:29:48): `Awaiting parent session reply.` — parked, never answered.

Three older orphans showed the same pattern (`.ask` files from 12:15/12:18/12:21
never consumed by any live watcher).

## Root causes

1. **Kept tabs outlived their watcher.** For keep-open runs (`tabs.keepOpen` +
   `auto-exit:false`) the spawn watcher exits on the first `.done` (result
   delivered, tab left open). Any *later* `ask_question` — e.g. after manual
   follow-ups in the kept tab — had no live tick to pick up the `.ask` file.
   Only the `session_start` orphan recovery (added earlier) delivered it, hence
   "works after /reload".
2. **Replies to kept tabs were refused.** After `.done` the name leaves
   `runningSubagents`, so `subagent_message` fell into the resume path and hit
   the kept-tab double-open guard (`still open in its kept tab… close the tab
   and retry`). Steering text into the *live* tab is safe (same pi process);
   only a *relaunch* risks two writers on one `.jsonl`.
3. **(Earlier, fixed) Wrong session handle + delete-before-send.**
   `deliverPendingQuestion` used the module-global `latestPi` instead of the
   spawner's `pi`, and unlinked the `.ask` before sending — a failed send lost
   the question. Now threaded per-spawn with send-then-delete (kept for retry).

## Fixes (`pi-extension/subagents/index.ts`)

- `keptTabs` map (keyed by spawner artifact dir + name) + `monitorKeptTab()`:
  starts when the first `.done` result is delivered with `surfaceKept`; relays
  later `.ask` live, reports a later `.exit` error, ends silently on tab close
  (clearing the registry `surface` so resume is allowed again).
- `subagent_message` routing is now running → kept (**steer** into the live tab)
  → resume relaunch (still refused while the tab is alive).
- `session_start` re-attaches monitors for registry entries whose tab is still
  alive (`windowExists`), so kept tabs survive `/reload`; orphan `.ask` recovery
  still runs first.
- `session_shutdown` aborts kept monitors too.
- Kept-tab tests: live-tab lookup, dead-tab prune + registry clear
  (`test/test.ts`, `ask_question delivery` suite).

## Expected behavior now

1. Turn 1 completes → result steered, tab kept, `kept:monitor-start` in the log.
2. Later `ask_question` from the kept tab → `ask:tick-seen → ask:sent` within
   ~2s, no reload needed.
3. Reply via `subagent_message({ name, message })` → `steer:kept-sent`, child
   picks it up next turn. Only a full session *relaunch* while the tab is alive
   is refused.

## Open notes

- At the time of writing, `~/.pi/agent/agents/worker.md` shadowed the bundled
  worker. Its current headers (`auto-exit: false`, `system-prompt: replace`,
  `subagent_agents: true`) mean: with `keepOpen: true` workers land on the KEEP
  row (tabs stay open), run with a replaced system prompt, and may spawn any
  agent. Pre-existing local config, unrelated to this fix — flagging because it
  changes which precedence-table row, prompt mode, and spawn gate workers land on.
- Temporary file tracing used during diagnosis is removed; the regression
  tests in `test/test.ts` (`ask_question delivery` suite) pin the fixed behavior.
