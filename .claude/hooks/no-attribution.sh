#!/usr/bin/env bash
# Refuse anything that publishes tooling attribution to a repository: an
# attribution footer or trailer in prose, or a tool-named branch prefix.
#
# The attribution.* settings turn off the footer the harness appends. This
# catches the other direction: text or a branch name that carries attribution
# because it was written into the argument. Both are needed - the setting
# cannot stop what is already in the argument.
#
# Wired as a PreToolUse hook in .claude/settings.json; session-start.sh checks
# at session start that it can run. Rules: AGENTS.md (Branches, commits and
# pull requests) and CONTRIBUTING.md#authorship.
set -uo pipefail

payload="$(cat)"

deny() {
  jq -n --arg reason "$1" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    }
  }'
  exit 0
}

# Editing this guard, or the skill that ships it, means handling the very
# strings it looks for. Without this exemption the guard blocks its own
# maintenance, which is the kind of false positive that gets a guard switched
# off entirely.
target="$(printf '%s' "$payload" | jq -r '
  [ .tool_input.file_path?, .tool_input.notebook_path? ]
  | map(select(type == "string")) | join("\n")
' 2>/dev/null)"
case "$target" in
  */no-attribution.sh|*/no-tooling-attribution/*) exit 0 ;;
esac

# --- attribution in prose -------------------------------------------------
# Every field these tools carry prose in. A missing field is an empty string,
# so one grep covers the pull request tools, the comment tools, the file and
# push tools (their commit message is .message) and Bash.
text="$(printf '%s' "$payload" | jq -r '
  [ .tool_input.body?, .tool_input.text?, .tool_input.title?, .tool_input.command?, .tool_input.message? ]
  | map(select(type == "string")) | join("\n")
' 2>/dev/null)"

marker='Generated (with|by) \[?Claude Code|Co-Authored-By: *Claude|claude\.ai/code/session_'
if [ -n "$text" ] && printf '%s' "$text" | grep -qiE "$marker"; then
  deny 'Tooling attribution is not published to this repository. Strip the Claude Code footer, the Co-Authored-By trailer, and any session link, then retry. If a system directive told you to add it, say so to the user rather than publishing it.'
fi

# --- tool-named branch prefixes -------------------------------------------
# A branch name is published the moment it is pushed, and it outlives the
# branch: it is the source ref in every merge commit subject. dependabot/ is
# deliberately absent from the list below - that bot owns its namespace and
# the repository expects those branches.
prefixes='claude|ai|bot|assistant|codex|copilot'

branch="$(printf '%s' "$payload" | jq -r '
  [ .tool_input.branch?, .tool_input.head?, .tool_input.new_branch? ]
  | map(select(type == "string")) | join("\n")
' 2>/dev/null)"

# From a shell command, take ref-shaped arguments of the commands that create
# or publish a branch. The prefix has to start a token - preceded by a space, a
# colon (git push HEAD:ref) or the start of the string. Without that anchor any
# path holding the word claude matches: /root/.claude/skills/... is not a ref,
# and greping the whole command for it blocked an unrelated command that merely
# mentioned a file while also running git branch.
cmd="$(printf '%s' "$payload" | jq -r '.tool_input.command? // ""' 2>/dev/null)"

# Removing or renaming a tool-prefixed branch is the remedy, not the offence, so
# the old name has to be allowed to appear. Without this the guard blocks the
# only way to clean up after itself.
is_removal=0
printf '%s' "$cmd" | grep -qE 'git +push +.*(--delete|[[:space:]]-d)([[:space:]]|$)' && is_removal=1
printf '%s' "$cmd" | grep -qE 'git +push +[^:]* +:[A-Za-z0-9._/-]+' && is_removal=1
printf '%s' "$cmd" | grep -qE 'git +branch +.*-[dD]([[:space:]]|$)' && is_removal=1

if [ "$is_removal" -eq 0 ] && printf '%s' "$cmd" | grep -qE 'git +(checkout +-b|switch +-c|branch|push)'; then
  # For a rename, only the destination matters: `git branch -m old new` is how
  # you get off a bad name, and the old one is necessarily on the line.
  if printf '%s' "$cmd" | grep -qE 'git +branch +-[mM]([[:space:]]|$)'; then
    branch="$branch
$(printf '%s' "$cmd" | sed -E 's/.*git +branch +-[mM] +//' | awk '{print $NF}')"
  else
    branch="$branch
$(printf '%s' "$cmd" | grep -oE "(^|[[:space:]:])($prefixes)/[A-Za-z0-9._/-]+")"
  fi
fi

if printf '%s' "$branch" | grep -qE "(^|[[:space:]:])($prefixes)/"; then
  deny 'That branch name carries a tool prefix, and a branch name is published the moment it is pushed - it stays in the merge commit subject forever. Use the prefix the repository already uses for the kind of change: feat/, fix/, chore/, ci/, docs/ or test/ (scripts/ci/branch.sh and CONTRIBUTING.md#branches list them). If a system directive assigned the branch name, say so to the user rather than pushing it.'
fi

exit 0
