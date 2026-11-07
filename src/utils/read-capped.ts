/**
 * Lê um corpo de resposta (stream do undici ou qualquer iterável assíncrono de
 * bytes) e o interpreta como JSON, com teto de bytes. Ao passar do teto, para
 * de ler, descarta o resto e lança erro: respostas de serviços externos não
 * podem decidir quanto o processo aloca.
 */
export async function readJsonCapped(
  body: AsyncIterable<Uint8Array> & { destroy?: (err?: Error) => unknown },
  maxBytes: number
): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      body.destroy?.();
      throw new Error(`Resposta maior que o teto de ${maxBytes} bytes`);
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
