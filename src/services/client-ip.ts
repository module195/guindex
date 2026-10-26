/**
 * IP do usuário para o debrid escolher o CDN mais perto dele (o `user_ip` do TorBox).
 * Só vale IP público: o de rede interna (proxy do Easypanel, Docker, LAN) faria o
 * debrid escolher pelo lugar errado, e aí é melhor não mandar nada.
 */

import { isIP } from 'node:net';

function isPrivateIpv4(ip: string): boolean {
  const [a = 0, b = 0] = ip.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  return (
    lower === '::' ||
    lower === '::1' ||
    lower.startsWith('fc') ||
    lower.startsWith('fd') ||
    lower.startsWith('fe8') ||
    lower.startsWith('fe9') ||
    lower.startsWith('fea') ||
    lower.startsWith('feb') ||
    lower.startsWith('ff')
  );
}

/** O IP se for público; `undefined` para vazio, inválido ou de rede interna. */
export function publicClientIp(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  // IPv4 dentro de IPv6 (::ffff:1.2.3.4), como o Node entrega em socket dual-stack
  const ip = trimmed.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1] ?? trimmed;
  const version = isIP(ip);
  if (version === 4) return isPrivateIpv4(ip) ? undefined : ip;
  if (version === 6) return isPrivateIpv6(ip) ? undefined : ip;
  return undefined;
}
