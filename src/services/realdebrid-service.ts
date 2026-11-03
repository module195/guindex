/**
 * Real-Debrid Service
 *
 * Handles magnet → direct-link resolution via the Real-Debrid API.
 * Includes comprehensive file selection with language-aware, BR-optimised
 * episode matching that supports:
 *   - Standard SxxExx notation
 *   - NxNN / N×NN (multiplication sign U+00D7)
 *   - Bare-number filenames ("2 - Sick.mp4")
 *   - Portuguese keywords (episódio, capítulo, temporada)
 *   - Concatenated season+episode (302 = S03E02)
 *   - Junk / ad file rejection (samples, promos, .nfo, .url, tiny files)
 */

import { request } from 'undici';
import { ConfigService } from './config-service.js';
import { timeStep, timedSleep } from './playback-timing.js';
import type { TorrentInfo, MagnetResponse, UnrestrictResponse } from '../models/realdebrid-model.js';
import type { StreamContext } from '../models/source-model.js';
import { BoundedMap } from '../utils/bounded-map.js';
import { debridApiToken } from './access-key.js';
import { magnetHexHash } from '../utils/btih.js';
import { selectBestFile } from './file-selection.js';

interface AccountTorrent {
  id?: string;
  hash?: string;
  status?: string;
}

interface AccountHashesCacheEntry {
  /** hash (minúsculo) → id do torrent baixado na conta ('' se o RD não mandou) */
  torrents: Map<string, string>;
  expires: number;
}

// ── Constants ────────────────────────────────────────────────────────────────
const API_BASE = 'https://api.real-debrid.com/rest/1.0';
const REQUEST_TIMEOUT_MS = 15_000;
/** Esperas entre consultas enquanto o RD converte o magnet (~6 s no total). */
const RD_CONVERSION_POLL_DELAYS_MS = [500, 1000, 1500, 1500, 1500];
/** Esperas entre consultas depois do selectFiles (5 s no total, como a espera fixa de antes). */
const RD_READY_POLL_DELAYS_MS = [500, 1000, 1500, 2000];
/** Status do RD em que esperar mais não adianta. */
const RD_FAILED_STATUSES = new Set(['magnet_error', 'error', 'virus', 'dead']);




/** error_code 35 do RD: arquivo bloqueado por denúncia de direitos autorais */
const RD_INFRINGING_FILE_CODE = 35;

/** O RD recusou o arquivo (error_code 35, "infringing_file"); tentar de novo não adianta. */
export class RealDebridBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RealDebridBlockedError';
  }
}

/** Erro de uma chamada ao RD; vira RealDebridBlockedError quando o corpo traz o error_code 35. */
function realDebridError(prefix: string, statusCode: number, body: string): Error {
  let parsed: { error?: unknown; error_code?: unknown } | undefined;
  try {
    parsed = JSON.parse(body) as { error?: unknown; error_code?: unknown };
  } catch {
    parsed = undefined;
  }
  const message = `${prefix}: ${statusCode} ${body}`;
  if (parsed?.error_code === RD_INFRINGING_FILE_CODE || parsed?.error === 'infringing_file') {
    return new RealDebridBlockedError(message);
  }
  return new Error(message);
}

/** Extrai o btih (hex, minúsculo) de um magnet; base32 é convertido. */
function magnetHash(magnet: string): string | undefined {
  return magnetHexHash(magnet);
}

