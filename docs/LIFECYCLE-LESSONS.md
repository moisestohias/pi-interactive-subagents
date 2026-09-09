# Subagent lifecycle lessons learned

Hard-won knowledge from supervising subagent sessions across `tabs.keepOpen` ×
`auto-exit` runs. Same format as `KITTY-LESSONS.md`: **rule → why → what we do**.
The incident that taught 1–3 is written up in `ASK-QUESTION-FINDINGS.md`;
the contract they protect is `EXIT-KEEP-PRECEDENCE.md`.

## 1. A keep-open completion is not the end of supervision

**Rule:** when the first `.done` leaves the tab open, start a second monitor that lives until the tab dies.

**Why:** the spawn watcher exits on the first completion signal — correctly, the
run is over and its result is delivered. But a kept tab (`keepOpen` + 
`auto-exit:false`) is still a live pi session: the user can keep working in it
and it can call `ask_question` again. With no watcher, the next `.ask` file
sits orphaned forever (we watched this happen: turn 1 → `.done` at :22,
turn 2 → `.ask` at :46, delivered only by a manual `/reload` at :58).

**What we do:** `trackKeptTab()` + `monitorKeptTab()` start on every
`surfaceKept` result — relay later `.ask` live, report a later `.exit` error,
end silently on tab close (clearing the registry `surface` so resume is allowed
again).

## 2. Route replies by tab liveness, not by registry alone

**Rule:** `subagent_message` goes running → kept (steer) → resume relaunch; only the *relaunch* is refused while a tab is alive.

**Why:** after `.done` the name leaves the running map, so replies fell into
the resume path and hit the kept-tab double-open guard ("close the tab and
retry") — the user sees "response not delivered". But typing into the live tab
addresses the *same* pi process, so it is exactly as safe as steering a running
subagent. Only launching a *second* pi on the same `.jsonl` corrupts it.

**What we do:** `findKeptTab()` (with a liveness check) steers into the live
tab; the refusal now only covers the relaunch case. Dead entries are pruned and
their stale registry `surface` cleared on the spot.

## 3. Thread the session handle; never trust a module global for delivery

**Rule:** watchers and monitors carry the spawner's own `pi` instance.

**Why:** `latestPi` points at whatever session loaded last — in a multi-session
process or across `/reload` that is a different (or dead) session. Results
already used the spawn closure's `pi`; questions used the global, so they could
be delivered to the wrong place or nowhere.

**What we do:** `watchSubagent(running, signal, pi)` and
`monitorKeptTab(kept, pi)`; the global is only a fallback.

## 4. Consume signals after successful delivery, not before

**Rule:** send-then-delete; a failed send keeps the file for the next tick.

**Why:** the old code unlinked the `.ask` before `sendMessage`, so a throw (or
a null target) lost the question permanently with no trace. File signals are
cheap to re-read and self-describing; the 1–2s retry costs nothing.

**What we do:** `deliverPendingQuestion` returns `boolean`, unlinks only on
success (malformed payloads are still dropped). Same posture in recovery.

## 5. Rebuild supervision on `session_start` — watchers die with the process

**Rule:** every `session_start` replays orphan `.ask` recovery *and* re-attaches
kept-tab monitors from the registry.

**Why:** shutdown/reload aborts every watcher (`session_shutdown` clears the
maps). Anything parked at that moment — an unanswered question, a live kept tab
— becomes invisible to the fresh process. The registry (`surface` + session
file) plus a liveness probe (`windowExists`) is sufficient to resurrect exactly
the supervision that is still meaningful, and delivery consumes the file so a
racing live tick can't double-fire.

**What we do:** `recoverPendingQuestions()` then registry scan in the
`session_start` handler, each entry guarded so a bad row never breaks startup.

## 6. Key per-session state by session, not by name alone

**Rule:** names are unique per spawner session — keys must include the session.

**Why:** the process can host several spawner sessions at once; two sessions
can each have a `worker`. A global name-keyed map routes replies and monitors
to the wrong tab.

**What we do:** `keptKey(artifactDir, name)` everywhere; lookups always carry
the caller's artifact dir.

## 7. Make the invisible round-trip traceable while diagnosing

**Rule:** when supervision fails silently, add temporary file tracing (watcher
start/exit, `.ask` seen/sent, steer attempts, recovery hits), then remove it
once the regression tests pin the fix.

**Why:** supervision failures are silent by construction — no turn fires, no
error surfaces, both sides just wait. A temporary log turned "still not
working" into a timestamped causal chain in one exchange (`watch:exit-seen
done` eight seconds before the question existed). File tracing is a diagnostic
scaffold, not a feature: it costs ~1 line/sec per watched tab, so it comes out
when the tests go in.
