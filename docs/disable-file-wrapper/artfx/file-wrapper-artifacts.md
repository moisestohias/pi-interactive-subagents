# `@file` wrapper artifacts in subagent prompts

> Scope note: this is not specific to this kitty port. The original
> `pi-interactive-subagents` extension (tmux/cmux path: `launchSubagent` +
> `cmux.ts` `send-keys bash <script>.sh` → `pi --session ... @artifact.md`)
> and its forks all deliver the task as an `@file` artifact, so they all use
> the same mechanism described below.

## What happens: `@file` wraps its content — by design

When this extension spawns a subagent, it delivers the task with pi core's
`@file` mechanism: `pi --session ... @<artifact>.md`. Pi core expands every
`@file` CLI argument into `<file name="…">content</file>` text before the
model sees it (`file-processor.js`).

**This wrapper is expected core behavior, not a bug, and this extension cannot
remove it as long as delivery uses `@file`.**

The wrapper can also appear more than once. If the parent has an `@file`
expanded into its context, the parent LLM may copy that `<file>` block into
the `task` it passes along, and artifact delivery then wraps it again. Nested
`<file>` blocks are therefore also expected — a natural result of how `@file`
content flows, not a defect.

None of this is a problem to solve in general. The only scenario we care about
is spawning subagents, described below, where we may want the child to receive
the content cleanly instead of as a nested snapshot.

## Background: how Pi's `@file` is meant to work

`pi @task.md "do X"` reads `task.md` from disk and prepends it to the first
user message, wrapped so the model can tell file content apart from the typed
instruction:

```
<file name="/abs/task.md">
...file content...
</file>
```

This extension launches subagents the same way: it assembles the prompt (role
+ mode hint + task + summary instruction), writes it to a per-run artifact
file, then runs `pi --session ... @artifact.md`. The child sees one top-level
wrapper, `<file name=".../context/w-<ts>.md">`. This is the intended shape.

## Where `@file` is implemented in Pi core

Verified against the installed Pi (`@earendil-works/pi-coding-agent@0.84.1`;
binary `~/.local/bin/pi -> ../lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js`).
`@file` handling happens only at CLI startup, across 4 files in one pipeline:

1. **Split `@` arguments from messages — `dist/cli/args.js:parseArgs()`**
   ```js
   else if (arg.startsWith("@")) {
       result.fileArgs.push(arg.slice(1)); // Remove @ prefix
   }
   ```
   This is the only producer of `parsed.fileArgs`. Everything else goes into
   `parsed.messages`. (The same `--print`/`-p` rule applies: the message after
   `-p` is consumed as `messages[0]` unless it starts with `@`.)

2. **Expand to `<file>` text — `dist/cli/file-processor.js:processFileArguments(fileArgs, options)`**
   This is the function this doc is named after. It is the only emitter of
   `<file name=...` in all of `dist/` (confirmed by grep: 4 emission sites,
   all in this file):
   - text file: `` `<file name="${absolutePath}">\n${content}\n</file>\n` ``
   - image, processed with hints: `<file name="...">hints</file>` plus an
     `ImageContent` attachment
   - image, processed without hints: `<file name="..."></file>` (empty body)
     plus the attachment
   - image, processing failed: `<file name="...">error message</file>` (no
     attachment)

   Per-argument preprocessing: the path is resolved with
   `resolve(resolveReadPath(arg, process.cwd()))` (this handles `~` expansion
   and macOS screenshot Unicode spaces). Then an `access()` check exits the
   process on a missing file (`console.error + process.exit(1)`), a `stat()`
   check silently skips an empty file (`size === 0`), and a text read failure
   does `console.error + process.exit(1)`.

3. **Assemble the initial prompt — `dist/cli/initial-message.js:buildInitialMessage()`**
   ```js
   parts = [stdinContent?, fileText?, messages[0]?].join("")
   ```
   (`messages[0]` is consumed via `shift()`; the remaining `messages` become
   follow-up turns.)

