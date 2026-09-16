# 05 — Segurança Defensiva, SSRF & Autenticação

## Engenharia com Foco em Segurança

O zapost foi concebido sob princípios de segurança ofensiva e defensiva (OWASP Top 10), garantindo isolamento de dados de clientes, blindagem contra ataques de rede e conformidade corporativa.

---

## 1. Defesa contra SSRF & Fixação de DNS (DNS Pinning)

URLs externas de bancos de imagens (Unsplash, Pexels, DuckDuckGo ou uploads de usuários) precisam passar por um proxy interno no servidor para satisfazer restrições de CORS no navegador. Sem proteções, um proxy de imagens permite que invasores façam varreduras de rede interna ou acessem credenciais de instâncias cloud.

O zapost implementa um validador rigoroso em `src/lib/http/ssrf.ts`:

### Mecanismos de Proteção:
1. **Restrição de Protocolo:** Aceita unicamente esquemas explícitos `http:` e `https:`.
2. **Bloqueio de Redes Privadas:** Rejeita `localhost`, hostnames sem ponto, IPv6 loopback (`::1`), endereços link-local e todas as faixas privadas da RFC 1918:
   * `10.0.0.0/8`
   * `172.16.0.0/12`
   * `192.168.0.0/16`
   * `127.0.0.0/8`
   * `169.254.0.0/16` (Endpoints de metadados da AWS/GCP como `169.254.169.254`)
3. **Fixação de DNS (DNS Pinning):** Realiza a resolução prévia de endereços IPv4 (`A`) e IPv6 (`AAAA`) antes de enviar o tráfego HTTP. Se **qualquer** IP resolvido pertencer a uma faixa privada, a requisição é bloqueada, impedindo ataques de *DNS Rebinding*.

---

## 2. Content Security Policy (CSP) & Cabeçalhos HTTP

Configurados diretamente no `next.config.ts`, os cabeçalhos de segurança são injetados em todas as respostas HTTP do servidor:

```typescript
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com https://accounts.google.com",
      "style-src 'self' 'unsafe-inline' https://accounts.google.com",
      "img-src 'self' data: blob: https:",
      "font-src 'self'",
      "connect-src 'self' https://accounts.google.com blob: https:",
      "frame-src 'self' https://accounts.google.com",
      "frame-ancestors 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; ")
  }
];
```

---

## 3. Autenticação & Proteção Criptográfica

A plataforma oferece login social unificado (Google OAuth 2.0 com Google Identity Services / One Tap via FedCM) e autenticação local por e-mail e senha:

* **Hash de Senhas:** Utiliza `bcryptjs` com fator de custo de **12 rounds**, tornando ataques de dicionário e força bruta inviáveis computacionalmente.
* **Complexidade Mínima:** Validação via Zod exigindo ao menos 8 caracteres contendo letras e números.
* **Bloqueio por Força Bruta:** 5 tentativas incorretas consecutivas bloqueiam temporariamente a conta por 15 minutos (`lockedUntil`).
* **Proteção contra Timing Attacks:** Respostas de erro padronizadas impedem enumeração de contas. Quando um e-mail inexistente tenta login, uma verificação simulada de senha é executada para equalizar o tempo de resposta da CPU.
* **Tokens Seguros:** Tokens de redefinição de senha são gerados com 32 bytes aleatórios criptográficos (`crypto.randomBytes(32)`). Apenas o hash SHA-256 é armazenado no banco, com expiração em 1 hora e consumo de uso único.

---

## 4. Auditoria Imutável

Todas as ações sensíveis realizadas por administradores geram registros permanentes na tabela `AuditLog`:

```prisma
model AuditLog {
  id         String      @id @default(cuid())
  adminId    String?
  action     AuditAction // USER_BLOCKED, PLAN_UPDATED, CREDIT_ADDED, USER_IMPERSONATED, etc.
  targetType String
  targetId   String
  metadata   Json?
  createdAt  DateTime    @default(now())

  @@index([adminId])
  @@index([targetId])
  @@index([action])
  @@map("audit_logs")
}
```

Essa tabela não permite exclusão ou alteração via API, assegurando conformidade e rastreabilidade total de impersonações de suporte, concessões de crédito e alterações de planos.
