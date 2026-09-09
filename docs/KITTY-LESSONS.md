# Kitty remote-control lessons learned

Hard-won knowledge from running subagents in kitty tabs. Each lesson is stated as **rule → why → what we do**. Sources: kitty 0.44.0 docs under `~/.local/kitty.app/share/doc/kitty/html/_sources/` plus live debugging. Two of
these bit us in production (1, 2); the rest are defenses we built in before they could.

## 1. Never control kitty over the shared terminal — require a socket

**Rule:** `KITTY_LISTEN_ON` must be set; refuse to run without it.

**Why:** without `--to <socket>`, `kitty @` sends its request as an escape sequence to the controlling terminal and kitty delivers the *response as input bytes on that same tty*. A TUI app (pi) reading that tty races the CLI for those bytes, both directions. We saw both failure modes live: worker screen text (from the 1s `get-text` poll) leaking into the main session's input box, and the main session becoming unusably slow from the constant
query/response contention. An interactive shell tolerates this; a TUI host with a poller does not.

**What we do:** `isKittyAvailable()` requires the socket var, not just "running under kitty". The refusal message carries the exact setup (`allow_remote_control yes` + `listen_on`, restart kitty). Every `kitty @` invocation goes
through one helper that always passes `--to`. See `HOW-IT-WORKS.md` requirements and `KITTY-TABS-ANALYSIS.md` §10.

## 2. `send-text` / `send-key` lie about delivery

**Rule:** verify the target exists before sending; treat send as fire-and-forget.

**Why:** both commands "always succeed, even if no text was sent to any window" (docs + `--help`). Steering a closed tab reports success while the message evaporates — the worst failure mode in an orchestration system, because both sides believe the other side has it (e.g. a reply to a parked `ask_question` that never arrives).

**What we do:** `sendCommand` checks liveness (parsed from `kitty @ ls`) first. A positively-gone tab throws an honest "tab is gone" error the caller surfaces; a *control-plane failure* (dead socket, corrupt `ls` JSON) throws a distinct retryable error instead of reporting death (`windowExistsOrNull()` tri-state; the boolean `windowExists()` wrapper is legacy). Kept-tab pruning and the resume double-open guard treat "unknown" conservatively — never prune a live tab on a socket hiccup, never double-open a session file. Known residual: a TOCTOU race if the tab dies between check and send — accepted and noted in code; the next 1s poller tick surfaces the death anyway. Sends are rare (launch + human-scale replies), so the extra `ls` round-trip costs nothing steady-state.

## 3. Always match by numeric `id:`, never by title

**Rule:** surface handles are validated (`/^\d+$/`) and every command uses `--match id:<n>`. No command ever addresses the active/default window.
  
**Why:** title matches are regexes, non-unique, and child-controlled (prompt escape sequences can rewrite titles) — an injection and misdelivery vector. And the no-match default (active window) is exactly "type into the main session's input", the thing we must never do. Numeric ids are exact and unforgeable from inside the child.

**What we do:** `matchFor()` guards all five addressed commands (send-text, send-key, get-text, close-window, focus-window). `PI_SUBAGENT_SURFACE` is write-only, so the handle representation is an internal detail.

## 4. Send payloads via `--stdin`, submit with `send-key enter`

**Rule:** never put message bytes in argv; Enter is a separate key event.

**Why:** `send-text` applies Python escaping rules to its text argument, so backslashes in real content (paths, regexes) can turn into control characters — including newlines that would submit partial turns early in the child's editor. `--stdin` carries bytes raw. The trailing submit must still be a real Enter keystroke, matching tmux's old
`send-keys -l` + `Enter` split (and the steer path still flattens newlines first, since any newline submits).

**What we do:** `sendCommand` = `send-text --match id: --stdin` (body) then `send-key --match id: enter`. Long commands keep going through script files (`sendLongCommand`), so arbitrary bytes never even reach the sender.

## 5. `get-text` extents are a cost decision, not just semantics

**Rule:** `screen` for small reads, `all` only for deep ones (we split at 100 lines).

**Why:** `all` returns the entire scrollback — fine occasionally, but our exit poller reads every second, and dragging megabytes per tick for a 5-line sentinel check is pure waste. tmux's `capture-pane -S -N` had the cost built in; kitty makes you choose.

**What we do:** `extentFor()` in `readScreen`/`readScreenAsync`. The sentinel poll (5 lines) stays on `screen` where the prompt output always is; only the 200-line fallback pays for scrollback. Plain text (no `--ansi`) throughout.

## 6. `launch --type=tab --dont-take-focus` preserves the focus contract

**Rule:** every tab opens in the background; remote commands never move focus.

**Why:** the extension's core UX guarantee is "spawning never steals keyboard focus" (the tmux era did this with `split-window -d` targeting `$TMUX_PANE`). Kitty's equivalent is `--dont-take-focus` on launch; addressed send/get/close never focus by construction. New tabs land in the current OS window, so the old parent-pane targeting simply has no equivalent and isn't needed.

**What we do:** `createSurface` always passes the flag; splits/directions are accepted-but-ignored (tabs-first, one full-width tab per agent — which also deleted the entire layout-rebalancing code path). Re-prove with the ported focus integration test, since the mechanism is new.

## 7. Closing is fire-and-forget the other way: tolerate "already gone"

**Rule:** closes must never fail a watcher.

**Why:** the interesting close cases are all races — user closed the tab after the sentinel printed, process exited between poll and close, double-close in cleanup. Any of these makes `close-window` error, and an error there would convert a success into a failure report.

**What we do:** same posture as the tmux era (`kill-pane` throws too): closes happen inside try/catch paths whose failure mode is already defined. Don't add `ignore_no_match` cleverness beyond that; keep the throw semantics so callers — not the layer — decide.

## 8. Probe availability actively; fail at the boundary with the fix attached

**Rule:** `isKittyAvailable()` (canonical; `isMuxAvailable` remains as an alias) gates every spawn/resume; every layer error carries the setup hint.

**Why:** env vars (`KITTY_WINDOW_ID`, even `KITTY_PID`) can be present while control is unusable (tty-only setup, stale socket, hardened auth). A cheap env check that says "available" followed by a mid-spawn failure strands a half-built subagent. Every error from the layer already includes `muxSetupHint()`, so the worst case is a clean
refusal naming both config lines — never a half-spawn and never corruption.

**What we do:** gate on socket + binary; wrap `kittenSync`/`kittenAsync` errors with the hint in one place (`createSurface` doesn't double-wrap). The binary probe passes its argument positionally (no shell interpolation) and only caches positive results, so installing kitty is picked up without restarting pi. Password hardening (`KITTY_RC_PASSWORD`/rc-pass) needs no code — it's env passthrough — but never "fix" auth by downgrading the user's setting.

## 9. Keep the surface layer boring and total

**Rule:** the layer owns *all* terminal contact; nothing above it shells out to kitty.

**Why:** every lesson above is enforced in exactly one place (`kitty.ts`: `--to` injection, id validation, existence check, extent choice, error wrapping). The orchestrator (`index.ts`) changed by one import plus strings, which is why the whole unit suite survived the migration untouched.

**What we do:** the layer owns *all* terminal contact; nothing above it shells out to kitty. API additions since the migration: `windowExistsOrNull` (lesson 2's tri-state requirement); `createSurfaceSplit` is deprecated (tabs-first, pass `createSurface`). The archived tmux layer is gone — no reference implementation remains. If kitty changes something, exactly one file changes.
