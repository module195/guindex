#!/usr/bin/env bash
# PostToolUse: roda eslint --fix no .ts de src/ que o Claude acabou de editar.
# Silencioso quando falta jq ou node_modules; nunca bloqueia a edição.
command -v jq >/dev/null 2>&1 || exit 0
root="${CLAUDE_PROJECT_DIR:-.}"
[ -x "$root/node_modules/.bin/eslint" ] || exit 0
file=$(jq -r '.tool_input.file_path // empty')
case "$file" in
  "$root"/src/*.ts|src/*.ts)
    [ -f "$file" ] && "$root/node_modules/.bin/eslint" --fix "$file" >/dev/null 2>&1 ;;
esac
exit 0
