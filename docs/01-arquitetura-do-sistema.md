# 01 — Arquitetura do Sistema & Multi-Tenancy

## Paradigma Arquitetural

O zapost foi projetado como um **monólito modular** otimizado para deploy em containers coordenados. Ele utiliza o **Next.js 16 App Router** com React Server Components (RSC) para apresentação e Route Handlers RESTful para mutações de API, combinados com um processo worker dedicado que consome tarefas de background via **BullMQ e Redis**.

```
                           ┌─────────────────────────────────┐
                           │          Ingresso Nginx         │
                           └────────────────┬────────────────┘
                                            │
                    ┌───────────────────────┴───────────────────────┐
                    ▼                                               ▼
     ┌─────────────────────────────┐                 ┌─────────────────────────────┐
     │      Servidor Next.js       │                 │   Processo Worker Dedicado  │
     │   (Porta 3000 / Standalone) │                 │    (Node 22 + runtime tsx)  │
     └──────────────┬──────────────┘                 └──────────────┬──────────────┘
                    │                                               │
                    │         ┌───────────────────────────┐         │
                    ├────────►│     PostgreSQL 16 DB      │◄────────┤
                    │         └───────────────────────────┘         │
                    │                                               │
                    │         ┌───────────────────────────┐         │
                    └────────►│       Redis 7 Cache       │◄────────┘
                              │  (Filas, Locks, Limites)  │
                              └───────────────────────────┘
```

---

## 1. Modelo de Isolamento Multi-Tenant

O isolamento entre tenants é garantido de forma estrita no nível de modelagem do banco de dados relacional. Cada conta de usuário pertence a um contexto isolado de `Tenant`.

### Escopo no Esquema do Banco
Todas as entidades centrais no PostgreSQL possuem chave estrangeira não-nula apontando para a tabela `Tenant`:

```prisma
model Post {
  id             String        @id @default(cuid())
  tenantId       String
  userId         String
  name           String
  canvasSnapshot Json
  format         String        @default("feed")
  
  tenant         Tenant        @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  user           User          @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([tenantId, updatedAt])
  @@map("posts")
}
```

### Regras Invioláveis de Segurança
1. **Contexto Derivado no Servidor:** O `tenantId` nunca é recebido ou confiado a partir de URLs, query parameters ou corpo da requisição. Ele é extraído exclusivamente da sessão criptografada no servidor via `session.user.tenantId`.
2. **Escopo Obrigatório em Queries:** Nenhuma consulta de dados mutadora ou de leitura pode acessar entidades sem filtrar pelo identificador de tenant:
   ```typescript
   // Padrão correto e obrigatório:
   const post = await prisma.post.findFirst({
     where: { id: postId, tenantId: session.user.tenantId }
   });
   ```
3. **Exclusão em Cascata Segura:** Uma deleção na raiz do `Tenant` aciona a remoção em cascata de todos os posts associados, mídias enviadas ao storage, assinaturas e logs, sem deixar registros órfãos.

---

## 2. Pipeline Padronizado de Mutação de APIs

Para blindar o sistema contra desvios de autorização, injeção de dados inválidos e ataques de CSRF, todas as rotas de mutação (`POST`, `PATCH`, `DELETE`) obedecem a um pipeline uniforme de 4 etapas:

```
[Requisição HTTP de Entrada]
          │
          ▼
   1. Validação CSRF     ──► Falha? ──► HTTP 403 Forbidden (Origem não confiável)
          │
          ▼
   2. Sessão & Auth      ──► Ausente? ─► HTTP 401 Unauthorized (Sem sessão válida)
          │
          ▼
   3. Validação Zod      ──► Inválido? ─► HTTP 400 Bad Request (Detalhes do erro)
          │
          ▼
   4. Banco com Tenant   ──► Executa operação filtrada estritamente por session.user.tenantId
```

---

## 3. Otimização de Build Next.js Standalone

A aplicação gera um artefato de produção ultra-leve através da flag `output: "standalone"` no `next.config.ts`.

* **Rastreamento Automático de Dependências:** O Next.js analisa a árvore de imports e copia para `.next/standalone` estritamente os pacotes de `node_modules` necessários em runtime.
* **Pegada Mínima:** A imagem final em Alpine Linux pesa menos de 150MB, descartando dependências de desenvolvimento (`devDependencies`) e scripts de build.
* **Separação de Papéis em Runtime:** O container web principal inicia o servidor via `node server.js`, enquanto o container worker reaproveita a mesma base para executar `src/workers/index.ts` via `tsx`.
