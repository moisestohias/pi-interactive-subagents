# Pi core patch: `--disable-file-wrapper` (re-apply after every Pi update)

Read this file after updating Pi, before doing anything else.

## Why this file exists

- Pi core has no `--disable-file-wrapper` flag upstream.
- We patched it into the installed Pi so subagent task files arrive raw (no `<file>` XML wrapper).
- Any Pi reinstall, update, or `npm install -g` **wipes the patch**.
- After updating Pi, re-apply the 5 edits below (takes ~5 minutes), then run the verify steps.
- If upstream Pi ever ships this flag itself, delete this file — the extension already passes the same flag name.

## What was patched

- Package: `@earendil-works/pi-coding-agent`, version `0.84.1`.
- Location: `/home/moises/.local/lib/node_modules/@earendil-works/pi-coding-agent/dist/`.
- Binary: `~/.local/bin/pi` is a symlink to `../lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js` (same install).
- Total: 5 small edits in 4 files. Nothing else in Pi core was touched.

## Edit 1 — parse the flag (`dist/cli/args.js`)

- Find this block:
  ```js
  else if (arg === "--no-context-files" || arg === "-nc") {
      result.noContextFiles = true;
  }
  ```
- Add directly after it:
  ```js
  else if (arg === "--disable-file-wrapper") {
      result.disableFileWrapper = true;
  }
  ```
- Rule: this branch must sit **before** the generic `arg.startsWith("--") → unknownFlags` branch.
  - Any exact-match flag placed after that branch is silently swallowed into `unknownFlags` and never works.
  - Same pattern the existing `--no-skills` / `--no-context-files` flags use.

## Edit 2 — help text (`dist/cli/args.js`, same file)

- Find this line in `printHelp`:
  ```
  --no-context-files, -nc        Disable AGENTS.md and CLAUDE.md discovery and loading
  ```
- Add directly after it:
  ```
  --disable-file-wrapper         Do not wrap @file content in <file> tags (default: wrap)
  ```
- Cosmetic only. Skip it and the flag still works, but `pi --help` won't list it.

## Edit 3 — type field (`dist/cli/args.d.ts`)

- Find:
  ```ts
  noContextFiles?: boolean;
  ```
- Add after it:
  ```ts
  disableFileWrapper?: boolean;
  ```
- Types only. Skip it and runtime still works, but TypeScript callers can't see the field.

## Edit 4 — conditional emit (`dist/cli/file-processor.js`, the actual behavior)

- Step 1: find the top of `processFileArguments`:
  ```js
  const autoResizeImages = options?.autoResizeImages ?? true;
  ```
- Add after it:
  ```js
  const wrap = options?.wrap ?? true;
  ```
- Step 2: replace the 4 emission lines with wrapping ternaries (default `true` keeps every byte identical):
  - Image error path:
    ```js
    text += wrap ? `<file name="${absolutePath}">${processed.message}</file>\n` : `${processed.message}\n`;
    ```
  - Image with hints path:
    ```js
    text += wrap ? `<file name="${absolutePath}">${processed.hints.join("\n")}</file>\n` : `${processed.hints.join("\n")}\n`;
    ```
  - Image without hints path:
    ```js
    text += wrap ? `<file name="${absolutePath}"></file>\n` : "";
    ```
  - Text file path:
    ```js
    text += wrap ? `<file name="${absolutePath}">\n${content}\n</file>\n` : `${content}\n`;
    ```
- Do not touch anything else in this file.
  - Path resolution, missing-file `exit(1)`, empty-file skip, image attachments: all unchanged.
  - Images still arrive as binary attachments in raw mode; only the text reference goes raw.

## Edit 5 — forward the flag (`dist/main.js`)

- Find inside `prepareInitialMessage`:
  ```js
  const { text, images } = await processFileArguments(parsed.fileArgs, { autoResizeImages });
  ```
- Replace with:
  ```js
  const { text, images } = await processFileArguments(parsed.fileArgs, { autoResizeImages, wrap: !parsed.disableFileWrapper });
  ```
- Do not touch the `--mode rpc` guard below it (`@file not supported in RPC mode` still rejects, flag or not).

## Verify (run after re-applying)

```bash
echo "hello" > /tmp/rawtest.txt
node --input-type=module -e "
import { parseArgs } from '/home/moises/.local/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli/args.js';
import { processFileArguments } from '/home/moises/.local/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli/file-processor.js';
const a = parseArgs(['--disable-file-wrapper', '@/tmp/rawtest.txt']);
console.log('flag:', a.disableFileWrapper, '| in unknownFlags:', a.unknownFlags.has('disable-file-wrapper'));
console.log('wrapped:', JSON.stringify((await processFileArguments(['/tmp/rawtest.txt'], {})).text));
console.log('raw:', JSON.stringify((await processFileArguments(['/tmp/rawtest.txt'], { wrap: false })).text));
"
pi --help | grep disable-file-wrapper
```

- Expected: `flag: true | in unknownFlags: false`.
- Expected: wrapped output starts with `<file name="/tmp/rawtest.txt">`, raw output is `"hello\n\n"` with no `<file`.
- Expected: help prints the `--disable-file-wrapper` line.
- If the flag shows up in `unknownFlags`, Edit 1 is in the wrong position — move it above the generic `--` branch.

## Pitfalls

- Patch the **global** install above, not the repo's `node_modules` dev copy (`@mariozechner/pi-coding-agent`) — the `pi` binary runs from the global path.
- New Pi versions may rename or move these files. If an anchor block is gone, search for `<file name=` (only `file-processor.js` emits it) and `fileArgs.push(arg.slice(1))` (the `@` producer in `args.js`), then apply the same idea at the new location.
- `.js.map` sourcemaps were intentionally left stale — harmless, ignore them.
- Never "simplify" by removing the `wrap` default-`true`: the whole point is that default output stays byte-identical to unpatched Pi.
