# Pi core `@file` wrapper opt-out

Two backward-compatible core changes: a global flag and a per-file raw syntax.

> Scope: Pi core changes only. This doc builds on `file-wrapper-artifacts.md`.
>
> Status: Proposal A is implemented and enabled by default (core `--disable-file-wrapper` patched into the installed pi `0.84.1` dist; extension resolves raw delivery via `resolveRawArtifact` in `agents.ts` — absent frontmatter means raw, `raw-artifact: false` opts out — threaded through `launch.ts` / `session/loadout.ts` / `lifecycle.ts` / `handlers/message.ts`, with regression tests in `test/bugfixes.test.ts`). Extension changes take effect on `/reload`. Proposal B remains unimplemented (only needed if mixed wrapped-plus-raw in one command proves necessary).

## What `file-wrapper-artifacts.md` already established

- Pi core 0.84.1 always expands CLI `@file` args into `<file name="...">content</file>` text.
  - Done in `dist/cli/file-processor.js:processFileArguments()`.
  - Called from `dist/main.js:prepareInitialMessage()`.
  - Prompt order is `stdin → file block(s) → messages[0]` (`dist/cli/initial-message.js:buildInitialMessage()`).
- Expansion happens once, at process startup.
  - Typing `@path` into a live kitty TUI tab never expands it.
- The only producer of file args:
  - `dist/cli/args.js:parseArgs()` maps `arg.startsWith("@") → fileArgs.push(arg.slice(1))`.
- The only emitter of `<file` text:
  - 4 sites in `file-processor.js` (text, image-with-hints, image-empty, image-error).
- Missing file hard-exits (`console.error + process.exit(1)`).
  - Empty file is silently skipped.
- `@file` in `--mode rpc` is a hard error.
- Both proposals below keep all of this by default.
  - Behavior changes only when the new flag or syntax is used.

## Understanding the current mechanism

- Launch path:
  `lifecycle.ts` builds `fullTask`
  → `launch.ts:writeTaskArtifact(artifactDir, name, fullTask)`
  → `@artifactPath`
  → `buildPiLaunchPlan()` → `buildPiParts()`
  → `pi --session <sessionFile> -e subagent-done.ts [...] [@artifact]`
- Result: the child always sees one outer `<file name=".../context/w-<ts>.md">` wrapper.
- Goal: let that artifact (or any `@file`) arrive raw, with no wrapper.
  - When the caller already owns provenance (subagent launch does).
- Two options:
  - (A) A global flag that turns the wrapper off for that invocation.
  - (B) A per-file raw syntax that mixes with normal `@file` in one command.
- Recommendation: land (A) first.
  - Smallest diff, covers the subagent case (single `@artifact`).
  - Add (B) only if mixed wrapped-plus-raw in one command proves necessary.
  - They compose cleanly if both land.

## Proposal A — global `--disable-file-wrapper` flag (recommended first)

Smallest diff. Default off. Same pipeline, only the emit changes.

- Core idea:
  - `pi --session <s> --disable-file-wrapper @artifact.md` works exactly like today.
  - Except the file content is injected raw, with no `<file>` lines.
- Touch point 1 — `src/cli/args.ts:parseArgs()`.
  - Add exact match before the generic `--` branch:
    - `arg === "--disable-file-wrapper" → result.disableFileWrapper = true`.
  - Add `disableFileWrapper?: boolean` to the `Args` type.
  - Add one help line:
    - `--disable-file-wrapper  Do not wrap @file content in <file> tags (default: wrap)`.
  - Placement matters: the generic `startsWith("--") → unknownFlags` branch must not swallow it.
    - Same pattern as `--no-skills` / `--no-context-files` already use.
- Touch point 2 — `src/cli/file-processor.ts`.
  - Extend options with `wrap?: boolean` (default `true`).
  - Branch only at the 4 emission sites.
  - When `wrap !== false`: current 4 templates, byte-identical.
  - When `wrap === false`: emit raw text only.
    - Text file: `${content}\n`.
    - Image with hints: `hints.join("\n") + "\n"` (or `""` when empty).
    - Image without hints: `""`.
    - Image error: raw message, no wrapper.
  - Leave untouched:
    - Path resolution (`resolveReadPath`, `~`, screenshot spaces).
    - Missing-file `exit(1)`.
    - Empty-file skip.
    - Text read-failure `exit(1)`.
    - Image pipeline (`processImage`, `autoResizeImages`, `images[]` push).
  - Net effect: images still arrive as binary attachments in raw mode.
    - Only their text reference changes shape.
- Touch point 3 — `src/main.ts:prepareInitialMessage()`.
  - Forward the flag:
    - `processFileArguments(parsed.fileArgs, { autoResizeImages, wrap: !parsed.disableFileWrapper })`.
  - Keep `buildInitialMessage()` order: `stdin → fileText → messages[0]`.
  - Keep the rpc guard as-is (still errors on `@file`, flag or not).
- Touch point 4 — rebuild and test.
  - Rebuild `dist/` so `args.js`, `file-processor.js`, `.d.ts`, and help stay in sync.
  - Tests:
    - Default output byte-identical to today.
    - Raw output contains zero `<file` lines (text, image-hints, image-empty, image-error).
    - Missing/empty semantics identical in both modes.
    - `rpc + @file` still exits 1 with or without the flag.
