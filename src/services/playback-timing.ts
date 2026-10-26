/**
 * Tempo de cada etapa do play (lista da conta, criar torrent, pedir link, esperas).
 * As chamadas ao debrid registram aqui sem receber nada a mais: o AsyncLocalStorage
 * liga cada etapa ao play que está sendo resolvido. Fora de um play não registra nada.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

interface PlaybackStep {
  name: string;
  ms: number;
}

const storage = new AsyncLocalStorage<PlaybackStep[]>();

/** Roda fn e anota quanto tempo levou, se houver um play sendo medido. */
export async function timeStep<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const steps = storage.getStore();
  if (!steps) return fn();
  const started = Date.now();
  try {
    return await fn();
  } finally {
    steps.push({ name, ms: Date.now() - started });
  }
}

/** Espera ms milissegundos, anotada como etapa "espera". */
export function timedSleep(ms: number): Promise<void> {
  return timeStep('espera', () => new Promise<void>((resolve) => setTimeout(resolve, ms)));
}

/**
 * Roda fn medindo as etapas. As etapas ficam em `steps` na ordem em que terminaram,
 * também quando fn falha.
 */
export function withPlaybackTiming<T>(fn: () => Promise<T>): { steps: PlaybackStep[]; done: Promise<T> } {
  const steps: PlaybackStep[] = [];
  return { steps, done: storage.run(steps, fn) };
}

/** "info=3x 420ms, unrestrict=180ms": soma as etapas de mesmo nome, na ordem da primeira vez. */
export function formatSteps(steps: PlaybackStep[]): string {
  const totals = new Map<string, { count: number; ms: number }>();
  for (const step of steps) {
    const total = totals.get(step.name) ?? { count: 0, ms: 0 };
    total.count++;
    total.ms += step.ms;
    totals.set(step.name, total);
  }
  return [...totals]
    .map(([name, { count, ms }]) => `${name}=${count > 1 ? `${count}x ` : ''}${ms}ms`)
    .join(', ');
}
