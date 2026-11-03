/**
 * Map com teto de entradas. Ao passar do teto, descarta a entrada gravada há
 * mais tempo (a ordem de inserção do Map; regravar uma chave a leva para o fim).
 * Serve para caches estáticos que antes cresciam sem limite durante a vida do
 * processo; o TTL de cada cache continua sendo conferido na leitura.
 */
export class BoundedMap<K, V> extends Map<K, V> {
  constructor(private readonly maxEntries: number) {
    super();
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError(`BoundedMap: maxEntries inválido (${maxEntries})`);
    }
  }

  override set(key: K, value: V): this {
    if (super.has(key)) {
      super.delete(key);
    } else {
      while (this.size >= this.maxEntries) {
        const oldest = this.keys().next();
        if (oldest.done) break;
        super.delete(oldest.value);
      }
    }
    return super.set(key, value);
  }
}
