---
name: contrato-aiostreams
description: O que o AIOStreams lê de um stream do guindex (behaviorHints, infoHash, fileIdx, filename, idiomas) e como não quebrar dedup, filtros e ordenação. Use ao mexer em stream-service.ts, no filename/título do stream, na detecção de idioma ou ao depurar stream sumindo/duplicado no AIOStreams.
---

# Contrato guindex → AIOStreams

O AIOStreams (github.com/Viren070/AIOStreams) agrega addons e reaplica parse, filtro, dedup e ordenação. Para tirar dúvida sobre o código dele, use o MCP DeepWiki (`ask_wiki_question` em `Viren070/AIOStreams`) em vez de supor.

## Regras

1. **Metadados extras só contam dentro de `behaviorHints`**: `seeders`, `indexer`, `publishDate`, `folderName`, `folderSize`, `service`, `cached`, `duration`. Campo no nível de cima do stream é ignorado.
2. **Dedup é por `infoHash:fileIdx`**. Mande `infoHash` (também no link de resolve do debrid) e `fileIdx` quando souber o arquivo; sem isso o mesmo release aparece várias vezes ou some na dedup.
3. **`behaviorHints.filename` é parseado pelo PTT** (`@viren070/parse-torrent-title`). Mande o nome real do release/arquivo, sem carimbo de site e sem decorações (idiomas, tamanho, nome do indexer), senão o release group e o idioma saem errados.
4. **Idioma pt-BR**: o parser só reconhece `🇧🇷`, `PT-BR`/`PTBR` ou `Portuguese Brazil`. "Nacional" e o sufixo `(brazilian)` do torrent-indexer não geram idioma.
5. **Detecção de idioma do guindex não pode usar códigos de 2 letras soltos** sobre título/sinopse: "Tropa **de** Elite" virava alemão. Confira só no nome do release.
6. **`bingeGroup` sempre presente** (todos os providers) para o "próximo episódio" funcionar.
7. **Selo de cache**: `cached: true` só quando o debrid confirmou. Real-Debrid quase nunca confirma (ver skill `debrid-apis`), então o filtro "só cacheados" do AIOStreams corta streams RD.
8. Quem usa o guindex com debrid próprio deve deixá-lo **fora** do Service Wrap / Reconfigure Service do AIOStreams.

## Verificar uma mudança

- `npm run test:aiostreams` (`tests/aiostreams-metadata.test.mjs`).
- Pegue um `/stream/movie/tt15398776.json` local e confira `behaviorHints`, `infoHash`, `fileIdx`, `filename`.
- Se mudou o formato do título/filename, atualize os testes e descreva no PR o efeito esperado no AIOStreams.
