/**
 * Configuration Service
 * Carrega variaveis de ambiente e monta a configuracao do addon.
 */

import type { AppConfig } from '../models/config-model.js';

export class ConfigService {
  static loadConfig(): AppConfig {
    const port = Number(process.env.PORT || 7000);
    const logLevel = (process.env.LOG_LEVEL as AppConfig['logLevel']) || 'info';

    // BASE_URL > VERCEL_PROJECT_PRODUCTION_URL > VERCEL_URL > RENDER_EXTERNAL_URL > localhost
    const envBaseUrl =
      ConfigService.normalizeBaseUrl(process.env.BASE_URL) ||
      ConfigService.normalizeBaseUrl(process.env.VERCEL_PROJECT_PRODUCTION_URL) ||
      ConfigService.normalizeBaseUrl(process.env.VERCEL_URL) ||
      ConfigService.normalizeBaseUrl(process.env.RENDER_EXTERNAL_URL);
    const normalizedBaseUrl = envBaseUrl || ConfigService.normalizeBaseUrl(`http://localhost:${port}`)!;

    const waitVideoUrl =
      ConfigService.normalizeBaseUrl(process.env.TORBOX_WAIT_VIDEO_URL) ||
      `${normalizedBaseUrl}/placeholder/downloading.mp4`;

    const torboxStreamLimit =
      Number(process.env.TORBOX_STREAM_LIMIT) && Number(process.env.TORBOX_STREAM_LIMIT) > 0
        ? Number(process.env.TORBOX_STREAM_LIMIT)
        : 15;

    const config: AppConfig = {
      port,
      logLevel,
      baseUrl: normalizedBaseUrl,
      baseUrlIsFallback: !envBaseUrl,
      waitVideoUrl,
      torboxStreamLimit
    };

    return config;
  }

  /**
   * Origem pública do pedido (atrás de proxy, pelos cabeçalhos X-Forwarded-*).
   * Serve de base quando nenhuma variável de ambiente define a URL da instância.
   */
  static requestOrigin(headers: Record<string, string | string[] | undefined>, protocol?: string): string | undefined {
    const first = (value: string | string[] | undefined) =>
      (Array.isArray(value) ? value[0] : value)?.split(',')[0]?.trim() || undefined;
    const host = first(headers['x-forwarded-host']) || first(headers.host);
    if (!host) return undefined;
    const proto = first(headers['x-forwarded-proto']) || protocol || 'https';
    return ConfigService.normalizeBaseUrl(`${proto}://${host}`);
  }

  private static normalizeBaseUrl(value?: string | null): string | undefined {
    if (!value) return undefined;

    let candidate = value.trim();
    if (!candidate) return undefined;

    if (!/^https?:\/\//i.test(candidate)) {
      candidate = `https://${candidate}`;
    }

    try {
      const parsed = new URL(candidate);
      const trimmedPath = parsed.pathname.replace(/\/+$/, '');
      parsed.pathname = trimmedPath || '/';
      parsed.search = '';
      parsed.hash = '';
      return parsed.toString().replace(/\/+$/, '');
    } catch (error) {
      console.warn(`[GuIndex] URL base invalida (${value}):`, error);
      return undefined;
    }
  }
}