- Shell and launch wiring:
  - The flag is letters plus `-` only, so existing `shellEscape` covers it.
  - Extension change is one line in `launch.ts:buildPiParts()`:
    - Push the flag only when a new opt-in plan field (e.g. `rawArtifact?: boolean`) is set.
  - Snapshots stay byte-identical when the field is absent.
  - Resume replays the flag from the `SubagentLoadout` snapshot.
  - No `kitty.ts`, widget, registry, sidecar, or Claude-path changes.
- Trade-off:
  - All-or-nothing per invocation (every `@file` in that command goes raw).
  - Fine for subagent launch (single `@artifact`).
  - Per-file mixing needs Proposal B.

## Proposal B — per-file raw `@`-syntax (follow-up if needed)

Mix wrapped and raw in one command. Full backward compatibility.

- Core idea:
  - `pi @notes.md @!task.md` delivers one wrapped plus one raw block, in CLI order.
  - Bare `@path` keeps meaning exactly what it means today.
- Spelling note:
  - `@!path` is compact but triggers bash history expansion when unquoted.
    - Safe under the extension's `shellEscape` single-quoting.
    - Annoying for hand-typed users.
  - `@path:raw` is history-safe but collides with filenames literally ending in `:raw`.
  - Recommendation: support the global flag (A) for hand use, `@!` for programmatic launch.
    - Or support `:raw` suffix with `@!` kept as the escape hatch for ambiguous names.
- Touch point 1 — `src/cli/args.ts`.
  - Replace the single `fileArgs: string[]` list with an ordered list:
    - `files: Array<{ path: string; wrap: boolean }>`.
  - Keep a compat shim (deprecated `fileArgs` getter mapping `files.map(f => f.path)`).
    - So old imports keep compiling.
  - Check `@!` before `@`:
    - `arg.startsWith("@!") → files.push({ path: arg.slice(2), wrap: false })`.
    - `arg.startsWith("@") → files.push({ path: arg.slice(1), wrap: true })`.
  - Snapshot-test edge inputs: `@a.md`, `@!a.md`, `@a.md:raw`, `@!`, `@:raw`.
- Touch point 2 — `src/cli/file-processor.ts`.
  - Change the loop from `for (const fileArg of fileArgs)` to `for (const { path: fileArg, wrap } of files)`.
  - Reuse the identical resolve/access/stat/image/text pipeline.
  - Branch only the emit (`wrap ? <file> template : raw content`, same raw shapes as Proposal A).
  - Zero duplication between wrapped and raw paths.
- Touch point 3 — `src/main.ts` + help + rpc guard.
  - Pass the ordered list through unchanged.
  - Keep join order (`stdin → fileText → messages[0]`), so blocks appear in typed CLI order.
  - Help gains one line:
    - `@!path  Include file content raw, without <file> wrapper (launch/automation use)`.
  - Rpc guard rejects both kinds together (`files.length > 0`) with the same message.
- Images in raw mode:
  - Same rule as Proposal A: attachments still flow, only the text reference goes raw.
  - This also restores images lost in nested spawns (parent `task` copies drop attachments).
- Trade-off:
  - More expressive than (A): mixed wrapped-plus-raw, per-file opt-out, provenance kept on wrapped siblings.
  - Slightly larger parser/type change (`string[]` → `{ path, wrap }[]`) needing the compat shim.

## What stays identical under both proposals

- Default invocation (no new flag, no new syntax) is byte-identical to 0.84.1.
  - Same wrapper, same `stdin → files → messages[0]` order.
  - Same `~`/screenshot-space handling.
  - Same missing-file error, same empty-file skip.
  - Same image attachments, same rpc rejection, same `--print/-p` rules.
- No changes to:
  - TUI, session `.jsonl` schema (`version: 3`), registry, sidecars (`.exit`/`.done`/`.ask`).
  - `kitty @` transport, `flattenSteerMessage`, `safe_bash`, Claude backend.
  - None of the rejected ideas from `file-wrapper-artifacts.md` (stdin hijack, live-tab `@` expansion, `.jsonl` seeding, fork-mode switch).

## Suggested rollout for the subagent use case

### Step 1 — land Proposal A (one boolean, default off)

- Land the core flag plus unit tests.
- Wire it in the extension as an opt-in plan flag (`rawArtifact?: boolean`).
  - Parse from agent frontmatter or `config.json` via `agents.ts` + `status.ts` + `config.json.example`.
  - Document in `docs/EXIT-KEEP-PRECEDENCE.md`, `README.md`, `docs/AGENT-OPTIONS.md`.
- Thread it through `SubagentLoadout` (`session/loadout.ts`) so resume replays it.
- Verify with `node --test` plus one launch snapshot (flag present only when opted in).
- Then `/reload` and retest per `AGENTS.md`.

### Step 2 — add Proposal B only if mixed wrapped-plus-raw is needed

- Example: raw `@artifact` plus one wrapped reference file kept for provenance.
- Reuse the same extension plan flag as the trigger (`rawFiles?: string[]` after `@artifact`).
- Apply the same guards from the no-core doc: `existsSync + size > 0`, dedupe, cap 10, parent-`cwd` resolution.
