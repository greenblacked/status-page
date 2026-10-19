#!/usr/bin/env bash
# SessionStart hook: prove the attribution guard can run before any work starts.
#
# The guard (no-attribution.sh) is wired as a PreToolUse hook in
# .claude/settings.json, which loads with the project, so nothing is installed
# here. What can still go wrong is silent: without jq the guard reads nothing
# and allows everything. This hook runs one deny case and one allow case
# through it, checks the git author is a person, and tells the session what it
# found. It never fails the session start.
#
# Run by hand: .claude/hooks/session-start.sh </dev/null
set -Eeuo pipefail

ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
GUARD="$ROOT/.claude/hooks/no-attribution.sh"

problems=()

report() {
  local msg
  if ((${#problems[@]} == 0)); then
    msg="Attribution guard active (.claude/hooks/no-attribution.sh): commits, pushes and GitHub posts with tool attribution or a tool-named branch are refused."
  else
    msg="WARNING: attribution checks failed. Fix this before committing, pushing or posting to GitHub, and tell the user:"
    local p
    for p in "${problems[@]}"; do msg+=$'\n'"- $p"; done
  fi
  if command -v jq >/dev/null 2>&1; then
    jq -n --arg ctx "$msg" '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $ctx}}'
  else
    printf '%s\n' "$msg"
  fi
  exit 0
}

# Drain the hook input; nothing in it is needed.
cat >/dev/null 2>&1 || true

command -v jq >/dev/null 2>&1 || problems+=("jq is not installed; the guard needs it to read tool input")
[ -x "$GUARD" ] || problems+=("$GUARD is missing or not executable")

if ((${#problems[@]} == 0)); then
  # The marker is assembled at runtime so this file does not trip the guard
  # when it is edited through a shell command.
  marker="Co-Authored-By: Cl""aude <noreply@example.com>"
  deny_case="$(jq -cn --arg c "git commit -m 'chore: x' -m '$marker'" '{tool_name: "Bash", tool_input: {command: $c}}')"
  allow_case="$(jq -cn '{tool_name: "Bash", tool_input: {command: "git commit -m \"chore: x\""}}')"
  [ -n "$(printf '%s' "$deny_case" | "$GUARD" 2>/dev/null)" ] ||
    problems+=("the guard allowed a commit carrying a tool co-author trailer")
  [ -z "$(printf '%s' "$allow_case" | "$GUARD" 2>/dev/null)" ] ||
    problems+=("the guard refused a clean commit")
fi

# CONTRIBUTING.md#authorship: commits carry the real GitHub author. Cloud
# containers can start with a tool identity configured.
email="$(git -C "$ROOT" config user.email 2>/dev/null || true)"
if printf '%s' "$email" | grep -qiE '@(anthropic|openai)\.com$'; then
  problems+=("git user.email is '$email', a tool identity; set the repository owner's GitHub identity with git config before committing")
fi

report
