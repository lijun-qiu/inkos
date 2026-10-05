/**
 * Agnes AI
 *
 * - 官网：https://agnes-ai.com/
 * - 国内站：https://agnes-ai.cn/
 * - API 平台：https://platform.agnes-ai.com/
 * - API 文档：https://agnes-ai.com/doc/overview
 * - Base URL：https://apihub.agnes-ai.com/v1
 */
import type { InkosEndpoint } from "../types.js";

export const AGNES: InkosEndpoint = {
  id: "agnes",
  label: "Agnes AI",
  group: "china",
  api: "openai-completions",
  baseUrl: "https://apihub.agnes-ai.com/v1",
  checkModel: "agnes-3.0-flash",
  temperatureRange: [0, 2],
  defaultTemperature: 0.7,
  writingTemperature: 1,
  models: [
    {
      id: "agnes-3.0-flash",
      maxOutput: 65_536,
      contextWindowTokens: 524_288,
      enabled: true,
      releasedAt: "2026-09-01",
    },
    {
      id: "agnes-2.5-flash",
      maxOutput: 65_536,
      contextWindowTokens: 524_288,
      enabled: true,
      releasedAt: "2026-01-01",
    },
    {
      id: "agnes-2.0-flash",
      maxOutput: 65_536,
      contextWindowTokens: 262_144,
      enabled: true,
    },
    {
      id: "agnes-1.5-flash",
      maxOutput: 65_536,
      contextWindowTokens: 262_144,
      enabled: true,
    },
  ],
};
