/**
 * OpenRouter
 *
 * - 官网：https://openrouter.ai/
 * - 免费模型广场：https://openrouter.ai/models?q=free
 * - 控制台 / API key：https://openrouter.ai/keys
 * - API 文档：https://openrouter.ai/docs/api-reference/overview
 * - 模型列表 JSON：https://openrouter.ai/api/v1/models
 *
 * 本项目 OpenRouter 仅保留免费文本聊天模型（:free 或官方 $0 文本档）。
 * 完整清单仍可通过 live /models probe 拉取后过滤。
 */
import type { InkosEndpoint } from "../types.js";

const OPENROUTER_FREE_BLOCKLIST = [
  "content-safety",
  "lyria",
];

/** Official $0 text-chat models that are not suffixed with :free. */
const OPENROUTER_ZERO_PRICE_TEXT_IDS = new Set([
  "inclusionai/ling-3.1-flash",
]);

export function isOpenRouterFreeModel(modelId: string): boolean {
  const id = modelId.trim().toLowerCase();
  if (!id) return false;
  if (id === "openrouter/free") return false;
  if (OPENROUTER_FREE_BLOCKLIST.some((part) => id.includes(part))) return false;
  if (id.endsWith(":free")) return true;
  return OPENROUTER_ZERO_PRICE_TEXT_IDS.has(id);
}

export const OPENROUTER: InkosEndpoint = {
  id: "openrouter",
  label: "OpenRouter 代理",
  group: "aggregator",
  api: "openai-responses",
  baseUrl: "https://openrouter.ai/api/v1",
  checkModel: "poolside/laguna-s-2.1:free",
  temperatureRange: [0, 2],
  defaultTemperature: 0.7,
  writingTemperature: 1,
  // Synced from https://openrouter.ai/api/v1/models (q=free, text-chat only).
  models: [
    { id: "inclusionai/ling-3.1-flash", maxOutput: 32768, contextWindowTokens: 262144, enabled: true, releasedAt: "2026-10-02" },
    { id: "apodex/apodex-1.1-mini:free", maxOutput: 65536, contextWindowTokens: 262144, enabled: true, releasedAt: "2026-10-01" },
    { id: "inclusionai/ling-3.0-flash-sante:free", maxOutput: 32768, contextWindowTokens: 262144, enabled: true },
    { id: "qwen/qwen3.8-27b:free", maxOutput: 65536, contextWindowTokens: 262144, enabled: true },
    { id: "dots-studio/dots-3-note-preview:free", maxOutput: 65536, contextWindowTokens: 512000, enabled: true },
    { id: "liquid/lfm-2.5-2.6b:free", maxOutput: 8192, contextWindowTokens: 65536, enabled: true },
    { id: "nvidia/nemotron-3.5-lightning:free", maxOutput: 65536, contextWindowTokens: 1000000, enabled: true },
    { id: "thinkingmachines/inkling-small:free", maxOutput: 65536, contextWindowTokens: 1048576, enabled: true },
    {
      id: "poolside/laguna-s-2.1:free",
      maxOutput: 32768,
      contextWindowTokens: 262144,
      enabled: true,
      releasedAt: "2026-07-21",
      capabilities: { text: true, tools: true, reasoning: true },
    },
    { id: "thinkingmachines/inkling:free", maxOutput: 65536, contextWindowTokens: 1048576, enabled: true },
    { id: "poolside/laguna-xs-2.1:free", maxOutput: 32768, contextWindowTokens: 262144, enabled: true },
    { id: "cohere/north-mini-code:free", maxOutput: 64000, contextWindowTokens: 256000, enabled: true },
    { id: "nvidia/nemotron-3-ultra-550b-a55b:free", maxOutput: 65536, contextWindowTokens: 1000000, enabled: true, releasedAt: "2026-04-01" },
    { id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", maxOutput: 65536, contextWindowTokens: 256000, enabled: true },
    { id: "google/gemma-4-26b-a4b-it:free", maxOutput: 32768, contextWindowTokens: 262144, enabled: true },
    { id: "google/gemma-4-31b-it:free", maxOutput: 32768, contextWindowTokens: 262144, enabled: true },
    { id: "nvidia/nemotron-3-super-120b-a12b:free", maxOutput: 65536, contextWindowTokens: 262144, enabled: true, releasedAt: "2026-03-11" },
  ],
};
