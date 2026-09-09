#!/usr/bin/env bash
# Stop hook for pi-spawned Claude sessions.
# Writes a sentinel file when Claude completes autonomously (no user interjection).
#
# M10 hardening: no hard python3 requirement (node fallback, node ships with
# pi), safe defaults on every parse failure (never abort under `set -e`),
# and array-content human messages are counted, not just string content.

set -euo pipefail

# Read JSON input from stdin
input=$(cat)

# Portable JSON field extractor: python3 preferred, node fallback (pi runs on
# node, so it is always present where this hook matters), empty on failure.
json_field() {
  local query="$1" data="$2" result=""
  if command -v python3 >/dev/null 2>&1; then
    result=$(printf '%s' "$data" | python3 -c "import sys,json; print(json.load(sys.stdin).get('$query', ''))" 2>/dev/null || true)
  elif command -v node >/dev/null 2>&1; then
    result=$(printf '%s' "$data" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const o=JSON.parse(d);console.log(o['$query']??'')}catch{}})" 2>/dev/null || true)
  fi
  printf '%s' "$result"
}

# Guard: if stop_hook_active is true, we're in a loop — bail out
stop_hook_active=$(json_field "stop_hook_active" "$input")
if [ "$stop_hook_active" = "True" ] || [ "$stop_hook_active" = "true" ]; then
  exit 0
fi

# Guard: only act for pi-spawned sessions
if [ -z "${PI_CLAUDE_SENTINEL:-}" ]; then
  exit 0
fi

# Get transcript path
transcript_path=$(json_field "transcript_path" "$input")
if [ -z "$transcript_path" ] || [ ! -f "$transcript_path" ]; then
  exit 0
fi

# Count real human messages in transcript (not tool results).
# Claude's transcript format:
#   Human message: {"type": "user", "message": {"role": "user", "content": "..."}}
#   Human w/ attachments: content is an array of blocks — counts iff at least
#     one block is NOT a tool_result (pure tool_result arrays are tool output).
#   Tool result: content is an array with only tool_result blocks.
# Default 0 on any failure (safe: sentinel simply doesn't fire, watcher falls
# back to the terminal screen scrape).
user_msg_count=0
if command -v python3 >/dev/null 2>&1; then
  user_msg_count=$(python3 - "$transcript_path" <<'EOF' 2>/dev/null || echo 0
import sys, json

transcript_path = sys.argv[1]
count = 0
try:
    with open(transcript_path, 'r') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
                if entry.get('type') != 'user':
                    continue
                content = entry.get('message', {}).get('content', '')
                if isinstance(content, str):
                    if content.strip():
                        count += 1
                elif isinstance(content, list):
                    blocks = [b for b in content if isinstance(b, dict)]
                    if blocks and any(b.get('type') != 'tool_result' for b in blocks):
                        count += 1
            except (json.JSONDecodeError, AttributeError):
                pass
except OSError:
    pass
print(count)
EOF
)
elif command -v node >/dev/null 2>&1; then
  user_msg_count=$(node -e "
const fs=require('fs');let n=0;
try{for(const line of fs.readFileSync(process.argv[1],'utf8').split('\n')){
  const t=line.trim();if(!t)continue;
  try{const e=JSON.parse(t);if(e.type!=='user')continue;
    const c=e.message?.content??'';
    if(typeof c==='string'){if(c.trim())n++;}
    else if(Array.isArray(c)){const b=c.filter(x=>x&&typeof x==='object');if(b.length&&b.some(x=>x.type!=='tool_result'))n++;}
  }catch{}
}}catch{}
console.log(n);" "$transcript_path" 2>/dev/null || echo 0)
fi
# Sanitize to a non-negative integer no matter what the parsers printed.
case "$user_msg_count" in
  ''|*[!0-9]*) user_msg_count=0 ;;
esac

# Always write transcript path so the watcher can copy the session file
if [ -n "$transcript_path" ]; then
  echo "$transcript_path" > "${PI_CLAUDE_SENTINEL}.transcript" 2>/dev/null || true
fi

# If exactly 1 user message (the initial prompt), this was autonomous — signal completion
if [ "$user_msg_count" -eq 1 ]; then
  # Write last_assistant_message to sentinel so the watcher gets a clean result
  last_msg=$(json_field "last_assistant_message" "$input")
  if [ -n "$last_msg" ]; then
    printf '%s' "$last_msg" > "$PI_CLAUDE_SENTINEL" 2>/dev/null || touch "$PI_CLAUDE_SENTINEL" 2>/dev/null || true
  else
    touch "$PI_CLAUDE_SENTINEL" 2>/dev/null || true
  fi
fi

exit 0
