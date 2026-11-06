# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# guindex (fork module195)

Addon Stremio em TypeScript (ESM, Fastify 5, Node ≥ 20.18) para conteúdo brasileiro. Busca torrents no **torrent-indexer** (repo `module195/torrent-indexer`, Go) e entrega streams diretos via **TorBox** ou **Real-Debrid**. Costuma ser usado dentro do **AIOStreams**.

## Comandos

- Instalar: `npm ci` (o `package-lock.json` está no repo; use `npm install` só para mudar dependências)
- Dev: `npm run dev` · Build: `npm run build` · Start: `npm start` (porta 7000)
- Checagens do CI: `npm run typecheck && npm run lint && npm test`
- Testes focados: `npm run test:aiostreams`, `npm run test:indexer`. Um arquivo só: `npm run build && node --test tests/search-phases.test.mjs` (filtre com `--test-name-pattern`)
- Os testes são `tests/*.test.mjs` e importam de `dist/`: sem `npm run build` antes, testam código velho. As constantes de `torrent-indexer-shared.ts` são lidas do env no import, então o teste define `process.env.*` antes do `await import(...)` e sobe um torrent-indexer falso com `node:http`. Os `tests/*.ts` e `midpatch-timings.mjs` são scripts manuais, fora do `npm test`

## Mapa do código

- `src/server.ts`, `src/routes/routes.ts`: Fastify (rotas do protocolo Stremio feitas à mão); rotas `/manifest.json`, `/stream/:type/:id.json`, `/configure`, `/health`, rotas com token `/<debrid>/<token>/...` e `/resolve`.
- `src/config/sources.ts`: fontes; `TORRENT_INDEXER_URL` (padrão `http://127.0.0.1:8090`).
- `src/services/torrent-indexer-provider.ts` (~1.900 linhas): busca em 3 fases (Meilisearch `/search` + `/indexers/multi` em paralelo, indexers rápidos no fim), dentro de `TORRENT_INDEXER_REQUEST_BUDGET_MS` (padrão 8000). `torrent-indexer-shared.ts`: constantes e env.
- Fluxo de um `/stream`: `routes.ts` → `stream-controller.ts` → `SourceService.fetchStreamsFromAllSources` (roda todos os `SOURCES` em paralelo: torrent-indexer e addons Stremio de `stremio-addon-provider.ts`) → checagem de cache no debrid → `stream-service.ts` monta a resposta.
- `src/services/torrent-parser.ts`: regex de releases BR (temporada, episódio, áudio, qualidade).
- `src/services/stream-service.ts`: monta o stream do Stremio (`behaviorHints`, `infoHash`, `fileIdx`, `bingeGroup`, `filename`).
- Debrid: `torbox-client.ts`/`torbox-service.ts`, `realdebrid-service.ts`, `debrid-prefetch.ts`.

## Contrato com o torrent-indexer

Usa `GET /sources?v=2` (capacidades, tiers, saúde), `GET /indexers/multi`, `GET /indexers/<nome>` e `GET /search`. O lado Go é a fonte da verdade: leia o README dele ("API for aggregating clients") antes de mudar a integração. Mudança que atravessa os dois repos segue a skill `mudar-contrato` do torrent-indexer.

## Regras

- Todo pedido de stream respeita o orçamento de tempo; não adicione chamada externa fora dele.
- Não engula erro silenciosamente: logue com contexto e devolva lista vazia/placeholder conforme o padrão existente.
- Página `/configure`: escape toda entrada do usuário (houve XSS, auditoria de 28/10). Regex sobre entrada externa não pode ser montada a partir do `ctx` sem escape (ReDoS).
- Mudanças em `stream-service.ts` afetam o AIOStreams: veja a skill `contrato-aiostreams`.
- Mudanças em debrid: veja a skill `debrid-apis`.

## Ferramentas do projeto (Claude Code)

- Plugins (`.claude/settings.json`): typescript-lsp, security-guidance, pr-review-toolkit, commit-commands, claude-md-management, playwright, context7. O LSP precisa de `npm i -g typescript-language-server typescript`.
- Hooks: `eslint --fix` em cada `.ts` editado dentro de `src/` (só roda se `node_modules` existir); `proteger-arquivos.sh` bloqueia edição manual de `package-lock.json` (use `npm install`) e de `.env*` (menos `.env.example`).
- Skills: `debrid-apis`, `contrato-aiostreams`. O MCP do Meilisearch/Redis fica no repo do torrent-indexer.

## Contexto extra

Relatórios de investigação (fases de busca, Real-Debrid, metadados para o AIOStreams, auditoria de segurança) ficam na pasta compartilhada do projeto Claude, não neste repo.
