// Magnet com btih em base32 (bludv_ru, rede_torrent...) sai do resolve em hex,
// para o play reconhecer o torrent da conta e o bloqueio do RD. npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { btihToHex, magnetHexHash } = await import('../dist/utils/btih.js');
const { StreamController } = await import('../dist/controllers/stream-controller.js');

const HEX = 'c12fe1c06bba254a9dc9f519b335aa7c1367a88a';
const B32 = 'YEX6DQDLXISUVHOJ6UM3GNNKPQJWPKEK';

test('base32 vira o mesmo hash em hex', () => {
  assert.equal(btihToHex(B32), HEX);
  assert.equal(btihToHex(B32.toLowerCase()), HEX);
  assert.equal(btihToHex(HEX.toUpperCase()), HEX);
  assert.equal(btihToHex('curto'), undefined);
  assert.equal(magnetHexHash(`magnet:?xt=urn:btih:${B32}&dn=x`), HEX);
});

test('o magnet do resolve troca o xt base32 pelo hex', () => {
  const magnet = `magnet:?xt=urn:btih:${B32}&dn=Filme&tr=udp://t`;
  assert.equal(StreamController.magnetWithHexHash(magnet, HEX), `magnet:?xt=urn:btih:${HEX}&dn=Filme&tr=udp://t`);
  assert.equal(StreamController.magnetWithHexHash(magnet), `magnet:?xt=urn:btih:${HEX}&dn=Filme&tr=udp://t`, 'sem infoHash, converte o próprio');
  const hexMagnet = `magnet:?xt=urn:btih:${HEX.toUpperCase()}&dn=x`;
  assert.equal(StreamController.magnetWithHexHash(hexMagnet, HEX), hexMagnet, 'hex fica como está');
});

test('o stream com magnet base32 gera resolve com hex', () => {
  const controller = new StreamController();
  const magnet = controller.extractStreamMagnet({ magnet: `magnet:?xt=urn:btih:${B32}`, infoHash: HEX });
  assert.equal(magnet, `magnet:?xt=urn:btih:${HEX}`);
});
