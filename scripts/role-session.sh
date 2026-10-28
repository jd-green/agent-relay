#!/usr/bin/env bash
# Starts a local Claude Code session as one relay role (Plan B in docs/SPIKE.md), with the
# relay-inbox Mod, the relay MCP server and the protocol for that role only.
#
#   scripts/role-session.sh <role> [--dir <role-dir>] [--model <model>] [options] [-- <claude args>]
#
#   role         orchestrator, creative-director or developer
#   --dir        the role's working directory (default: ~/relay-roles/<role>; created if missing).
#                Its CLAUDE.md holds the role Project's own instructions.
#   --model      passed on to claude
#   --no-prompt  start idle, without the first prompt (by default the session starts by checking
#                its relay inbox, which also loads a hooks module the engine deferred to a turn start)
#   --no-check   don't ask the relay (GET /api/me) whether the token belongs to <role>
#   --dry-run    write the files and print the claude command instead of running it (or --print-only)
#   -- ...       everything after -- goes to claude unchanged, e.g. -- --remote-control
#
# RELAY_URL is the relay's base URL (https://<worker>, without /mcp). The token comes from
# <ROLE>_TOKEN (e.g. DEVELOPER_TOKEN), else RELAY_TOKEN, else `op read` of OP_REF_<ROLE>
# (default "op://Agent Relay/<Role> token/password", as in scripts/put-secrets.sh).
# The token is never printed, passed as an argument or left in the session's environment; it goes
# only into these files in the role directory (mode 600, rewritten at every start; keep them out of git):
#   .relay-inbox.json        relay-inbox options                     (claude --settings)
#   .relay-mcp.json          the relay MCP server with a Bearer header (claude --mcp-config)
#   .relay-instructions.md   protocol/PROTOCOL.md + the role addendum (claude --append-system-prompt-file)
# Don't also install relay-inbox from the marketplace: two copies would load.
set -euo pipefail

MIN_LENGTH=32
FIRST_PROMPT="Session started by scripts/role-session.sh: check your relay inbox and act per the relay protocol."

usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; }
die() { printf 'role-session: %s\n' "$1" >&2; exit 1; }
warn() { printf 'role-session: warning: %s\n' "$1" >&2; }

upper() { printf '%s' "$1" | tr 'a-z-' 'A-Z_'; }

item_title() {
  case "$1" in
    orchestrator) echo "Orchestrator token" ;;
    creative-director) echo "Creative Director token" ;;
    developer) echo "Developer token" ;;
  esac
}

# Writes stdin to $1 with mode 600: a private temp file in the same directory, then renamed over it.
write_private() {
  local file="$1" tmp
  tmp="$(mktemp "$file.XXXXXX")"
  cat >"$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" "$file"
}

# Asks the relay which role the token belongs to. The header goes to curl on stdin, never as an argument.
check_role() {
  local out code got
  if ! command -v curl >/dev/null; then
    warn "curl not found, so the token was not checked"
    return 0
  fi
  if ! out="$(printf 'Authorization: Bearer %s\n' "$token" |
    curl -sS --max-time 10 -H @- -w '\n%{http_code}' "$relay_url/api/me" 2>/dev/null)"; then
    warn "$relay_url did not answer, so the token was not checked; starting anyway (the Mod's status line will show it)"
    return 0
  fi
  code="$(printf '%s\n' "$out" | tail -n 1)"
  case "$code" in
    200) ;;
    401) die "the relay rejected the $role token from $token_source (401): it is wrong or was rotated" ;;
    *)
      warn "$relay_url/api/me answered HTTP $code, so the token was not checked; starting anyway"
      return 0
      ;;
  esac
  got="$(printf '%s\n' "$out" | grep -o '"role":"[a-z-]*"' | head -n 1 | sed 's/^"role":"//; s/"$//')"
  [[ "$got" == "$role" ]] || die "the token from $token_source belongs to ${got:-an unknown role}, not $role"
}

role=""
dir=""
model=""
prompt=true
check=true
dry_run=false
extra=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir | --model)
      [[ $# -ge 2 && -n "${2:-}" ]] || die "$1 needs a value"
      if [[ "$1" == "--dir" ]]; then dir="$2"; else model="$2"; fi
      shift 2
      ;;
    --no-prompt) prompt=false; shift ;;
    --no-check) check=false; shift ;;
    --dry-run | --print-only) dry_run=true; shift ;;
    -h | --help) usage; exit 0 ;;
    --) shift; extra=("$@"); break ;;
    orchestrator | creative-director | developer)
      [[ -z "$role" ]] || die "give one role, not $role and $1"
      role="$1"
      shift
      ;;
    human) die "human is James's own token: it is not run as a role session, and it stays out of Mods" ;;
    *) printf 'Unknown argument: %s\n\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done
[[ -n "$role" ]] || { usage >&2; exit 2; }

