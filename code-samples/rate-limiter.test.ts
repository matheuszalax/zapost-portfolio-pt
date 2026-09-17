import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import Redis from "ioredis";
import { checkSlidingWindowRateLimit } from "./rate-limiter";

const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:16379";

test("requisições concorrentes em clientes diferentes respeitam o limite", async () => {
  const clients = Array.from({ length: 8 }, () => new Redis(redisUrl));
  const key = `test:${randomUUID()}`;
  try {
    await Promise.all(clients.map(client => client.ping()));
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) =>
      checkSlidingWindowRateLimit(clients[i % clients.length], key, 5, 10_000)
    ));
    assert.equal(results.filter(result => result.allowed).length, 5);
    assert.equal(await clients[0].zcard(`ratelimit:${key}`), 5);
    for (const result of results) {
      if (!result.allowed) assert.ok(result.retryAfterMs > 0 && result.retryAfterMs <= 10_000);
    }
  } finally {
    await clients[0].del(`ratelimit:${key}`);
    clients.forEach(client => client.disconnect());
  }
});

test("a janela expira e permite uma nova requisição", async () => {
  const client = new Redis(redisUrl);
  const key = `test:${randomUUID()}`;
  try {
    assert.deepEqual(await checkSlidingWindowRateLimit(client, key, 1, 150), { allowed: true });
    const denied = await checkSlidingWindowRateLimit(client, key, 1, 150);
    assert.equal(denied.allowed, false);
    await delay(200);
    assert.deepEqual(await checkSlidingWindowRateLimit(client, key, 1, 150), { allowed: true });
  } finally {
    await client.del(`ratelimit:${key}`);
    client.disconnect();
  }
});
