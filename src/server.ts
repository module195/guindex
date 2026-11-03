/**
 * GuIndex - Servidor Principal
 */

import 'dotenv/config';
import { setupRoutes } from './routes/routes.js';
import { ConfigService } from './services/config-service.js';

async function startServer() {
  const config = ConfigService.loadConfig();
  const fastify = setupRoutes();

  try {
    await fastify.listen({ port: config.port, host: '0.0.0.0' });
    console.info(`[GuIndex] 🟢 Servidor principal iniciado!`);
    console.info(`[GuIndex] 🔌 Rodando na porta: ${config.port}`);
    console.info(`[GuIndex] 🌐 Base URL: ${config.baseUrl}`);
    if (config.baseUrlIsFallback) {
      console.warn('[GuIndex] ⚠️ BASE_URL não definido: links e /configure usam a origem de cada pedido.');
    }
  } catch (error) {
    console.error('[GuIndex] ❌ Falha ao iniciar servidor:', error);
    process.exit(1);
  }

  // Desligamento limpo (docker stop, deploy): para de aceitar conexões e espera
  // os pedidos em andamento, com prazo para não travar o restart.
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.info(`[GuIndex] 🛑 ${signal} recebido, encerrando...`);
    const forceExit = setTimeout(() => {
      console.warn('[GuIndex] ⚠️ Encerramento passou de 10 s, saindo à força.');
      process.exit(1);
    }, 10_000);
    forceExit.unref();
    fastify
      .close()
      .then(() => process.exit(0))
      .catch((error) => {
        console.error('[GuIndex] ❌ Erro ao encerrar o servidor:', error);
        process.exit(1);
      });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

startServer();