export class RealDebridService {
  /**
   * O Real-Debrid desativou /torrents/instantAvailability em nov/2024 (error_code 37,
   * "disabled_endpoint") e não há substituto público. O único sinal confiável que resta
   * é a lista de torrents da própria conta: hash com status "downloaded" toca na hora.
   */
  private static readonly ACCOUNT_HASHES_TTL_MS = 2 * 60 * 1000;
  private static readonly ACCOUNT_TORRENTS_LIMIT = 2500;
  /** Chave = token, para a lista de um usuário nunca vazar para outro */
  private static accountHashesCache = new BoundedMap<string, AccountHashesCacheEntry>(500);
  private static accountHashesInFlight = new Map<string, Promise<Map<string, string> | undefined>>();
  /** Após 401/403 em /torrents, pausa novas chamadas por este período */
  private static readonly ACCOUNT_TORRENTS_DISABLE_MS = (() => {
    const parsed = Number.parseInt(process.env.RD_ACCOUNT_TORRENTS_DISABLE_MS ?? '', 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 10 * 60 * 1000;
  })();
  private static accountTorrentsDisabledUntil = new Map<string, number>();
  /**
   * Arquivos que o RD recusou com infringing_file. O bloqueio vale para o
   * conteúdo, não para a conta, então a chave é hash + episódio, sem token.
   */
  private static readonly BLOCKED_TTL_MS = (() => {
    const parsed = Number.parseInt(process.env.RD_BLOCKED_TTL_MS ?? '', 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 24 * 60 * 60 * 1000;
  })();
  private static readonly BLOCKED_MAX_ENTRIES = 5000;
  private static blockedFiles = new Map<string, number>();

  private static blockedKey(hash: string, context?: StreamContext): string {
    const episode = context?.season !== undefined && context?.episode !== undefined
      ? `${context.season}x${context.episode}`
      : '';
    return `${hash.toLowerCase()}|${episode}`;
  }

  /** true se o RD já recusou este arquivo (hash + episódio) com infringing_file. */
  static isBlocked(hash: string, context?: StreamContext): boolean {
    const key = this.blockedKey(hash, context);
    const expires = this.blockedFiles.get(key);
    if (expires === undefined) {
      return false;
    }
    if (expires <= Date.now()) {
      this.blockedFiles.delete(key);
      return false;
    }
    return true;
  }

  static markBlocked(hash: string, context?: StreamContext): void {
    if (this.BLOCKED_TTL_MS === 0) {
      return;
    }
    if (this.blockedFiles.size >= this.BLOCKED_MAX_ENTRIES) {
      const oldest = this.blockedFiles.keys().next().value;
      if (oldest !== undefined) {
        this.blockedFiles.delete(oldest);
      }
    }
    this.blockedFiles.set(this.blockedKey(hash, context), Date.now() + this.BLOCKED_TTL_MS);
  }

  private readonly token: string;

  constructor(token: string) {
    this.token = debridApiToken(token, 'realdebrid');
  }

  // ── Public API ──────────────────────────────────────────────────────────

  async addMagnet(magnet: string): Promise<MagnetResponse> {
    return timeStep('add', () => this.addMagnetRequest(magnet));
  }

  private async addMagnetRequest(magnet: string): Promise<MagnetResponse> {
    const response = await request(`${API_BASE}/torrents/addMagnet`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ magnet }).toString(),
      headersTimeout: REQUEST_TIMEOUT_MS,
      bodyTimeout: REQUEST_TIMEOUT_MS
    });

    if (response.statusCode >= 400) {
      const body = await response.body.text().catch(() => '');
      throw realDebridError('Failed to add magnet', response.statusCode, body);
    }

