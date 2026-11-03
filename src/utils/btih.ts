/**
 * Info hash do magnet em hex minúsculo. Aceita o btih em hex (40) ou em base32
 * (32, RFC 4648), que alguns sites brasileiros publicam.
 */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function btihToHex(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  if (/^[a-f0-9]{40}$/i.test(raw)) return raw.toLowerCase();
  if (!/^[a-z2-7]{32}$/i.test(raw)) return undefined;
  let bits = 0;
  let buffer = 0;
  let hex = '';
  for (const char of raw.toUpperCase()) {
    buffer = (buffer << 5) | BASE32_ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      hex += ((buffer >> bits) & 0xff).toString(16).padStart(2, '0');
    }
  }
  return hex;
}

/** btih do magnet em hex; undefined sem xt reconhecível. */
export function magnetHexHash(magnet: string | undefined): string | undefined {
  return btihToHex(magnet?.match(/xt=urn:btih:([^&]+)/i)?.[1]);
}