# The checkout this script belongs to, also when it is run through a symlink.
script="$0"
while [[ -L "$script" ]]; do
  link="$(readlink "$script")"
  case "$link" in /*) script="$link" ;; *) script="$(dirname "$script")/$link" ;; esac
done
repo="$(cd -P "$(dirname "$script")/.." && pwd -P)"
for file in protocol/PROTOCOL.md "protocol/roles/$role.md" mods/relay-inbox/.claude-plugin/plugin.json; do
  [[ -f "$repo/$file" ]] || die "$repo/$file is missing; run this script from an agent-relay checkout"
done

# The relay URL: https, or http only to this machine (the Mods refuse anything else).
relay_url="${RELAY_URL:-}"
[[ -n "$relay_url" ]] || die "set RELAY_URL to the relay's base URL, e.g. export RELAY_URL=https://agent-relay.<subdomain>.workers.dev"
while [[ "$relay_url" == */ ]]; do relay_url="${relay_url%/}"; done
url_re='^(https://[A-Za-z0-9.-]+|http://(localhost|127\.0\.0\.1))(:[0-9]+)?(/[A-Za-z0-9._~/-]*)?$'
[[ "$relay_url" =~ $url_re ]] || die "RELAY_URL must be https://<host> (plain http only for localhost or 127.0.0.1)"
[[ "$relay_url" != */mcp && "$relay_url" != */mcp/* ]] || die "RELAY_URL is the relay's base URL, without /mcp"

# The token: <ROLE>_TOKEN, then RELAY_TOKEN, then 1Password.
token_var="$(upper "$role")_TOKEN"
if [[ -n "${!token_var:-}" ]]; then
  token="${!token_var}"
  token_source="$token_var"
elif [[ -n "${RELAY_TOKEN:-}" ]]; then
  token="$RELAY_TOKEN"
  token_source="RELAY_TOKEN"
else
  ref_var="OP_REF_$(upper "$role")"
  ref="${!ref_var:-op://Agent Relay/$(item_title "$role")/password}"
  command -v op >/dev/null || die "no $token_var or RELAY_TOKEN set, and the 1Password CLI (op) is not installed"
  token="$(op read --no-newline "$ref")" || die "op read \"$ref\" failed: sign in with  eval \"\$(op signin)\"  (or unlock the 1Password app), or set $ref_var"
  token_source="$ref"
fi
# The same rule as scripts/put-secrets.sh: shorter tokens disable the role, and the token goes into JSON as is.
token_re='^[A-Za-z0-9._~-]+$'
if [[ ${#token} -lt $MIN_LENGTH || ! "$token" =~ $token_re ]]; then
  die "the token from $token_source must be at least $MIN_LENGTH URL-safe characters (letters, digits, - _ . ~); not shown"
fi

if $check; then check_role; fi

dir="${dir:-$HOME/relay-roles/$role}"
mkdir -p "$dir"
dir="$(cd "$dir" && pwd -P)"
umask 077
printf '{"pluginConfigs":{"relay-inbox":{"options":{"relay_url":"%s","role_token":"%s","auto_wake":true}}}}\n' \
  "$relay_url" "$token" | write_private "$dir/.relay-inbox.json"
printf '{"mcpServers":{"relay":{"type":"http","url":"%s/mcp","headers":{"Authorization":"Bearer %s"}}}}\n' \
  "$relay_url" "$token" | write_private "$dir/.relay-mcp.json"
{
  cat "$repo/protocol/PROTOCOL.md"
  printf '\n'
  cat "$repo/protocol/roles/$role.md"
} | write_private "$dir/.relay-instructions.md"

if command -v git >/dev/null && git -C "$dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  for file in .relay-inbox.json .relay-mcp.json .relay-instructions.md; do
    git -C "$dir" check-ignore -q "$file" || warn "$dir/$file is not gitignored: add .relay-* to that repository's .gitignore"
  done
fi
[[ -f "$dir/CLAUDE.md" ]] || warn "$dir/CLAUDE.md is missing: put the role Project's own instructions there"

cmd=(claude
  --plugin-dir "$repo/mods/relay-inbox"
  --settings "$dir/.relay-inbox.json"
  --mcp-config "$dir/.relay-mcp.json"
  --append-system-prompt-file "$dir/.relay-instructions.md"
  --name "relay $role")
if [[ -n "$model" ]]; then cmd+=(--model "$model"); fi
if $prompt; then cmd+=("$FIRST_PROMPT"); fi
cmd+=(${extra[@]+"${extra[@]}"})

if $dry_run; then
  printf 'role: %s\nrelay: %s\ntoken: from %s (not shown)\nwrote (mode 600): %s/.relay-inbox.json %s/.relay-mcp.json %s/.relay-instructions.md\n' \
    "$role" "$relay_url" "$token_source" "$dir" "$dir" "$dir"
  printf 'cd %q &&' "$dir"
  printf ' %q' "${cmd[@]}"
  printf '\n'
  exit 0
fi

cd "$dir"
# The session's tools inherit this environment: leave no relay token in it (its own is in the files above).
unset RELAY_TOKEN ORCHESTRATOR_TOKEN CREATIVE_DIRECTOR_TOKEN DEVELOPER_TOKEN HUMAN_TOKEN
exec "${cmd[@]}"
