---
name: debrid-apis
description: Referência de como o guindex usa as APIs do TorBox e do Real-Debrid (endpoints, checagem de cache, play, erros conhecidos). Use ao mexer em torbox-client.ts, torbox-service.ts, realdebrid-service.ts, debrid-prefetch.ts ou ao depurar stream que não toca.
---

# APIs de debrid no guindex

Confira sempre o código atual: os trechos abaixo apontam onde olhar, não substituem a leitura.

## TorBox (`src/services/torbox-client.ts`, base `https://api.torbox.app`)

| Uso | Endpoint |
|---|---|
| Cache de vários hashes | `GET /v1/api/torrents/checkcached` |
| Adicionar magnet | `POST /v1/api/torrents/createtorrent` |
| Lista da conta (reaproveitar torrent) | `GET /v1/api/torrents/mylist` |
| Link de download/stream | `GET /v1/api/torrents/requestdl` |
| Equivalentes para web download | `/v1/api/webdl/checkcached`, `createwebdownload`, `mylist`, `requestdl` |

- Token vem na URL do addon (`/torbox/<token>/...`). **Não** defina `TORBOX_TOKEN` no ambiente de uma instância pública: todo pedido sem token passaria a usar essa conta.
- TorBox permite compartilhar conta entre IPs; o `checkcached` é confiável para o selo de cache.
- Reaproveitamento de torrent já na conta: `tests/torbox-reuse.test.mjs`.

## Real-Debrid (`src/services/realdebrid-service.ts`, base `https://api.real-debrid.com/rest/1.0`)

- **Não existe mais `instantAvailability`** (desligado em nov/2024). O selo `[RD+]` só aparece para o que já está na conta do usuário (lista de torrents); o resto sai `[RD]` (desconhecido, não "não cacheado").
- Play: reaproveita torrent da conta → senão `addMagnet` → espera arquivos → escolhe o arquivo do episódio (regras BR do `torrent-parser.ts`) → `selectFiles` → `unrestrict/link`.
- `magnet_conversion` com lista de arquivos vazia logo após o `addMagnet` é normal para conteúdo novo: espere/repita o `info` e devolva o vídeo de espera (`/placeholder/downloading.mp4`) em vez de erro.
- `infringing_file`: responde 451 e esconde o stream por 24 h.
- RD bloqueia uso de uma conta em IPs diferentes ao mesmo tempo: cuidado com proxy de stream.
- Não defina `REALDEBRID_TOKEN` no ambiente de instância pública (mesmo motivo do TorBox).

## Erros e testes

- Testes relacionados: `tests/realdebrid-*.test.mjs`, `tests/sources-debrid.test.mjs`, `tests/provider-debrid-deadline.test.mjs`, `tests/stream-debrid-*.test.mjs`.
- Simule a API nos testes; nunca rode testes contra uma conta real nem cole tokens em logs, commits ou conversa.
- O vídeo de espera usa `BASE_URL`; sem ele aponta para `localhost`.
- Consulta de cache do debrid entra no orçamento de tempo do pedido (`TORRENT_INDEXER_REQUEST_BUDGET_MS`).
