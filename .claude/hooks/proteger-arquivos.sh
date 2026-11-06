#!/usr/bin/env bash
# PreToolUse (Edit|MultiEdit|Write): impede o Claude de editar à mão arquivos
# que só devem mudar por ferramenta ou que servem de referência para os testes.
# Sai com 2 (bloqueia e devolve a mensagem ao Claude). Sem jq, não bloqueia nada.
command -v jq >/dev/null 2>&1 || exit 0
file=$(jq -r '.tool_input.file_path // empty')
[ -n "$file" ] || exit 0
root="${CLAUDE_PROJECT_DIR:-$PWD}"
rel="${file#"$root"/}"

block() { echo "Bloqueado pelo hook proteger-arquivos: $1" >&2; exit 2; }

case "$(basename "$rel")" in
  go.sum) block "go.sum só muda por 'go mod tidy' (o CI falha se o tidy mudar algo). Rode o comando em vez de editar." ;;
  package-lock.json) block "package-lock.json só muda por 'npm install'." ;;
  .env.example) ;;
  .env|.env.*) block "$rel guarda segredos. Peça ao usuário para editar, ou mude .env.example." ;;
esac

exit 0
