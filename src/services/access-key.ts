/**
 * Modo privado (ADDON_ACCESS_KEY).
 *
 * Com a variável definida, a instância só atende pedidos que levam a chave
 * de acesso: a URL de instalação vira /torbox/<CHAVE>/manifest.json e os links
 * /resolve gerados levam a chave, nunca o token debrid. O token real vem do env
 * (TORBOX_TOKEN / REALDEBRID_TOKEN) e só é trocado no momento de montar a chamada
 * à API do debrid. Vazou um link? Troque a chave; o token continua secreto.
 */

import { timingSafeEqual } from 'node:crypto';

type Provider = 'torbox' | 'realdebrid';

const MIN_KEY_LENGTH = 16;
let warnedShortKey = false;
const warnedMissingToken = new Set<Provider>();

export function addonAccessKey(): string | undefined {
  const key = process.env.ADDON_ACCESS_KEY?.trim();
  if (!key) return undefined;
  if (key.length < MIN_KEY_LENGTH && !warnedShortKey) {
    warnedShortKey = true;
    console.warn(`[GuIndex] ⚠️ ADDON_ACCESS_KEY tem menos de ${MIN_KEY_LENGTH} caracteres; use uma chave longa e aleatória`);
  }
  return key;
}

export function isPrivateMode(): boolean {
  return addonAccessKey() !== undefined;
}

/** Compara em tempo constante para não vazar a chave por tempo de resposta. */
export function isAccessKey(value: unknown): boolean {
  const key = addonAccessKey();
  if (!key || typeof value !== 'string' || !value) return false;
  const a = Buffer.from(value);
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Token que vai para a API do debrid. A chave de acesso vira o token do env;
 * qualquer outro valor passa como veio.
 */
export function debridApiToken(token: string, provider: Provider): string {
  if (!isAccessKey(token)) return token;
  const real = (provider === 'torbox' ? process.env.TORBOX_TOKEN : process.env.REALDEBRID_TOKEN)?.trim();
  if (!real) {
    if (!warnedMissingToken.has(provider)) {
      warnedMissingToken.add(provider);
      const envName = provider === 'torbox' ? 'TORBOX_TOKEN' : 'REALDEBRID_TOKEN';
      console.error(`[GuIndex] ❌ ADDON_ACCESS_KEY usada com ${provider}, mas ${envName} não está definido`);
    }
    return token;
  }
  return real;
}

/** Caminhos que funcionam sem a chave: health check, vídeo de espera e arquivos estáticos. */
const PUBLIC_PATHS = new Set(['/health', '/placeholder/downloading.mp4', '/config-page.js', '/logo.png', '/logo-144.jpg', '/guindex-logo.png', '/favicon.ico']);

/**
 * O pedido leva a chave? Vale como segmento inteiro do caminho
 * (/torbox/<CHAVE>/..., /<CHAVE>/..., /resolve/<CHAVE>/...) ou em ?key= / ?token=.
 */
export function requestCarriesAccessKey(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl, 'http://guindex.local');
  } catch {
    return false;
  }
  if (PUBLIC_PATHS.has(url.pathname)) return true;
  for (const segment of url.pathname.split('/')) {
    if (!segment) continue;
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      // segmento mal codificado: compara cru
    }
    if (isAccessKey(decoded)) return true;
  }
  return isAccessKey(url.searchParams.get('key')) || isAccessKey(url.searchParams.get('token'));
}
