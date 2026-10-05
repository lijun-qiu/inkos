import { getModel } from "@mariozechner/pi-ai";
import type { Model, Api } from "@mariozechner/pi-ai";
import { resolveServicePiProvider, resolveServicePreset } from "./service-presets.js";
import { getServiceApiKey } from "./secrets.js";
import { getEndpoint } from "./providers/index.js";
import type { InkosEndpoint } from "./providers/types.js";
import { isApiKeyOptionalForEndpoint } from "../utils/llm-endpoint-auth.js";

export interface ResolvedModel {
  model: Model<Api>;
  apiKey: string;
  writingTemperature?: number;
  temperatureRange?: readonly [number, number];
  temperatureHint?: string;
}

function resolveProviderCompat(
  provider: InkosEndpoint | undefined,
  baseUrl: string,
): Record<string, unknown> | undefined {
  const compat = {
    ...(provider?.compat ?? {}),
    ...(baseUrl.includes("generativelanguage.googleapis.com") ? { supportsStore: false } : {}),
  };
  return Object.keys(compat).length > 0 ? compat : undefined;
}

export async function resolveServiceModel(
  service: string,
  modelId: string,
  projectRoot: string,
  customBaseUrl?: string,
  customApiFormat?: "chat" | "responses",
): Promise<ResolvedModel> {
  // Determine pi-ai provider
  const baseService = service.startsWith("custom:") ? "custom" : service;
  const preset = resolveServicePreset(baseService);
  const endpoint = getEndpoint(baseService);
  const piProvider = baseService === "ollama" ? "ollama" : resolveServicePiProvider(baseService) ?? "openai";
  // Prefer explicit per-service apiFormat (e.g. openrouter chat → openai-completions)
  // over the endpoint preset default (openrouter bank still lists openai-responses).
  const apiType = customApiFormat
    ? (customApiFormat === "responses" ? "openai-responses" : "openai-completions")
    : service.startsWith("custom:")
      ? "openai-completions"
      : (preset?.api ?? "openai-completions");
  const configuredBaseUrl = customBaseUrl ?? preset?.baseUrl ?? "";
  const endpointModel = endpoint?.models.find(
    (model) => model.id === modelId || model.deploymentName === modelId,
  );

  // Get pi-ai Model — may return undefined for model IDs not in the built-in registry
  const piModel = getModel(piProvider as any, modelId as any) as Model<Api> | undefined;
  const effectiveBaseUrl = configuredBaseUrl || piModel?.baseUrl || "";
  const baseCompat = apiType === "openai-completions"
    ? resolveProviderCompat(endpoint, effectiveBaseUrl)
    : undefined;
  // 多数 OpenAI 兼容中转不接受 developer role；pi-ai 在 reasoning=true 时会改 role。
  const compat = baseService === "custom"
    ? { ...(baseCompat ?? {}), supportsDeveloperRole: false }
    : baseCompat;

  if (!effectiveBaseUrl) {
    throw new Error(
      `Cannot resolve model "${modelId}" for service "${service}": no baseUrl available.`,
    );
  }

  // Resolve API key after baseUrl/provider are known so local/self-hosted endpoints
  // such as Ollama can be used without forcing a fake secret.
  const apiKey = await getServiceApiKey(projectRoot, service);
  const apiKeyOptional = isApiKeyOptionalForEndpoint({
    provider: preset?.providerFamily,
    baseUrl: effectiveBaseUrl,
  });
  if (!apiKey && !apiKeyOptional) {
    throw new Error(
      `API key not found for service "${service}". Add it in .inkos/secrets.json or set the environment variable.`,
    );
  }

  const contextWindow = endpointModel?.contextWindowTokens
    ?? piModel?.contextWindow
    ?? 128_000;
  const maxTokens = endpointModel?.maxOutput ?? piModel?.maxTokens ?? 16_384;
  // Remaining room is enforced per call by fitMaxTokensToContextWindow.

  const model: Model<Api> = {
    id: endpointModel?.deploymentName ?? modelId,
    name: piModel?.name ?? modelId,
    api: apiType as Api,
    provider: piProvider,
    baseUrl: effectiveBaseUrl,
    // 自定义中转不要继承 pi-ai 内置卡的 reasoning 标志，避免 system→developer 触发 400。
    reasoning: baseService === "custom" ? false : (piModel?.reasoning ?? false),
    input: piModel?.input ?? ["text"] as ("text" | "image")[],
    cost: piModel?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
    ...(compat ? { compat: compat as Model<Api>["compat"] } : {}),
  };

  return {
    model,
    // pi-ai agent runtime rejects empty apiKey even for local Ollama.
    // A local placeholder keeps Chat working; InkOS native transport also
    // treats these placeholders as "no real key".
    apiKey: apiKey || (apiKeyOptional ? "ollama" : ""),
    writingTemperature: preset?.writingTemperature,
    temperatureRange: preset?.temperatureRange,
    temperatureHint: preset?.temperatureHint,
  };
}
