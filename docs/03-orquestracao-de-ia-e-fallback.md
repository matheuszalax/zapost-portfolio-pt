# 03 — Resiliência de IA em 4 Camadas & Aterramento Web

## Orquestração Resiliente de Modelos de Linguagem

Provedores públicos de IA estão sujeitos a indisponibilidades, picos de latência, rate limits agressivos e variações no formato de resposta.

O zapost implementa um motor de contingência em cascata de **4 camadas**, orquestrado via **OpenRouter**, garantindo que as solicitações de geração de carrosséis e posts sejam atendidas com sucesso mesmo durante falhas severas de fornecedores individuais.

```
                  ┌──────────────────────────────┐
                  │ Briefing / Criação de Post   │
                  └──────────────┬───────────────┘
                                 │
                     Heurística: Tema factual/notícia?
                                 ├──────────────────────┐
                                 │ Sim                  │ Não
                                 ▼                      │
                     ┌───────────────────────┐          │
                     │  Busca Web Tavily AI  │          │
                     │  (Extrai 5 Fontes     │          │
                     │   e Citações Reais)   │          │
                     └───────────┬───────────┘          │
                                 │                      │
                                 ▼                      ▼
                    ┌────────────────────────────────────────┐
                    │ Prompt Enriquecido com Identidade      │
                    └───────────────────┬────────────────────┘
                                        │
                 ┌──────────────────────┴──────────────────────┐
                 ▼ Camada 1                                    │
   ┌───────────────────────────┐                               │
   │  openai/gpt-4o-mini       ├─► Sucesso? ──► Retorna Dados  │
   └─────────────┬─────────────┘                               │
                 │ Falha Transitória / Rate Limit              │
                 ▼ Camada 2                                    │
   ┌───────────────────────────┐                               │
   │  openai/gpt-4o-mini Retry ├─► Sucesso? ──► Retorna Dados  │
   └─────────────┬─────────────┘                               │
                 │ Falha Novamente                             │
                 ▼ Camada 3                                    │
   ┌───────────────────────────┐                               │
   │  google/gemini-2.0-flash  ├─► Sucesso? ──► Retorna Dados  │
   └─────────────┬─────────────┘                               │
                 │ Falha / Filtro de Conteúdo                  │
                 ▼ Camada 4                                    │
   ┌───────────────────────────┐                               │
   │  anthropic/claude-3.5-hku ├─► Sucesso? ──► Retorna Dados  │
   └─────────────┬─────────────┘                               │
                 │ Esgotado                                    │
                 ▼                                             │
      Dispara Alerta Vermelho Sentry + Discord                 ▼
```

---

## 1. Motor de Fallback em Cascata

Ao invocar `callWithFallback()`, o sistema classifica os erros em duas categorias:
1. **Erros Fatais / Configuração:** (`401 Unauthorized`, `400 Bad Request`, `ContentPolicyViolation`). Nesses cenários, a execução é interrompida imediatamente, pois trocar de modelo não corrigirá uma chave inválida ou violação explícita de política.
2. **Erros Transitórios do Provedor:** (`429 Rate Limit`, `502 Bad Gateway`, `504 Gateway Timeout`, desconexão de rede ou resposta JSON fora do schema). Nesses casos, o motor avança silenciosa e automaticamente para o próximo modelo da esteira.

### Telemetria e Auditoria
Cada requisição gera um registro detalhado na tabela `PostGenerationLog`:
* `durationMs`: Tempo total decorrido através de todas as camadas.
* `provider` e `model`: O modelo exato que resolveu a geração.
* `attempts`: Um log em JSON detalhando as tentativas de cada camada, latência de cada etapa e erros encontrados.
* `hasWebSearch`: Booleano informando se a busca Tavily foi acionada.

---

## 2. Aterramento Web em Tempo Real com Tavily

Modelos de linguagem possuem data de corte de conhecimento (*knowledge cutoff*) e frequentemente alucinam dados sobre notícias recentes, eventos esportivos, lançamentos e cotações.

O zapost utiliza uma heurística de detecção (`shouldUseWebSearch`):
* Analisa termos como *lançamento*, *polêmica*, *notícia*, *atualização*, *resultado*, *tendência*.
* Faz uma requisição assíncrona para a **Tavily Search API** com `search_depth: "basic"` e `max_results: 5`.
* Formata e sintetiza as fontes verificadas em um bloco de contexto objetivo injetado diretamente no prompt de sistema:

```text
CONTEXTO FACTUAL OBTIDO NA WEB EM TEMPO REAL:
Resumo: ...
Fontes verificadas:
- [Fonte 1] https://...: conteúdo relevante
- [Fonte 2] https://...: conteúdo relevante
```

Caso a Tavily apresente lentidão ou indisponibilidade, a falha é tolerada com um aviso em log e a geração continua normalmente sem bloquear o usuário.

---

## 3. Scraping de Identidade de Marca com Apify

Durante o onboarding guiado, o sistema utiliza **Atores da Apify** para raspar perfis públicos do Instagram:
* Faz o download do avatar do perfil e o transfere para o bucket **Cloudflare R2**, eliminando problemas de CORS ou bloqueios por hotlinking externo.
* Extrai a biografia e as legendas dos últimos 15 posts publicados.
* Um modelo de IA sintetiza o público-alvo, tom de voz, dores dos clientes e pilares de conteúdo, salvando tudo em um registro `BrandProfile` reutilizável em criações futuras.
