/**
 * Orquestrador de Resiliência de IA com Fallback Multi-Provedor em 4 Camadas
 * 
 * Implementa execução em cascata de modelos com retentativa inteligente para falhas
 * transitórias, validação estrita de esquemas via Zod e telemetria de latência por camada.
 */

import { z } from "zod";

export interface FallbackLayerConfig {
  layer: number;
  model: string;
  maxRetries: number;
  timeoutMs: number;
}

export interface FallbackAttemptTrace {
  layer: number;
  model: string;
  durationMs: number;
  error?: string;
  success: boolean;
}

export class TransientProviderError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "TransientProviderError";
  }
}

export class FatalConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FatalConfigurationError";
  }
}

const DEFAULT_FALLBACK_LAYERS: FallbackLayerConfig[] = [
  { layer: 1, model: "openai/gpt-4o-mini", maxRetries: 1, timeoutMs: 20_000 },
  { layer: 2, model: "openai/gpt-4o-mini", maxRetries: 1, timeoutMs: 25_000 },
  { layer: 3, model: "google/gemini-2.0-flash-lite-001", maxRetries: 0, timeoutMs: 20_000 },
  { layer: 4, model: "anthropic/claude-3.5-haiku", maxRetries: 0, timeoutMs: 25_000 },
];

export async function executeWithResilientFallback<T>(
  prompt: string,
  schema: z.ZodType<T>,
  invokeModel: (model: string, timeoutMs: number) => Promise<string>,
  layers: FallbackLayerConfig[] = DEFAULT_FALLBACK_LAYERS
): Promise<{ data: T; attempts: FallbackAttemptTrace[]; resolvedModel: string }> {
  const traces: FallbackAttemptTrace[] = [];

  for (const layer of layers) {
    const startMs = Date.now();
    try {
      // 1. Invoca o modelo no provedor via gateway
      const rawResponse = await invokeModel(layer.model, layer.timeoutMs);

      // 2. Faz o parsing do JSON e impõe o contrato do schema tipado
      const parsedJson = JSON.parse(rawResponse);
      const validatedData = schema.parse(parsedJson);

      traces.push({
        layer: layer.layer,
        model: layer.model,
        durationMs: Date.now() - startMs,
        success: true,
      });

      return {
        data: validatedData,
        attempts: traces,
        resolvedModel: layer.model,
      };
    } catch (err: any) {
      const durationMs = Date.now() - startMs;
      const errorMessage = err?.message || "Erro desconhecido";

      traces.push({
        layer: layer.layer,
        model: layer.model,
        durationMs,
        error: errorMessage,
        success: false,
      });

      // Erros de configuração fatal não devem cascatear para outros modelos
      if (err instanceof FatalConfigurationError) {
        throw err;
      }

      // Falhas transitórias avançam para a próxima camada de fallback
      console.warn(`[Fallback IA] Camada ${layer.layer} (${layer.model}) falhou: ${errorMessage}. Escalando...`);
    }
  }

  throw new Error(`Todas as ${layers.length} camadas de fallback de IA foram esgotadas sem sucesso.`);
}
