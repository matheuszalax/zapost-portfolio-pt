/**
 * Semáforo Distribuído de Concorrência via Primitivas Atômicas do Redis
 * 
 * Limita a execução simultânea de tarefas computacionalmente custosas
 * (ex: regeração de legendas de IA em tempo real) em serviços horizontalmente escalados.
 */

import type { Redis } from "ioredis";

export type ConcurrencyResult =
  | { acquired: true; release: () => Promise<void> }
  | { acquired: false };

export async function acquireDistributedSemaphore(
  redis: Redis,
  key: string,
  maxConcurrency: number,
  ttlMs: number = 60_000
): Promise<ConcurrencyResult> {
  const semaphoreKey = `semaphore:${key}`;

  // Incrementa atomicamente o contador de execuções ativas
  const currentCount = await redis.incr(semaphoreKey);

  // Configura TTL de segurança na primeira requisição para evitar deadlocks em caso de crash do worker
  if (currentCount === 1) {
    await redis.pexpire(semaphoreKey, ttlMs);
  }

  // Limite excedido: decrementa imediatamente e recusa a concessão
  if (currentCount > maxConcurrency) {
    await redis.decr(semaphoreKey);
    return { acquired: false };
  }

  // Retorna a concessão com função de encerramento
  const release = async () => {
    await redis.decr(semaphoreKey);
  };

  return { acquired: true, release };
}