4. **Orchestrate — `dist/main.js:prepareInitialMessage(parsed, autoResizeImages, stdinContent)` (~L173)**
   ```js
   if (parsed.fileArgs.length === 0) return buildInitialMessage({ parsed, stdinContent });
   const { text, images } = await processFileArguments(parsed.fileArgs, { autoResizeImages });
   return buildInitialMessage({ parsed, fileText: text, fileImages: images, stdinContent });
   ```
   The call site (~L706) passes `readPipedStdin()` and
   `settingsManager.getImageAutoResize()`. A guard (~L508) makes `@file` a
   hard error in `--mode rpc`: `"Error: @file arguments are not supported in
   RPC mode"` followed by `exit(1)`.

Three consequences worth remembering:

- Expansion happens once, at process startup. So typing `@path` into a live
  TUI tab never expands it.
- Images arrive as binary attachments, which do not survive a
  `subagent({ task })` tool-call copy.
- Ordering is always: stdin → file block(s) → first positional message.

## The one scenario: spawning subagents

We do not try to change the wrapper in general. The single case where we may
want to work around it is spawning a subagent whose parent task already
contains expanded `<file>` blocks. There we can choose to hand the child the
content cleanly, instead of as a stale, re-wrapped, nested snapshot.

Any such workaround stays narrow and follows these constraints:

1. The outer `@artifact` wrapper always stays. It is the accepted cost of
   `@file` delivery.
2. Only parent-originated blocks may be transformed. Put that logic in
   `launch.ts` (single home) with thin wiring in the `lifecycle.ts` launch
   path and in `handlers/message.ts` resume. Never shell out to `kitty @`
   outside `kitty.ts`. Quote via `shellEscape`. Keep `buildPiPromptArgs`
   byte-identical when the new parameter is absent, so existing snapshots
   pass untouched.
3. Core's `processFileArguments` calls `process.exit(1)` on a missing `@file`
   and silently skips an empty one. So any re-attach **must** pre-filter with
   `existsSync` + `statSync.size > 0`. Missing or empty files stay inline.
   Dedupe repeats and cap the count (`MAX_EMBEDDED_FILES_PER_TASK = 10`).
4. A relative `<file name>` resolves against the **parent** `ctx.cwd` (where
   the `@` was typed). Emit absolute paths for the child.
5. Regression tests are required (`test/bugfixes.test.ts`, importing homes
   directly per M3 — never add new `__test__` keys). Extension changes only
   take effect on `/reload`, so retest only after reloading.
6. The 4 `subagent discovery` failures in `test/test.ts` are pre-existing
   (local `agents/*.md` vs. bundled defaults; see AGENTS.md). Ignore them
   unless you touch `agents.ts` discovery.

## Invalid suggestions (do not propose these)

- **"Regex-strip the `<file>` tags before launch."** Stripping the outer
  wrapper is pointless, because core re-adds it when it expands `@artifact`.
  Stripping nested blocks without re-attaching the paths *destroys*
  information: the child loses both the content and the path.
- **"Pipe the task via stdin to avoid the wrapper."** The child runs
  **interactive** in a kitty tab, so stdin is the terminal. Redirecting stdin
  breaks interactivity. `stdinContent` only applies to print/rpc entry, not a
  live tab.
- **"Pass `@path` in a steer message to a running tab."** Typing `@path` into
  a live TUI does not expand it (expansion happens at process startup, in
  `file-processor.js`), and `flattenSteerMessage` collapses newlines anyway,
  so a pasted file body becomes one giant line. Steers must carry
  read-it-yourself instructions, never content.
- **"Fix the Claude backend the same way."** Out of scope.
  `buildClaudeCommand` takes an inline prompt; there is no `@` mechanism on
  that path.
- **"Seed the initial message into the session `.jsonl`."** Rejected:
  `session/seed.ts` hand-tracks pi's session schema (`version: 3`, Compat-6
  comment). Extending it to user messages deepens a known compatibility
  hazard. Only revisit this with a pi-version-pinned schema test.
- **"Change `session-mode` to fork to avoid it."** Fork still pastes parent
  blocks via direct delivery, so mode choice is not a workaround.