    return await response.body.json() as MagnetResponse;
  }

  async selectFiles(torrentId: string, fileIds: string): Promise<void> {
    return timeStep('selecionar', () => this.selectFilesRequest(torrentId, fileIds));
  }

  private async selectFilesRequest(torrentId: string, fileIds: string): Promise<void> {
    const response = await request(`${API_BASE}/torrents/selectFiles/${torrentId}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ files: fileIds }).toString(),
      headersTimeout: REQUEST_TIMEOUT_MS,
      bodyTimeout: REQUEST_TIMEOUT_MS
    });

    if (response.statusCode >= 400) {
      const body = await response.body.text().catch(() => '');
      throw realDebridError('Failed to select files', response.statusCode, body);
    }
  }

  async getTorrentInfo(torrentId: string): Promise<TorrentInfo> {
    return timeStep('info', () => this.getTorrentInfoRequest(torrentId));
  }

  private async getTorrentInfoRequest(torrentId: string): Promise<TorrentInfo> {
    const response = await request(`${API_BASE}/torrents/info/${torrentId}`, {
      headers: { 'Authorization': `Bearer ${this.token}` },
      headersTimeout: REQUEST_TIMEOUT_MS,
      bodyTimeout: REQUEST_TIMEOUT_MS
    });

    if (response.statusCode >= 400) {
      const body = await response.body.text().catch(() => '');
      throw realDebridError('Failed to get torrent info', response.statusCode, body);
    }

    return await response.body.json() as TorrentInfo;
  }

  async unrestrictLink(link: string): Promise<UnrestrictResponse> {
    return timeStep('unrestrict', () => this.unrestrictLinkRequest(link));
  }

  private async unrestrictLinkRequest(link: string): Promise<UnrestrictResponse> {
    const response = await request(`${API_BASE}/unrestrict/link`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ link }).toString(),
      headersTimeout: REQUEST_TIMEOUT_MS,
      bodyTimeout: REQUEST_TIMEOUT_MS
    });

    if (response.statusCode >= 400) {
      const body = await response.body.text().catch(() => '');
      throw realDebridError('Failed to unrestrict link', response.statusCode, body);
    }

    return await response.body.json() as UnrestrictResponse;
  }

  // ── Cache check (torrents já baixados na conta) ─────────────────────────

  /**
   * Devolve os hashes (minúsculos) que já estão baixados na conta RD do token.
   * Hash fora desse conjunto não é "não cacheado": é desconhecido, porque o RD
   * não expõe mais o cache global.
   */
  static async fetchCachedInfoHashes(
    hashes: string[],
    token?: string
  ): Promise<Set<string>> {
    return (await this.checkCachedInfoHashes(hashes, token)) ?? new Set<string>();
  }

  /**
   * Como `fetchCachedInfoHashes`, mas `undefined` quando a lista da conta não
   * veio (erro de rede, timeout, 5xx): sem resposta, não "nada baixado".
   */
  static async checkCachedInfoHashes(hashes: string[], token?: string): Promise<Set<string> | undefined> {
    const result = new Set<string>();
    if (!token || !hashes || hashes.length === 0) {
      return result;
    }

    const accountTorrents = await this.getAccountDownloadedTorrents(token);
    if (!accountTorrents) return undefined;
    for (const hash of hashes) {
      const normalized = hash?.toLowerCase();
      if (normalized && accountTorrents.has(normalized)) {
        result.add(normalized);
      }
    }
    return result;
  }

  /** Lista da conta já em memória, sem consultar o Real-Debrid; `undefined` se não houver. */
  static knownAccountTorrents(token: string): Map<string, string> | undefined {
    const now = Date.now();
    const cached = this.accountHashesCache.get(token);
    if (cached && cached.expires > now) {
      return cached.torrents;
    }

    const disabledUntil = this.accountTorrentsDisabledUntil.get(token);
    if (disabledUntil !== undefined && now < disabledUntil) {
      return new Map();
    }
    return undefined;
  }

  private static async getAccountDownloadedTorrents(token: string): Promise<Map<string, string> | undefined> {
    const known = this.knownAccountTorrents(token);
    if (known) {
      return known;
    }

    const inFlight = this.accountHashesInFlight.get(token);
    if (inFlight) {
      return inFlight;
    }

    const promise = this.fetchAccountDownloadedTorrents(token).finally(() => {
      this.accountHashesInFlight.delete(token);
    });
    this.accountHashesInFlight.set(token, promise);
    return promise;
  }

  /** Lista da conta; `undefined` quando ela não veio (o 401/403 conta como conta vazia). */
  private static async fetchAccountDownloadedTorrents(token: string): Promise<Map<string, string> | undefined> {
    const torrents = new Map<string, string>();
    try {
      const response = await request(
        `${API_BASE}/torrents?limit=${this.ACCOUNT_TORRENTS_LIMIT}`,
        {
          headers: { Authorization: `Bearer ${debridApiToken(token, 'realdebrid')}` },
          headersTimeout: REQUEST_TIMEOUT_MS,
          bodyTimeout: REQUEST_TIMEOUT_MS
        }
      );

      // 204 = conta sem torrents
      if (response.statusCode === 204) {
        await response.body.dump();
      } else if (response.statusCode >= 400) {
        await response.body.dump();
        if (response.statusCode === 401 || response.statusCode === 403) {
          this.accountTorrentsDisabledUntil.set(token, Date.now() + this.ACCOUNT_TORRENTS_DISABLE_MS);
          console.warn(`[RealDebrid] /torrents retornou ${response.statusCode}; pausando verificações por ${this.ACCOUNT_TORRENTS_DISABLE_MS}ms`);
          return torrents;
        }
        return undefined;
      } else {
        const payload = (await response.body.json()) as unknown;
        for (const entry of Array.isArray(payload) ? (payload as AccountTorrent[]) : []) {
          if (entry?.status === 'downloaded' && typeof entry.hash === 'string' && entry.hash) {
            torrents.set(entry.hash.toLowerCase(), typeof entry.id === 'string' ? entry.id : '');
          }
        }
      }
    } catch {
      return undefined;
    }

    this.accountHashesCache.set(token, {
      torrents,
      expires: Date.now() + this.ACCOUNT_HASHES_TTL_MS
    });
    return torrents;
  }

  // ── Magnet → Direct URL ─────────────────────────────────────────────────

  async processMagnetToDirectUrl(magnet: string, context?: StreamContext): Promise<string> {
    const hash = magnetHash(magnet);
    if (hash && RealDebridService.isBlocked(hash, context)) {
      throw new RealDebridBlockedError(`Real-Debrid já recusou este arquivo (infringing_file): ${hash}`);
    }
    try {
      return await this.resolveMagnet(magnet, context);
    } catch (error) {
      if (error instanceof RealDebridBlockedError && hash) {
        RealDebridService.markBlocked(hash, context);
        console.warn(`[RD] arquivo bloqueado pelo Real-Debrid (infringing_file): ${hash}`);
      }
      throw error;
    }
  }

  private async resolveMagnet(magnet: string, context?: StreamContext): Promise<string> {
    // Stream cacheado = torrent já baixado na conta. Reaproveitar evita uma
    // entrada nova na conta a cada play.
    const reused = await this.tryExistingTorrent(magnet, context).catch((error) => {
      if (error instanceof RealDebridBlockedError) {
        throw error;
      }
      console.warn('[RD] falha ao reaproveitar torrent da conta; adicionando o magnet:', error);
      return undefined;
    });
    if (reused) {
      return reused;
    }

    const { id: torrentId } = await this.addMagnet(magnet);

    const torrentInfo = await this.waitForMagnetConversion(torrentId);

    if (!torrentInfo.files || torrentInfo.files.length === 0) {
      throw new Error(`No files found in torrent: ${torrentId} (status ${torrentInfo.status})`);
    }

    const selectedFile = this.selectBestFile(torrentInfo.files, context);
    if (!selectedFile) {
      throw new Error('No playable files found in torrent');
    }

    console.debug(`[RD] selected file id=${selectedFile.id} path=${selectedFile.path} bytes=${selectedFile.bytes}`);

    // Select file in RD
    await this.selectFiles(torrentId, String(selectedFile.id));

    // Cacheado no RD vira "downloaded" em pouco tempo: consultas curtas devolvem o
    // link assim que fica pronto, em vez de uma espera fixa.
    let currentInfo = await this.getTorrentInfo(torrentId);
    for (const delay of RD_READY_POLL_DELAYS_MS) {
      if (currentInfo.status === 'downloaded') break;
      if (RD_FAILED_STATUSES.has(currentInfo.status)) {
        throw new Error(`Real-Debrid torrent ${torrentId} failed: ${currentInfo.status}`);
      }
      await timedSleep(delay);
      currentInfo = await this.getTorrentInfo(torrentId);
    }
    if (currentInfo.status === 'downloaded') {
      return await this.getDirectDownloadUrl(torrentId, currentInfo);
    }

    // Still not ready, return placeholder video URL
    return this.createPlaceholderUrl(torrentId);
  }

  /**
   * Logo depois do addMagnet o RD pode ainda estar convertendo o magnet
   * (magnet_conversion), sem a lista de arquivos. Consulta de novo até a lista sair.
   */
  private async waitForMagnetConversion(torrentId: string): Promise<TorrentInfo> {
    let info = await this.getTorrentInfo(torrentId);
    for (const delay of RD_CONVERSION_POLL_DELAYS_MS) {
      if (info.files?.length || info.status !== 'magnet_conversion') break;
      await timedSleep(delay);
      info = await this.getTorrentInfo(torrentId);
    }
    if (RD_FAILED_STATUSES.has(info.status)) {
      throw new Error(`Real-Debrid torrent ${torrentId} failed: ${info.status}`);
    }
    return info;
  }

  /**
   * Usa o torrent que já está baixado na conta, quando o arquivo escolhido já
   * está entre os selecionados. Senão devolve undefined e o fluxo normal segue.
   */
  private async tryExistingTorrent(magnet: string, context?: StreamContext): Promise<string | undefined> {
    const hash = magnetHash(magnet);
    if (!hash) {
      return undefined;
    }
    const accountTorrents = await timeStep('lista_conta', () => RealDebridService.getAccountDownloadedTorrents(this.token));
    const torrentId = accountTorrents?.get(hash);
    if (!torrentId) {
      return undefined;
    }

    const info = await this.getTorrentInfo(torrentId);
    if (info.status !== 'downloaded' || !info.files || info.files.length === 0) {
      return undefined;
    }
    const file = this.selectBestFile(info.files, context);
    // O RD devolve um link por arquivo selecionado, na ordem dos ids
    const selected = info.files.filter((f) => f.selected === 1).sort((a, b) => a.id - b.id);
    const index = file ? selected.findIndex((f) => f.id === file.id) : -1;
    const link = index >= 0 && info.links?.length === selected.length ? info.links[index] : undefined;
    if (!link) {
      return undefined;
    }

    console.debug(`[RD] reusing torrent id=${torrentId} file id=${file?.id} path=${file?.path}`);
    const { download } = await this.unrestrictLink(link);
    return download;
  }

  /** `info` é o info já consultado com status downloaded; poupa uma consulta quando traz os links. */
  private async getDirectDownloadUrl(torrentId: string, info?: TorrentInfo): Promise<string> {
    const finalInfo = info?.links?.length ? info : await this.getTorrentInfo(torrentId);

    if (!finalInfo.links || finalInfo.links.length === 0) {
      throw new Error(`No download links available for torrent: ${torrentId}`);
    }

    const downloadLink = finalInfo.links[0];
    if (!downloadLink) {
      throw new Error(`Download link is undefined for torrent: ${torrentId}`);
    }

    const { download } = await this.unrestrictLink(downloadLink);
    return download;
  }

  private createPlaceholderUrl(torrentId: string): string {
    const config = ConfigService.loadConfig();
    return `${config.baseUrl}/placeholder/downloading.mp4`;
  }

  // ── File Selection Engine ───────────────────────────────────────────────

  private selectBestFile(
    files: NonNullable<TorrentInfo['files']>,
    context?: StreamContext
  ): NonNullable<TorrentInfo['files']>[number] | undefined {
    return selectBestFile(files, (file) => ({ path: file.path, bytes: file.bytes }), context);
  }
}
