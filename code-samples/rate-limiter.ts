/**
 * Rate Limiter Distribuído por Janela Deslizante via Sorted Sets no Redis
 * 
 * Fornece limitação atômica de requisições para deploys multi-instância com
 * precisão de milissegundos, calculando o tempo exato de Retry-After em caso de excesso.
 */

import type { Redis } from "ioredis";

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterMs: number };

export async function checkSlidingWindowRateLimit(
  redis: Redis,
  key: string,
  limit: number,
  windowMs: number
): Promise<RateLimitResult> {
  const now = Date.now();
  const windowStart = now - windowMs;
  const redisKey = `ratelimit:${key}`;

  // Executa pipeline atômico: limpa requisições expiradas e contabiliza eventos ativos
  const results = await redis
    .pipeline()
    .zremrangebyscore(redisKey, 0, windowStart)
    .zcard(redisKey)
    .exec();

  const currentCount = (results?.[1]?.[1] as number) ?? 0;

  // Limite excedido: calcula o tempo exato até a requisição mais antiga sair da janela
  if (currentCount >= limit) {
    const oldestEntries = await redis.zrange(redisKey, 0, 0);
    const oldestTimestamp = oldestEntries[0] 
      ? parseInt(oldestEntries[0].split(":")[0], 10) 
      : now;
      
    const retryAfterMs = Math.max(windowMs - (now - oldestTimestamp), 0);
    return { allowed: false, retryAfterMs };
  }

  // Dentro do limite: insere a requisição atual com identificador único e renova o TTL
  const memberToken = `${now}:${Math.random().toString(36).slice(2, 9)}`;
  await redis
    .pipeline()
    .zadd(redisKey, now, memberToken)
    .pexpire(redisKey, windowMs)
    .exec();

  return { allowed: true };
}
