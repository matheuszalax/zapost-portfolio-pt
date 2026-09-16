# 02 — Filas Distribuídas, Workers & Rate Limiting

## Visão Geral da Arquitetura Assíncrona

Em aplicações SaaS que realizam inferência de Inteligência Artificial e processamento pesado de mídia, manter as operações acopladas ao ciclo de requisição HTTP síncrono causa esgotamento de conexões, timeouts no navegador e degradação da experiência do usuário.

O zapost desacopla operações computacionalmente intensas utilizando **BullMQ** sobre uma instância dedicada do **Redis 7**.

```
┌──────────────────┐      HTTP POST /api/posts/generate       ┌──────────────────────┐
│ Cliente Browser  ├─────────────────────────────────────────►│  Servidor Next.js    │
└────────┬─────────┘                                          └──────────┬───────────┘
         │                                                               │
         │  ◄── 202 Accepted { jobId: "ai_98765" } ─────────────────────┤
         │                                                               │
         │  Polling GET /api/posts/generate/status/:jobId                │ Enfileira Job
         │  (A cada 2000ms com feedback visual progressivo)              ▼
         │                                                    ┌──────────────────────┐
         ├───────────────────────────────────────────────────►│   Redis 7 (BullMQ)   │
         │                                                    └──────────┬───────────┘
         │                                                               │
         ▼                                                               ▼ Desenfileira
┌──────────────────┐                                          ┌──────────────────────┐
│ Renderiza Post   │◄─────────────────────────────────────────┤   Worker Dedicado    │
│ & Ativos Finais  │            Status: "completed"           │   (Node 22 + tsx)    │
└──────────────────┘                                          └──────────────────────┘
```

---

## 1. Desenho das Filas BullMQ

A plataforma opera com filas especializadas que possuem garantias de ciclo de vida específicas:

### A. Fila de Geração de Posts (`post-generation`)
* **Concorrência:** 2 jobs simultâneos por container worker para evitar sobrecarga de CPU e picos de memória durante manipulação de imagens e parsing.
* **Rate Limiter Interno:** Limitado a 10 jobs por minuto no nível do worker.
* **Estratégia de Retry:** 2 retentativas automáticas com backoff exponencial (`delay: 30000ms`).
* **Retenção de Dados:** Jobs concluídos são mantidos por 24 horas para auditoria e status; jobs com falha persistem por 48 horas para rastreamento no Sentry.

### B. Fila de Checkout Abandonado (`abandoned-checkout`)
* **Atraso Agendado:** O job é enfileirado no momento em que o visitante cria a intenção de compra, com atraso programado de 30 minutos.
* **Verificação de Estado:** Ao despertar, o worker consulta o banco de dados. Se o status do usuário não for mais `PENDING` (ou seja, se a compra já foi aprovada), o job é descartado sem disparar e-mails de recuperação desnecessários.

### C. Worker de Reconciliação do Mercado Pago
* **Execução Agendada (Cron):** Processo periódico que roda a cada 10 minutos consultando as APIs de busca do Mercado Pago para ativar pagamentos via PIX ou Cartão que possam ter sofrido atrasos na entrega de webhooks.

---

## 2. Rate Limiting Distribuído (Algoritmo de Janela Deslizante)

Mecanismos de rate limit em memória (`Map` ou token bucket local) falham em ambientes com múltiplos containers. O zapost implementa um contador atômico de janela deslizante utilizando **Sorted Sets no Redis**:

```
Tempo (ms):       t - windowMs                agora (now)
                       │                          │
                       ▼                          ▼
Scores no Sorted Set: [ ●      ●      ●      ●    ● ]
                       ▲
                       │
             ZREMRANGEBYSCORE: descarta timestamps anteriores a (now - windowMs)
             ZCARD: contabiliza eventos válidos na janela ativa
```

### Funcionamento do Algoritmo
1. `ZREMRANGEBYSCORE`: Remove registros com timestamp inferior ao início da janela atual.
2. `ZCARD`: Conta o número de requisições ativas dentro da janela.
3. Se a contagem ultrapassar o limite, lê o evento mais antigo via `ZRANGE` para calcular o valor exato do header `Retry-After`.
4. Se estiver dentro do limite, insere a requisição atual via `ZADD` e renova o TTL via `PEXPIRE` em um pipeline atômico.

---

## 3. Semáforo Distribuído de Concorrência

Para ações síncronas que não podem ser enfileiradas (como regeração de legendas em tempo real solicitada pelo usuário no editor), o sistema previne a exaustão de cotas de API dos provedores de IA através de um semáforo distribuído:

```typescript
export async function acquireConcurrencySlot(
  key: string,
  maxConcurrency: number,
  ttlMs: number = 60_000
): Promise<ConcurrencyResult> {
  const current = await redis.incr(key);

  if (current === 1) {
    await redis.pexpire(key, ttlMs);
  }

  if (current > maxConcurrency) {
    await redis.decr(key);
    return { acquired: false };
  }

  const release = async () => {
    await redis.decr(key);
  };

  return { acquired: true, release };
}
```

Caso o limite de concorrência global seja atingido, a API retorna imediatamente `HTTP 429 Too Many Requests` com cabeçalho `Retry-After: 5`, protegendo a infraestrutura de forma elegante e transparente.
