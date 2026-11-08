
/**
 * Routes
 */

import Fastify from 'fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import path from 'path';
import { ConfigController } from '../controllers/config-controller.js';
import { StreamController } from '../controllers/stream-controller.js';
import { ConfigService } from '../services/config-service.js';
import { RealDebridBlockedError } from '../services/realdebrid-service.js';
import { StreamService } from '../services/stream-service.js';
import { publicClientIp } from '../services/client-ip.js';
import { addonAccessKey, isPrivateMode, requestCarriesAccessKey } from '../services/access-key.js';
import { TorboxService } from '../services/torbox-service.js';
import {
  LIBRARY_CATALOG_ENABLED,
  LIBRARY_CATALOG_ID,
  LIBRARY_ID_PREFIX,
  LIBRARY_TYPE,
  fetchLibraryCatalog,
  fetchLibraryMeta,
  fetchLibraryStreams,
  parseLibraryExtras
} from '../services/torbox-library.js';

/** Teto do token debrid aceito no /resolve (os reais têm dezenas de caracteres). */
const MAX_DEBRID_TOKEN_LENGTH = 512;

/** Cache HTTP dos arquivos de public/ (1 dia). */
const STATIC_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function setupRoutes() {
  const config = ConfigService.loadConfig();
  // Atrás do proxy do Easypanel: req.ip vem do X-Forwarded-For, o IP do usuário
  // que o TorBox usa para escolher o CDN
  const fastify = Fastify({ logger: false, trustProxy: true });

  // Register CORS plugin

// Register CORS plugin
  fastify.register(import('@fastify/cors'), {
    origin: true,
    credentials: true
  });

  // Register static file plugin
  // Estáticos com cache de 1 dia: imagens mudam raramente e o config-page.js vai
  // com ?v=<hash do conteúdo> (config-controller), então deploy novo troca a URL.
  // O /configure segue no-store e sempre aponta para a versão atual.
  fastify.register(import('@fastify/static'), {
    root: path.resolve('public'),
    maxAge: STATIC_MAX_AGE_MS
  });

  // Modo privado (ADDON_ACCESS_KEY): sem a chave no caminho ou em ?key=, a
  // instância responde 404 a tudo, inclusive /configure e /manifest.json.
  // 404 em vez de 401 para não confirmar que existe um addon aqui.
  if (isPrivateMode()) {
    console.info('[GuIndex] 🔒 Modo privado ativo: pedidos sem ADDON_ACCESS_KEY recebem 404');
    fastify.addHook('onRequest', async (req, reply) => {
      if (req.method === 'OPTIONS' || requestCarriesAccessKey(req.url)) return;
      reply.status(404).header('cache-control', 'no-store').send({ error: 'Not Found' });
      return reply;
    });
  }

  // Initialize controllers
  const configController = new ConfigController();
  const streamController = new StreamController();

  // O manifest não leva token e só muda com um deploy. Cache longo e stale-if-error
  // evitam que uma falha momentânea tire o addon do agregador (o AIOStreams guarda
  // falha de manifest por 60 s).
  const MANIFEST_CACHE_CONTROL = 'public, max-age=3600, stale-while-revalidate=86400, stale-if-error=604800';
  const sendManifest = (reply: FastifyReply, isConfigured: boolean, withLibrary = false) => {
    reply
      .header('cache-control', MANIFEST_CACHE_CONTROL)
      .send(configController.createAddonManifest(isConfigured, withLibrary));
  };

  /**
   * ✅ Suporte a tokens do Real-Debrid no caminho
   * Exemplo: /TOKEN/manifest.json
   */
  fastify.all('/manifest.json', async (req, reply) => {
    const query = req.query as any;
    const debridSelection = StreamService.resolveDebridSelection({
      query,
      headers: req.headers
    });

    sendManifest(reply, !!debridSelection.token);
  });

  // Caso com token simples no caminho (compatibilidade legada)
  fastify.all('/:token/manifest.json', async (req, reply) => {
    const { token } = req.params as { token: string };
    const query = req.query as any;

    const debridSelection = StreamService.resolveDebridSelection({
      query,
      headers: req.headers,
      routeParams: { token }
    });
    sendManifest(reply, !!debridSelection.token);
  });

  // Novo formato: /provider/token/manifest.json
  fastify.all('/:provider/:token/manifest.json', async (req, reply) => {
    const { provider, token } = req.params as { provider: string; token: string };
    const query = req.query as any;

    const debridSelection = StreamService.resolveDebridSelection({
      query: { ...query, debridProvider: provider, token: token },
      headers: req.headers,
      routeParams: { token: token }
    });

    // Só no formato /torbox/TOKEN/: o Stremio pede catalog/meta relativos a esse caminho
    sendManifest(reply, !!debridSelection.token, debridSelection.provider === 'torbox' && !!debridSelection.torboxToken);
  });

  // ---------- Catálogo "Minha TorBox" (biblioteca da conta) ----------
  const libraryToken = (provider: string, token: string): string | undefined => {
    const selection = StreamService.resolveDebridSelection({
      query: { debridProvider: provider, token },
      headers: {},
      routeParams: { token }
    });
    return selection.provider === 'torbox' && LIBRARY_CATALOG_ENABLED ? selection.torboxToken : undefined;
  };
  const LIBRARY_CACHE_CONTROL = 'private, max-age=60';

  const handleLibraryCatalog = async (req: FastifyRequest, reply: FastifyReply) => {
    const { provider = '', token = '', type, id, extra } = req.params as Record<string, string | undefined>;
    const tbToken = libraryToken(provider, token);
    if (!tbToken || type !== LIBRARY_TYPE || id !== LIBRARY_CATALOG_ID) {
      reply.send({ metas: [] });
      return;
    }
    try {
      const metas = await fetchLibraryCatalog(tbToken, parseLibraryExtras(extra));
      reply.header('cache-control', LIBRARY_CACHE_CONTROL).send({ metas });
    } catch (error) {
      console.error(`[GuIndex] ❌ Catálogo Minha TorBox: ${error instanceof Error ? error.message : 'Unknown error'}`);
      reply.send({ metas: [] });
    }
  };
  fastify.get('/:provider/:token/catalog/:type/:id.json', handleLibraryCatalog);
  fastify.get('/:provider/:token/catalog/:type/:id/:extra.json', handleLibraryCatalog);

  fastify.get('/:provider/:token/meta/:type/:id.json', async (req, reply) => {
    const { provider = '', token = '', id = '' } = req.params as Record<string, string | undefined>;
    const tbToken = libraryToken(provider, token);
    if (!tbToken || !id.startsWith(LIBRARY_ID_PREFIX)) {
      reply.status(404).send({ meta: null });
      return;
    }
    try {
      const meta = await fetchLibraryMeta(tbToken, id);
      if (!meta) {
        reply.status(404).send({ meta: null });
        return;
      }
      reply.header('cache-control', 'private, no-store').send({ meta });
    } catch (error) {
      console.error(`[GuIndex] ❌ Meta Minha TorBox (${id}): ${error instanceof Error ? error.message : 'Unknown error'}`);
      reply.status(404).send({ meta: null });
    }
  });

  // No modo privado a página entra com ?key=<CHAVE> e já preenche a chave no
  // campo do token: a URL de instalação sai com a chave, não com o token debrid.
  const privateConfigPrefill = () => {
    const key = addonAccessKey();
    if (!key) return undefined;
    const provider = process.env.TORBOX_TOKEN?.trim() || !process.env.REALDEBRID_TOKEN?.trim() ? 'torbox' : 'realdebrid';
    return provider === 'torbox'
      ? { debridProvider: provider, torboxToken: key }
      : { debridProvider: provider, realdebridToken: key };
  };

  fastify.get('/configure', async (req, reply) => {
    const query = req.query as any;
    const prefill = privateConfigPrefill();
    const selection = StreamService.resolveDebridSelection({
      query: prefill ?? query,
      headers: prefill ? {} : req.headers
    });
    reply.header('cache-control', 'no-store');
    
    reply
      .type('text/html')
      .send(
        configController.generateConfigHTML(
          {
            debridProvider: selection.provider,
            realdebridToken: selection.realdebridToken,
            torboxToken: selection.torboxToken
          },
          true,
          ConfigService.requestOrigin(req.headers, req.protocol)
        )
      );
  });

  fastify.get('/', async (req, reply) => {
    const prefill = privateConfigPrefill();
    reply
      .header('cache-control', 'no-store')
      .type('text/html')
      .send(configController.generateConfigHTML(prefill, !!prefill, ConfigService.requestOrigin(req.headers, req.protocol)));
  });

  // ✅ Caso sem token
  fastify.all('/stream/:type/:id.json', async (req, reply) => {
    const { type, id } = req.params as any;
    const query = req.query as any;
    const debridSelection = StreamService.resolveDebridSelection({
      query,
      headers: req.headers
    });

    try {
      const extra: { realdebridToken?: string; torboxToken?: string; debridProvider?: string; requestBaseUrl?: string } = {
        debridProvider: debridSelection.provider,
        requestBaseUrl: ConfigService.requestOrigin(req.headers, req.protocol)
      };
      if (debridSelection.realdebridToken) {
        extra.realdebridToken = debridSelection.realdebridToken;
      }
      if (debridSelection.torboxToken) {
        extra.torboxToken = debridSelection.torboxToken;
      }
      if (query?.fresh === '1' || query?.fresh === 'true' || query?.fresh === true) {
        (extra as { forceFresh?: boolean }).forceFresh = true;
      }

      const result = await streamController.handleStreamRequest({ type, id, extra });
      reply.header('cache-control', StreamController.cacheControlFor(result, { type, id })).send(result);
    } catch (error) {
      console.error(`[GuIndex] ❌ Erro no endpoint de stream: ${error instanceof Error ? error.message : 'Unknown error'}`);
      reply.send({ streams: [] });
    }
  });

  // Caso com token simples no caminho (compatibilidade legada)
  fastify.all('/:token/stream/:type/:id.json', async (req, reply) => {
    const { token, type, id } = req.params as any;
    const query = req.query as any;

    const debridSelection = StreamService.resolveDebridSelection({
      query,
      headers: req.headers,
      routeParams: { token }
    });

    try {
      const extra: { 
        realdebridToken?: string; 
        torboxToken?: string; 
        debridProvider?: string;
        token?: string;
        forceFresh?: boolean;
        requestBaseUrl?: string;
      } = {
        debridProvider: debridSelection.provider,
        token: debridSelection.token,
        torboxToken: debridSelection.torboxToken,
        realdebridToken: debridSelection.realdebridToken,
        requestBaseUrl: ConfigService.requestOrigin(req.headers, req.protocol)
      };

      if (query?.fresh === '1' || query?.fresh === 'true' || query?.fresh === true) {
        extra.forceFresh = true;
      }

      const result = await streamController.handleStreamRequest({ type, id, extra });
      reply.header('cache-control', StreamController.cacheControlFor(result, { type, id })).send(result);
    } catch (error) {
      console.error(`[GuIndex] ❌ Erro no endpoint de stream (legacy): ${error instanceof Error ? error.message : 'Unknown error'}`);
      reply.send({ streams: [] });
    }
  });

  // Novo formato: /provider/token/stream/:type/:id.json
  fastify.all('/:provider/:token/stream/:type/:id.json', async (req, reply) => {
    const { provider, token, type, id } = req.params as any;
    const query = req.query as any;

    const debridSelection = StreamService.resolveDebridSelection({
      query: { ...query, debridProvider: provider, token: token },
      headers: req.headers,
      routeParams: { token: token }
    });

    if (typeof id === 'string' && id.startsWith(LIBRARY_ID_PREFIX)) {
      const tbToken = libraryToken(provider, token);
      if (!tbToken) {
        reply.send({ streams: [] });
        return;
      }
      try {
        const base = config.baseUrlIsFallback
          ? ConfigService.requestOrigin(req.headers, req.protocol) ?? config.baseUrl
          : config.baseUrl;
        const streams = await fetchLibraryStreams(tbToken, id, base);
        reply.header('cache-control', 'private, no-store').send({ streams });
      } catch (error) {
        console.error(`[GuIndex] ❌ Stream Minha TorBox (${id}): ${error instanceof Error ? error.message : 'Unknown error'}`);
        reply.send({ streams: [] });
      }
      return;
    }

    try {
      const extra: { 
        realdebridToken?: string; 
        torboxToken?: string; 
        debridProvider?: string;
        token?: string;
        forceFresh?: boolean;
        requestBaseUrl?: string;
      } = {
        debridProvider: debridSelection.provider,
        token: debridSelection.token,
        torboxToken: debridSelection.torboxToken,
        realdebridToken: debridSelection.realdebridToken,
        requestBaseUrl: ConfigService.requestOrigin(req.headers, req.protocol)
      };

      if (query?.fresh === '1' || query?.fresh === 'true' || query?.fresh === true) {
        extra.forceFresh = true;
      }

      const result = await streamController.handleStreamRequest({ type, id, extra });
      reply.header('cache-control', StreamController.cacheControlFor(result, { type, id })).send(result);
    } catch (error) {
      console.error(`[GuIndex] ❌ Erro no endpoint de stream (/provider/token): ${error instanceof Error ? error.message : 'Unknown error'}`);
      reply.send({ streams: [] });
    }
  });

  const respondProbeSuccess = (reply: FastifyReply) => {
    reply
      .status(204)
      .header('cache-control', 'no-store, max-age=0')
      .header('x-guindex-probe', 'ok')
      .send();
  };

  const handleResolveRequest = async (
    reply: FastifyReply,
    token: string,
    magnet?: string,
    originalUrl?: string,
    provider?: string,
    linkType?: string,
    ctx?: string,
    userIp?: string,
    requestBaseUrl?: string
  ) => {
    // Sem BASE_URL no env, o placeholder sai como http://localhost/...; o player
    // não alcança esse endereço, então troca pela origem pública do pedido.
    const redirectTo = (url: string) => {
      const localBase = `${config.baseUrl}/`;
      reply.redirect(
        config.baseUrlIsFallback && requestBaseUrl && url.startsWith(localBase)
          ? `${requestBaseUrl}/${url.slice(localBase.length)}`
          : url
      );
    };
    try {
      const context = StreamService.decodeStreamContext(ctx);
      const debridProvider = StreamService.extractDebridProvider(
        { debridProvider: provider },
        {}
      );
      const resolvedProvider = debridProvider ?? 'realdebrid';

      if (resolvedProvider === 'torbox' && linkType === 'webdl' && originalUrl) {
        const directUrl = await streamController.processLinkForPlayback({
          url: originalUrl,
          token,
          provider: resolvedProvider,
          context,
          userIp
        });
        redirectTo(directUrl);
        return;
      }

      if (!magnet) {
        reply.status(400).send({ error: 'Magnet link is required for this provider' });
        return;
      }

      const directUrl = await streamController.processLinkForPlayback({
        magnet,
        token,
        provider: resolvedProvider,
        context,
        userIp
      });
      redirectTo(directUrl);
    } catch (error) {
      if (error instanceof RealDebridBlockedError) {
        // 451: o RD recusou o arquivo por denúncia; outro play não vai funcionar
        reply.status(451).send({
          error: 'infringing_file',
          message: 'O Real-Debrid bloqueou este arquivo (infringing_file). Escolha outro stream.'
        });
        return;
      }
      console.error(`[GuIndex] ❌ Erro no processamento do magnet: ${error instanceof Error ? error.message : 'Unknown error'}`);
      reply.status(500).send({ error: 'Failed to process magnet link' });
    }
  };

  /** Play de um arquivo do catálogo "Minha TorBox": link direto do torrent da conta. */
  const handleLibraryResolve = async (
    reply: FastifyReply,
    token: string,
    provider: string | undefined,
    query: Record<string, unknown>,
    userIp?: string
  ) => {
    const tbToken = provider ? libraryToken(provider, token) : undefined;
    const torrentId = Number.parseInt(String(query.torrentId ?? ''), 10);
    const fileIdRaw = query.fileId === undefined ? undefined : Number.parseInt(String(query.fileId), 10);
    if (!tbToken || !Number.isSafeInteger(torrentId) || torrentId < 0 || (fileIdRaw !== undefined && !Number.isSafeInteger(fileIdRaw))) {
      reply.status(400).send({ error: 'torrentId inválido ou provedor sem biblioteca' });
      return;
    }
    try {
      reply.redirect(await TorboxService.accountFileLink(tbToken, torrentId, fileIdRaw, userIp));
    } catch (error) {
      console.error(`[GuIndex] ❌ Play Minha TorBox (torrent ${torrentId}): ${error instanceof Error ? error.message : 'Unknown error'}`);
      reply.status(502).send({ error: 'Falha ao pedir o link à TorBox' });
    }
  };

  type ResolveRouteValues = {
    token?: string | undefined;
    magnet?: string | undefined;
    provider?: string | undefined;
    ctx?: string | undefined;
    url?: string | undefined;
    linkType?: string | undefined;
  };

  const registerResolveRoute = (
    url: string,
    extractor: (req: FastifyRequest) => ResolveRouteValues
  ) => {
    fastify.route({
      method: ['GET', 'HEAD'],
      url,
      handler: async (req, reply) => {
        const started = Date.now();
        if (req.method === 'HEAD') {
          respondProbeSuccess(reply);
          return;
        }

        const { token, magnet, provider, ctx } = extractor(req);
        const linkType = (req.query as any)?.linkType as string | undefined;
        const originalUrl = (req.query as any)?.url as string | undefined;
        const userIp = publicClientIp(req.ip);
        const requestBaseUrl = ConfigService.requestOrigin(req.headers, req.protocol);

        if (!token) {
          reply.status(400).send({ error: 'Debrid token is required' });
          return;
        }
        // Tokens de RD/TorBox têm algumas dezenas de caracteres. Sem teto, cada
        // token inventado (até ~16 KiB na query) ficava guardado no estado por
        // token do RealDebridService.
        if (typeof token !== 'string' || token.length > MAX_DEBRID_TOKEN_LENGTH) {
          reply.status(400).send({ error: 'Invalid debrid token' });
          return;
        }

        if (linkType === 'library') {
          await handleLibraryResolve(reply, token, provider, req.query as Record<string, unknown>, userIp);
          console.info(`[GuIndex] 🔗 Resolve (${provider}/library) finalizado em ${Date.now() - started}ms`);
          return;
        }

        if (linkType === 'webdl') {
          if (!originalUrl) {
            reply.status(400).send({ error: 'URL is required for TorBox WebDL' });
            return;
          }
          await handleResolveRequest(reply, token, undefined, originalUrl, provider, linkType, ctx, userIp, requestBaseUrl);
          console.info(`[GuIndex] 🔗 Resolve (${provider}/${linkType}) finalizado em ${Date.now() - started}ms`);
          return;
        }

        if (!magnet) {
          reply.status(400).send({ error: 'Magnet link is required' });
          return;
        }

        await handleResolveRequest(reply, token, magnet, undefined, provider, linkType, ctx, userIp, requestBaseUrl);
        console.info(`[GuIndex] 🔗 Resolve (${provider}/${linkType}) finalizado em ${Date.now() - started}ms`);
      }
    });
  };

  registerResolveRoute('/resolve', (req) => {
    const query = req.query as any;
    const provider = query.debridProvider ?? query.provider;
    const token = query.token || 
                  (provider === 'torbox' ? (query.torboxToken || query.tbToken) : (query.realdebridToken || query.rdToken));

    return {
      token: token,
      magnet: query.magnet,
      provider: provider,
      ctx: query.ctx,
      url: query.url,
      linkType: query.linkType
    };
  });

  registerResolveRoute('/resolve/:token/:magnet', (req) => {
    const params = req.params as { token?: string; magnet?: string };
    const query = req.query as { ctx?: string; debridProvider?: string; provider?: string; url?: string; linkType?: string };
    return {
      token: params.token,
      magnet: params.magnet,
      provider: query.debridProvider ?? query.provider,
      ctx: query.ctx,
      url: query.url,
      linkType: query.linkType
    };
  });

  // Novo formato consistente: /provider/token/resolve
  registerResolveRoute('/:provider/:token/resolve', (req) => {
    const { provider, token } = req.params as { provider: string; token: string };
    const query = req.query as any;
    return {
      token,
      provider,
      magnet: query.magnet,
      ctx: query.ctx,
      url: query.url,
      linkType: query.linkType
    };
  });

  fastify.get('/placeholder/downloading.mp4', async (_req, reply) => {
    reply.type('video/mp4');
    reply.sendFile('downloading.mp4');
  });

  // Health check para Docker/Render/Kubernetes
  fastify.get('/health', async (_req, reply) => {
    reply.send({ status: 'ok', timestamp: Date.now() });
  });

  return fastify;
}
