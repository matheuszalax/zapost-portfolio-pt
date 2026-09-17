/**
 * Amostra de janela deslizante distribuída para Redis 7.
 * A decisão de admitir, inserir e calcular a espera ocorre em uma execução Lua.
 * Isto ilustra o algoritmo; não comprova a configuração do serviço privado.
 */

import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterMs: number };

const SLIDING_WINDOW_SCRIPT = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local member = ARGV[3]
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)

-- A janela contém eventos com score > now - windowMs.
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - windowMs)
if redis.call('ZCARD', key) >= limit then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  return {0, math.max(1, tonumber(oldest[2]) + windowMs - now)}
end

redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, windowMs)
return {1, 0}
`;

export async function checkSlidingWindowRateLimit(
  redis: Redis,
  key: string,
  limit: number,
  windowMs: number
): Promise<RateLimitResult> {
  if (!key || !Number.isSafeInteger(limit) || limit <= 0 ||
      !Number.isSafeInteger(windowMs) || windowMs <= 0) {
    throw new RangeError("key, limit e windowMs devem ser válidos e positivos");
  }

  // UUID impede colisão entre chamadas no mesmo milissegundo e em instâncias diferentes.
  const result = await redis.eval(
    SLIDING_WINDOW_SCRIPT,
    1,
    `ratelimit:${key}`,
    String(limit),
    String(windowMs),
    randomUUID()
  ) as [number, number];

  return result[0] === 1
    ? { allowed: true }
    : { allowed: false, retryAfterMs: result[1] };
}
