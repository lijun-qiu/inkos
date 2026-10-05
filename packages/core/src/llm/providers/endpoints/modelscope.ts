/**
 * ModelScope (魔搭)
 *
 * - 官网：https://www.modelscope.cn/
 * - 控制台 / API key：https://www.modelscope.cn/my/myaccesstoken
 * - API 文档：https://www.modelscope.cn/docs/model-service/API-Inference/intro
 *
 * 默认走本机 key 注入代理（与 ArcReel / openrouter-proxy-injector 约定一致）：
 * - Base URL：http://127.0.0.1:10001（无 /v1，直接 /chat/completions）
 * - 客户端 Key：modelscope_proxy_api_key
 * - 真实 ms-* Key 配在代理侧 .env.modelscope，由代理注入/轮换
 *
 * 应用侧模型 ID 带 `modelscope/` 前缀，与官方 DeepSeek / kkaiapi 的同名模型区分；
 * API 实际 model 字段走 deploymentName（deepseek-ai/...）。
 */
import type { InkosEndpoint } from "../types.js";

/** Local ModelScope key-injector proxy (openrouter-proxy-injector). */
export const MODELSCOPE_LOCAL_PROXY_BASE_URL = "http://127.0.0.1:10001";
export const MODELSCOPE_PROXY_API_KEY = "modelscope_proxy_api_key";
/** Official OpenAI-compatible entry; only used when intentionally bypassing the proxy. */
export const MODELSCOPE_API_BASE_URL = "https://api-inference.modelscope.cn/v1";

export const MODELSCOPE: InkosEndpoint = {
  id: "modelscope",
  label: "魔塔代理",
  group: "aggregator",
  api: "openai-completions",
  baseUrl: MODELSCOPE_LOCAL_PROXY_BASE_URL,
  checkModel: "modelscope/deepseek-v4-flash",
  temperatureRange: [0, 2],
  defaultTemperature: 0.7,
  writingTemperature: 1,
  models: [
    {
      id: "modelscope/deepseek-v4-flash",
      deploymentName: "deepseek-ai/DeepSeek-V4-Flash-0731",
      // Align with V4 long-output scripts (~20万字); oversized calls may still 429 on free tier.
      maxOutput: 200_000,
      contextWindowTokens: 1_000_000,
      enabled: true,
      releasedAt: "2026-04-24",
    },
    {
      id: "modelscope/deepseek-v4-pro",
      deploymentName: "deepseek-ai/DeepSeek-V4-Pro",
      maxOutput: 200_000,
      contextWindowTokens: 1_000_000,
      enabled: true,
      releasedAt: "2026-04-24",
    },
  ],
};
