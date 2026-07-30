import type { LLMConfig } from "../models/project.js";
import {
  streamSimple as piStreamSimple,
  completeSimple as piCompleteSimple,
} from "@mariozechner/pi-ai";
import type {
  Api as PiApi,
  Model as PiModel,
  Context as PiContext,
  AssistantMessageEvent,
} from "@mariozechner/pi-ai";
import { resolveServicePreset } from "./service-presets.js";
import { getEndpoint } from "./providers/index.js";
import { lookupModel } from "./providers/lookup.js";
import { fetchWithProxy } from "../utils/proxy-fetch.js";
import { isApiKeyOptionalForEndpoint } from "../utils/llm-endpoint-auth.js";
import { isLlmStubEnabled, stubChatCompletion } from "../agent/llm-stub.js";
import { createLeadingThinkTagStripper, stripLeadingThinkBlock } from "./think-tag-stripper.js";


// === Streaming Monitor Types ===

export interface StreamProgress {
  readonly elapsedMs: number;
  readonly totalChars: number;
  readonly chineseChars: number;
  readonly status: "thinking" | "streaming" | "done";
}

export type OnStreamProgress = (progress: StreamProgress) => void;
export type OnThinkingDelta = (text: string) => void;

const INKOS_USER_AGENT = "InkOS/1.3.5";
const UNKNOWN_MODEL_FALLBACK_MAX_TOKENS = 8192 * 3;
/** Extra attempts after the first failure for generic transient HTTP/transport errors. */
const TRANSIENT_LLM_RETRIES = 2;
/**
 * Extra attempts after the first failure for mid-stream PartialResponseError
 * (full rewrite). Free OpenRouter routes often drop long Ultra streams.
 */
const PARTIAL_RESPONSE_LLM_RETRIES = 3;
/** Backoff before each stream-rewrite attempt (ms): 1s → 3s → 10s. */
const PARTIAL_RESPONSE_BACKOFF_MS = [1_000, 3_000, 10_000] as const;
/**
 * Extra attempts after the first failure for rate-limit (429) errors.
 * Sized to cover ~1–2 full free-Flash rotations plus long backoff.
 */
const RATE_LIMIT_LLM_RETRIES = 6;
/** Backoff after a full model-rotation cycle (ms): 1min → 2min → 3min. */
const RATE_LIMIT_BACKOFF_MS = [60_000, 120_000, 180_000] as const;
/** Short pause when hopping to the next Zhipu free Flash model on 429. */
const RATE_LIMIT_MODEL_ROTATE_DELAY_MS = 8_000;
/**
 * Kept for tests/call sites. Rotation is intentionally disabled: a 429 must not
 * silently switch to a weaker free Flash model (short chapters / quality drop).
 * Callers stay on the configured primary until retries exhaust, then fail hard.
 */
export const ZHIPU_FREE_FLASH_ROTATION = [
  "glm-4-flash",
  "glm-4-flash-250414",
  "glm-4.6v-flash",
] as const;
/** Practical Ollama context for writing agents; full model cards may claim 128k+. */
const OLLAMA_DEFAULT_NUM_CTX = 32_768;

/** No cross-model hop — always the configured primary only. */
export function buildZhipuRateLimitModelRotation(primary: string): string[] {
  return [primary];
}

function isByteString(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) > 255) return false;
  }
  return true;
}

function isValidHeaderName(value: string): boolean {
  return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(value);
}

function sanitizeHttpHeaders(headers?: Record<string, string>): Record<string, string> | undefined {
  if (!headers) return undefined;
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!isValidHeaderName(key)) continue;
    if (!isByteString(value)) continue;
    sanitized[key] = value;
  }
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function mergeUserAgent(headers?: Record<string, string>): Record<string, string> {
  return { "User-Agent": INKOS_USER_AGENT, ...(sanitizeHttpHeaders(headers) ?? {}) };
}

export function createStreamMonitor(
  onProgress?: OnStreamProgress,
  intervalMs: number = 30000,
): {
  readonly onChunk: (text: string, kind?: "text" | "thinking") => void;
  readonly stop: () => void;
} {
  let totalChars = 0;
  let chineseChars = 0;
  let phase: "thinking" | "streaming" = "streaming";
  const startTime = Date.now();
  let timer: ReturnType<typeof setInterval> | undefined;

  if (onProgress) {
    timer = setInterval(() => {
      onProgress({
        elapsedMs: Date.now() - startTime,
        totalChars,
        chineseChars,
        status: phase,
      });
    }, intervalMs);
  }

  return {
    onChunk(text: string, kind: "text" | "thinking" = "text"): void {
      phase = kind === "thinking" ? "thinking" : "streaming";
      totalChars += text.length;
      chineseChars += (text.match(/[\u4e00-\u9fff]/g) || []).length;
      if (kind === "thinking") {
        // Emit promptly so Studio can show "思考中" without waiting for the interval.
        onProgress?.({
          elapsedMs: Date.now() - startTime,
          totalChars,
          chineseChars,
          status: "thinking",
        });
      }
    },
    stop(): void {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      onProgress?.({
        elapsedMs: Date.now() - startTime,
        totalChars,
        chineseChars,
        status: "done",
      });
    },
  };
}

// === Shared Types ===

export interface LLMResponse {
  readonly content: string;
  readonly usage: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
  };
}

export interface LLMMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface LLMClient {
  readonly provider: "openai" | "anthropic";
  readonly service?: string;
  readonly configSource?: LLMConfig["configSource"];
  readonly apiFormat: "chat" | "responses";
  readonly stream: boolean;
  readonly proxyUrl?: string;
  readonly _piModel?: PiModel<PiApi>;
  readonly _apiKey?: string;
  readonly defaults: {
    readonly temperature: number;
    /**
     * Per-call fallback: 当 agent 调 chat() 不传 options.maxTokens 时用这个值。
     * 命中模型卡时来自 providers bank 的 modelCard.maxOutput；未知模型走写作兜底预算。
     */
    readonly maxTokens: number;
    /**
     * Legacy mock compatibility only. v2 provider resolution no longer caps
     * per-call maxTokens from project config; model max output comes from the
     * provider bank.
     */
    readonly maxTokensCap?: number | null;
    readonly thinkingBudget: number;
    readonly extra: Record<string, unknown>;
  };
}

// === Factory ===

export function createLLMClient(config: LLMConfig): LLMClient {
  // C1 (v2.0.0)：config.maxTokens / maxTokensCap 已删除；defaults.maxTokens 完全从 modelCard 推导。
  const _earlyCard = lookupModel(config.service ?? "custom", config.model);
  const _earlyMax = _earlyCard?.maxOutput ?? UNKNOWN_MODEL_FALLBACK_MAX_TOKENS;
  const defaults = {
    temperature: config.temperature ?? 0.7,
    maxTokens: _earlyMax,
    thinkingBudget: config.thinkingBudget ?? 0,
    extra: config.extra ?? {},
  };

  const apiFormat = config.apiFormat ?? "chat";
  const stream = config.stream ?? true;

  // --- Build pi-ai Model object ---
  const serviceName = config.service ?? "custom";
  const preset = resolveServicePreset(serviceName);
  const inkosProvider = getEndpoint(serviceName);
  const modelCard = lookupModel(serviceName, config.model);

  const piApiRaw = resolvePiApi(serviceName, config.apiFormat, (inkosProvider?.api ?? preset?.api) as PiApi) as PiApi;
  let baseUrl = config.baseUrl || inkosProvider?.baseUrl || preset?.baseUrl || "";
  const extraHeaders = sanitizeHttpHeaders(config.headers ?? parseEnvHeaders());
  // Prefer Google OpenAI-compatible endpoint when a proxy is configured (or the
  // caller already pointed at /openai). Native google-generative-ai goes through
  // pi-ai's own fetch and ignores INKOS_LLM_PROXY_URL / undici ProxyAgent.
  const googleOpenAICompat = inkosProvider?.id === "google" && (
    Boolean(config.proxyUrl?.trim())
    || baseUrl.includes("/openai")
    || Boolean(process.env.INKOS_LLM_PROXY_URL?.trim())
  );
  const piApi = (googleOpenAICompat ? "openai-completions" : piApiRaw) as PiApi;
  if (googleOpenAICompat && !baseUrl.includes("/openai")) {
    baseUrl = inkosProvider?.modelsBaseUrl
      || "https://generativelanguage.googleapis.com/v1beta/openai";
  }
  const compat = piApi === "openai-completions"
    ? resolveProviderCompat(inkosProvider, baseUrl)
    : undefined;

  const provider = config.provider === "anthropic" ? "anthropic" : "openai";
  // pi-ai provider 字段：大多数情况 pi-ai 会按 baseUrl 自动嗅探（openrouter.ai / api.z.ai /
  // api.x.ai / deepseek.com / anthropic.com 等）。这里只列 pi-ai 嗅探不到、需要显式指定的少数情况。
  let piProvider: string;
  if (inkosProvider?.id === "google") piProvider = googleOpenAICompat ? "openai" : "google";
  else if (inkosProvider?.id === "zhipu") piProvider = "zai";
  else if (inkosProvider?.id === "openrouter") piProvider = "openrouter";
  else if (inkosProvider?.id === "githubCopilot") piProvider = "githubCopilot";
  else if (inkosProvider?.id === "ollama") piProvider = "ollama";
  else if (inkosProvider?.api === "anthropic-messages") piProvider = "anthropic";
  else piProvider = provider;

  const piModel: PiModel<PiApi> = {
    id: modelCard?.deploymentName ?? config.model,
    name: config.model,
    api: piApi,
    provider: piProvider,
    baseUrl,
    // 注意：piModel.reasoning 是"激活 reasoning 模式"标志（会让 pi-ai 把 system 改成 developer role 等），
    // 不是"模型能力"标签。只有用户显式配了 thinkingBudget > 0 才启用 reasoning mode。
    // 千万不要从 lobe abilities.reasoning 自动推导，否则 Moonshot 这类不支持 developer role 的服务
    // 会把 content 吃掉，只返回 reasoning_content（见 R4 bug 1 诊断）。
    reasoning: (config.thinkingBudget ?? 0) > 0,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: modelCard?.contextWindowTokens ?? 128_000,
    maxTokens: modelCard?.maxOutput ?? UNKNOWN_MODEL_FALLBACK_MAX_TOKENS,
    ...(extraHeaders ? { headers: extraHeaders } : {}),
    ...(compat ? { compat } : {}),
  };

  return {
    provider,
    service: serviceName,
    configSource: config.configSource,
    apiFormat,
    stream,
    proxyUrl: config.proxyUrl,
    _piModel: piModel,
    _apiKey: config.apiKey,
    defaults,
  };
}

function resolvePiApi(
  serviceName: string,
  apiFormat: LLMConfig["apiFormat"] | undefined,
  presetApi: PiApi | undefined,
): PiApi {
  if (serviceName === "custom") {
    return apiFormat === "responses" ? "openai-responses" : "openai-completions";
  }
  // OpenRouter supports both; InkOS writing / free Nemotron traffic uses chat
  // completions (same as huobao-drama), not the Responses API.
  if (serviceName === "openrouter" && apiFormat === "chat") {
    return "openai-completions";
  }
  if (apiFormat === "responses") {
    return "openai-responses";
  }
  return (presetApi ?? "openai-completions") as PiApi;
}

function resolveProviderCompat(
  provider: ReturnType<typeof getEndpoint>,
  baseUrl: string,
): Record<string, unknown> | undefined {
  const compat = {
    ...(provider?.compat ?? {}),
    ...(baseUrl.includes("generativelanguage.googleapis.com") ? { supportsStore: false } : {}),
  };
  return Object.keys(compat).length > 0 ? compat : undefined;
}

function parseEnvHeaders(): Record<string, string> | undefined {
  const raw = process.env.INKOS_LLM_HEADERS;
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch {
    // not JSON — treat as single "Key: Value" pair
    const idx = raw.indexOf(":");
    if (idx > 0) {
      return { [raw.slice(0, idx).trim()]: raw.slice(idx + 1).trim() };
    }
  }
  return undefined;
}

// === Partial Response（流式生成中途被掐断）===
// 语义：内容不完整、不可信。由 withTransientLLMRetry 整体重新生成；
// 重试耗尽后如实抛错。绝不把半截内容当成功返回（那会产出写到一半就
// 结束的章节/设定文件）。partialContent 仅用于错误诊断。

export class PartialResponseError extends Error {
  readonly partialContent: string;
  constructor(partialContent: string, cause: unknown) {
    super(`Stream interrupted after ${partialContent.length} chars: ${String(cause)}`);
    this.name = "PartialResponseError";
    this.partialContent = partialContent;
  }
}

/** Upstream finished with no usable text (common on free reasoning models). */
export class EmptyResponseError extends Error {
  constructor(detail?: string) {
    super(
      detail?.trim()
        ? `LLM returned empty response from stream (${detail})`
        : "LLM returned empty response from stream",
    );
    this.name = "EmptyResponseError";
  }
}

export class ContextWindowExceededError extends Error {
  readonly estimatedInputTokens: number;
  readonly reservedOutputTokens: number;
  readonly contextWindow: number;

  constructor(params: {
    readonly estimatedInputTokens: number;
    readonly reservedOutputTokens: number;
    readonly contextWindow: number;
    readonly model: string;
  }) {
    super(
      `InkOS context window guard: estimated input ${params.estimatedInputTokens} tokens + ` +
      `reserved output ${params.reservedOutputTokens} tokens exceeds context window ${params.contextWindow} ` +
      `for model "${params.model}". Please compress the active book/session context before retrying; ` +
      `InkOS will not truncate semantic text automatically.`,
    );
    this.name = "ContextWindowExceededError";
    this.estimatedInputTokens = params.estimatedInputTokens;
    this.reservedOutputTokens = params.reservedOutputTokens;
    this.contextWindow = params.contextWindow;
  }
}

/** Keys managed by the provider layer — prevent extra from overriding them. */
const RESERVED_KEYS = new Set(["max_tokens", "temperature", "model", "messages", "stream"]);

function stripReservedKeys(extra: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(extra)) {
    if (!RESERVED_KEYS.has(key)) result[key] = value;
  }
  return result;
}

// === Fixed-Temperature Model Clamp ===
//
// 部分 thinking 模型（如 Moonshot kimi-k2.5/k2.6、kimi-k2-thinking）的 API
// 硬要求 temperature === 1，其他值会被直接 400 拒绝（Moonshot 返回
// `invalid temperature: only 1 is allowed for this model`）。
//
// inkos 让 writer/validator/architect 各自带 per-call 温度（0.1~1.5），
// 所以 provider 层统一夹制：如果 bank 里模型卡标了 temperature 字段，
// 就把 per-call 温度 clamp 到那个值，并对每个模型名打一次 warning。
//
// 这个字段只表达"服务端硬约束"，普通模型不要标，避免误伤 per-call 调参。

const warnedFixedTemperatureModels = new Set<string>();

function clampTemperatureForModel(
  service: string | undefined,
  model: string,
  requested: number,
): number {
  const card = service ? lookupModel(service, model) : undefined;
  if (card?.temperature === undefined) return requested;
  const locked = card.temperature;
  if (requested === locked) return locked;
  if (!warnedFixedTemperatureModels.has(model)) {
    warnedFixedTemperatureModels.add(model);
    console.warn(
      `[inkos] 模型 "${model}" API 要求 temperature=${locked}，已 clamp（原值 ${requested}）`,
    );
  }
  return locked;
}

// 仅测试用：清空 warning 去重集合。
export function __resetFixedTemperatureWarnings(): void {
  warnedFixedTemperatureModels.clear();
}

export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  const cjk = text.match(/[\u3400-\u9fff]/g)?.length ?? 0;
  const nonCjk = text.length - cjk;
  return Math.ceil(cjk + nonCjk / 4);
}

function estimateJsonTokens(value: unknown): number {
  try {
    return estimateTextTokens(JSON.stringify(value) ?? "");
  } catch {
    return estimateTextTokens(String(value));
  }
}

function estimateLLMMessagesTokens(messages: ReadonlyArray<LLMMessage>): number {
  return messages.reduce((total, message) => total + estimateTextTokens(message.content), 0);
}

type PiMessageContent = PiContext["messages"][number]["content"];

function estimatePiContentTokens(content: PiMessageContent): number {
  if (typeof content === "string") return estimateTextTokens(content);
  let total = 0;
  for (const block of content) {
    if (block.type === "text") {
      total += estimateTextTokens(typeof block.text === "string" ? block.text : "");
      continue;
    }
    if (block.type === "thinking") {
      total += estimateTextTokens(typeof block.thinking === "string" ? block.thinking : "");
      continue;
    }
    if (block.type === "toolCall") {
      total += estimateTextTokens(typeof block.name === "string" ? block.name : "");
      total += estimateTextTokens(typeof block.id === "string" ? block.id : "");
      total += estimateJsonTokens(block.arguments);
      continue;
    }
    if (block.type === "image") {
      total += estimateTextTokens(typeof block.mimeType === "string" ? block.mimeType : "");
      total += estimateTextTokens(typeof block.data === "string" ? block.data : "");
      continue;
    }
    total += estimateJsonTokens(block);
  }
  return total;
}

export function estimatePiContextTokens(context: PiContext): number {
  let total = estimateTextTokens(context.systemPrompt ?? "");
  for (const message of context.messages) {
    total += estimateTextTokens(message.role);
    if (message.role === "assistant") {
      total += estimatePiContentTokens(message.content);
      total += estimateTextTokens(message.model ?? "");
      total += estimateTextTokens(message.provider ?? "");
      total += estimateTextTokens(message.api ?? "");
      continue;
    }
    if (message.role === "toolResult") {
      total += estimateTextTokens(message.toolCallId);
      total += estimateTextTokens(message.toolName);
      total += estimatePiContentTokens(message.content);
      continue;
    }
    total += estimatePiContentTokens(message.content);
  }
  if (context.tools && context.tools.length > 0) {
    total += estimateJsonTokens(context.tools);
  }
  return total;
}

export function assertWithinContextWindow(params: {
  readonly piModel: PiModel<PiApi>;
  readonly model: string;
  readonly estimatedInputTokens: number;
  readonly reservedOutputTokens: number;
}): void {
  const contextWindow = params.piModel.contextWindow;
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return;
  if (params.estimatedInputTokens + params.reservedOutputTokens <= contextWindow) return;
  throw new ContextWindowExceededError({
    estimatedInputTokens: params.estimatedInputTokens,
    reservedOutputTokens: params.reservedOutputTokens,
    contextWindow,
    model: params.model,
  });
}

// === Error Wrapping ===

function wrapLLMError(error: unknown, context?: { readonly baseUrl?: string; readonly model?: string; readonly service?: string }): Error {
  const msg = String(error);
  const ctxLine = context
    ? `\n  (baseUrl: ${context.baseUrl}, model: ${context.model})`
    : "";

  if (msg.includes("400")) {
    // 抽上游 error body 的 message / reason / code（和下方 5xx 一致），让真实错因浮到用户面前
    let detail = "";
    if (error && typeof error === "object") {
      const err = error as { error?: unknown; body?: unknown; message?: string };
      const bodyLike = err.error ?? err.body;
      if (bodyLike && typeof bodyLike === "object") {
        const b = bodyLike as { reason?: string; message?: string; code?: number | string; type?: string };
        if (b.message) detail = b.type ? `${b.type}: ${b.message}` : b.message;
        else if (b.reason) detail = b.reason;
      }
      if (!detail && typeof err.message === "string") {
        detail = extractUpstreamDetailFromErrorMessage(err.message);
      }
    }
    return new Error(
      `API 返回 400（请求参数错误）。${detail ? `上游详情：${detail}。\n` : ""}` +
      `常见原因：\n` +
      `  1. temperature / max_tokens 超出模型约束（如 Moonshot kimi-k2.X 强制 temperature=1）\n` +
      `  2. 模型名称不正确或未上架\n` +
      `  3. 消息格式不兼容（部分服务不支持 system role 或 developer role）\n` +
      `  4. 本地 Ollama 上下文过小（常见默认 4096；建书/写章 prompt 更大时需提高 num_ctx）${ctxLine}`,
    );
  }
  if (msg.includes("403")) {
    return new Error(
      `API 返回 403 (请求被拒绝)。可能原因：\n` +
      `  1. API Key 无效或过期\n` +
      `  2. API 提供方的内容审查拦截了请求（公益/免费 API 常见）\n` +
      `  3. 账户余额不足\n` +
      `  建议：用 inkos doctor 测试 API 连通性，或换一个不限制内容的 API 提供方${ctxLine}`,
    );
  }
  if (msg.includes("401")) {
    return new Error(
      `API 返回 401 (未授权)。请检查 .env 中的 INKOS_LLM_API_KEY 是否正确。${ctxLine}`,
    );
  }
  if (msg.includes("429")) {
    return new Error(
      `API 返回 429 (请求过多)。请稍后重试，或检查 API 配额。${ctxLine}`,
    );
  }
  if (
    msg.includes("Connection error")
    || msg.includes("ECONNREFUSED")
    || msg.includes("ENOTFOUND")
    || msg.includes("fetch failed")
    || msg.includes("terminated")
    || msg.includes("UND_ERR_SOCKET")
    || msg.includes("ECONNRESET")
    || msg.includes("ETIMEDOUT")
    || msg.includes("EPIPE")
  ) {
    return new Error(
      `无法连接到 API 服务。可能原因：\n` +
      `  1. baseUrl 地址不正确（当前：${context?.baseUrl ?? "未知"}）\n` +
      `  2. 网络不通或被防火墙拦截\n` +
      `  3. API 服务暂时不可用\n` +
      `  建议：检查 INKOS_LLM_BASE_URL 是否包含完整路径（如 /v1）`,
    );
  }
  // R4 Bug 2: 5xx "status code (no body)" — 尝试从 OpenAI SDK APIError 里抽 body 给用户看具体原因
  // （如 PPIO 的 {"code":500,"reason":"MODEL_NOT_AVAILABLE","message":"model not available"}）
  if (msg.includes("status code") && msg.includes("no body")) {
    let detail = "";
    if (error && typeof error === "object") {
      const err = error as { error?: unknown; body?: unknown; message?: string };
      const bodyLike = err.error ?? err.body;
      if (bodyLike && typeof bodyLike === "object") {
        const b = bodyLike as { reason?: string; message?: string; code?: number | string };
        if (b.reason) detail = `${b.reason}${b.message ? `: ${b.message}` : ""}`;
        else if (b.message) detail = b.message;
      }
    }
    return new Error(
      `API 返回 5xx（上游服务异常）。${detail ? `上游详情：${detail}。` : ""}\n` +
      `可能原因：\n` +
      `  1. 模型在 /models 列表但 inference 未上架（如 PPIO 返回 MODEL_NOT_AVAILABLE）\n` +
      `  2. 服务端临时故障，稍后重试\n` +
      `  3. 当前 apikey 无权限调用该模型${ctxLine}`,
    );
  }
  return error instanceof Error ? error : new Error(msg);
}

function collectErrorText(error: unknown, depth = 0): string {
  if (depth > 4 || error === null || error === undefined) return "";
  const parts = [String(error)];
  if (error instanceof Error) {
    parts.push(error.name, error.message);
    const cause = (error as Error & { cause?: unknown }).cause;
    if (cause) parts.push(collectErrorText(cause, depth + 1));
  } else if (typeof error === "object") {
    const err = error as { code?: unknown; cause?: unknown; message?: unknown; name?: unknown };
    if (err.name) parts.push(String(err.name));
    if (err.message) parts.push(String(err.message));
    if (err.code) parts.push(String(err.code));
    if (err.cause) parts.push(collectErrorText(err.cause, depth + 1));
  }
  return parts.join("\n");
}

function isTransientLLMTransportError(error: unknown): boolean {
  const text = collectErrorText(error);
  return [
    "terminated",
    "UND_ERR_SOCKET",
    "ECONNRESET",
    "ETIMEDOUT",
    "EPIPE",
    "socket hang up",
    "other side closed",
    "network socket disconnected",
  ].some((needle) => text.includes(needle));
}

/**
 * True when the failure is specifically a rate-limit / concurrency throttle
 * (HTTP 429 or common phrasing). Used for longer minute-scale backoff so free-tier
 * Zhipu (and similar) calls can wait out the window instead of failing immediately.
 */
export function isRateLimitLLMError(error: unknown): boolean {
  const text = collectErrorText(error).toLowerCase();
  if (/\b429\b/.test(text)) return true;
  if (text.includes("too many requests") || text.includes("rate limit")) return true;
  // Common zh phrasing from Chinese providers / wrapped InkOS errors
  if (text.includes("请求过多") || text.includes("限流")) return true;
  // Zhipu business codes (docs: 1302 account rate limit, 1305 platform overload).
  // Some responses expose the code without an HTTP "429" substring.
  if (/\b1302\b/.test(text) || /\b1305\b/.test(text)) return true;
  return false;
}

/** Zhipu 1210 when max_tokens exceeds the model cap — worth rotating to another Flash. */
export function isZhipuMaxTokensParamError(error: unknown): boolean {
  const text = collectErrorText(error).toLowerCase();
  return text.includes("max_tokens参数非法")
    || (text.includes("1210") && text.includes("max_tokens"));
}

/**
 * Transient *HTTP-level* upstream failures worth retrying: 429 (rate limit),
 * 502/503/504 (gateway / temporarily unavailable / overloaded). These are the
 * aggregator blips that previously aborted whole architect/writer/short runs
 * because only transport-level errors were retried.
 *
 * Deliberately does NOT match a bare 500 / "MODEL_NOT_AVAILABLE": on providers
 * like PPIO a 500 means the model isn't on inference at all — retrying is futile
 * and just delays the real error.
 */
export function isTransientLLMHttpError(error: unknown): boolean {
  const text = collectErrorText(error).toLowerCase();
  if (text.includes("model_not_available") || text.includes("model not available")) {
    return false;
  }
  const statusHit = /\b(429|502|503|504)\b/.test(text);
  const zhipuRateHit = /\b1302\b/.test(text) || /\b1305\b/.test(text);
  const phraseHit = [
    "temporarily unavailable",
    "service unavailable",
    "bad gateway",
    "gateway timeout",
    "too many requests",
    "rate limit",
    "overloaded",
    "please retry",
    "try again later",
    "请求过多",
    "限流",
  ].some((needle) => text.includes(needle));
  return statusHit || zhipuRateHit || phraseHit;
}

function isRetryableLLMError(error: unknown): boolean {
  // PartialResponseError = 流在生成中途被掐断（网关切长连接等）。重试会完整
  // 重新生成一次，比把半截内容当成功交付（截断的章节/设定文件）要正确。
  return error instanceof PartialResponseError
    || isTransientLLMTransportError(error)
    || isTransientLLMHttpError(error);
}

async function withTransientLLMRetry<T>(
  run: () => Promise<T>,
  options?: {
    readonly enabled?: boolean;
    readonly signal?: AbortSignal;
    /**
     * When true (streaming text/thinking deltas already wired to UI), still retry
     * rate-limits and mid-stream PartialResponseError (full rewrite). Do not retry
     * generic mid-stream 502/transport blips that aren't wrapped as PartialResponse —
     * those are ambiguous and could duplicate visible deltas without a clean restart.
     */
    readonly rateLimitOnly?: boolean;
    /** Length of Zhipu (or other) model rotation pool; enables short hop delays. */
    readonly modelRotationLength?: number;
    /**
     * Called before the rate-limit sleep. Return true when the caller switched
     * to a different model so we can use a short hop delay.
     */
    readonly onRateLimitRetry?: (attempt: number) => boolean | void | Promise<boolean | void>;
  },
): Promise<T> {
  const enabled = options?.enabled ?? true;
  const rotationLength = Math.max(1, options?.modelRotationLength ?? 1);
  let lastError: unknown;
  let longBackoffIndex = 0;
  for (let attempt = 0; ; attempt++) {
    options?.signal?.throwIfAborted();
    try {
      return await run();
    } catch (error) {
      lastError = error;
      const rateLimited = isRateLimitLLMError(error);
      const maxTokensParamError = isZhipuMaxTokensParamError(error);
      const partialResponse = error instanceof PartialResponseError;
      const emptyResponse = error instanceof EmptyResponseError
        || (error instanceof Error && /LLM returned empty response/i.test(error.message));
      const maxRetries = (rateLimited || maxTokensParamError)
        ? RATE_LIMIT_LLM_RETRIES
        : (partialResponse || emptyResponse)
          ? PARTIAL_RESPONSE_LLM_RETRIES
          : TRANSIENT_LLM_RETRIES;
      const retryable = options?.rateLimitOnly
        ? (rateLimited || maxTokensParamError || partialResponse || emptyResponse)
        : (isRetryableLLMError(error) || maxTokensParamError || emptyResponse);
      if (!enabled || attempt >= maxRetries || !retryable) {
        throw error;
      }
      if (rateLimited || maxTokensParamError) {
        const switched = Boolean(await options?.onRateLimitRetry?.(attempt));
        // Hop quickly across free Flash models; after a full cycle use minute backoff.
        const completedCycle = rotationLength > 1 && (attempt + 1) % rotationLength === 0;
        const delayMs = maxTokensParamError
          ? 500 // bad max_tokens — switch model immediately
          : switched && !completedCycle
            ? RATE_LIMIT_MODEL_ROTATE_DELAY_MS
            : RATE_LIMIT_BACKOFF_MS[
              Math.min(longBackoffIndex++, RATE_LIMIT_BACKOFF_MS.length - 1)
            ]!;
        console.warn(
          `[llm] ${maxTokensParamError ? "max_tokens rejected" : "429 rate limit"} — waiting ${Math.round(delayMs / 1000)}s before retry ${attempt + 1}/${maxRetries}`
          + (switched ? " (model rotated)" : ""),
        );
        await abortableDelay(delayMs, options?.signal);
      } else if (partialResponse || emptyResponse) {
        const delayMs = PARTIAL_RESPONSE_BACKOFF_MS[
          Math.min(attempt, PARTIAL_RESPONSE_BACKOFF_MS.length - 1)
        ]!;
        console.warn(
          partialResponse
            ? `[llm] stream interrupted after ${(error as PartialResponseError).partialContent.length} chars — rewriting attempt ${attempt + 1}/${maxRetries} after ${Math.round(delayMs / 1000)}s`
            : `[llm] empty LLM response — rewriting attempt ${attempt + 1}/${maxRetries} after ${Math.round(delayMs / 1000)}s`,
        );
        await abortableDelay(delayMs, options?.signal);
      } else {
        // Short linear backoff for 502/503/transport blips (~0.8s, ~1.6s).
        await abortableDelay(800 * (attempt + 1), options?.signal);
      }
    }
  }
  throw lastError;
}

async function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
    return;
  }
  signal.throwIfAborted();
  await new Promise<void>((resolveDelay, rejectDelay) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolveDelay();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      rejectDelay(signal.reason ?? new Error("LLM request aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function shouldUseNativeCustomTransport(client: LLMClient): boolean {
  if (client.service === "minimax" && client.provider === "openai") {
    return true;
  }
  if (client.service === "kkaiapi" && client.provider === "openai") {
    return true;
  }
  // 智谱 GLM-4.7+ 默认开启 thinking；需走原生 OpenAI 兼容传输才能注入
  // thinking: { type: "disabled" }，否则长文写作会把 max_tokens 耗尽在思考上、正文为空。
  if (client.service === "zhipu" && client.provider === "openai") {
    return true;
  }
  // DeepSeek V4 defaults to thinking-on; same native path to inject thinking.disabled.
  if (client.service === "deepseek" && client.provider === "openai") {
    return true;
  }
  // Google via /openai + proxy: same native path so INKOS_LLM_PROXY_URL is honored.
  if (
    client.service === "google"
    && client.provider === "openai"
    && client._piModel?.api === "openai-completions"
  ) {
    return true;
  }
  // OpenRouter chat completions + proxy (Nemotron free, etc.).
  if (
    client.service === "openrouter"
    && client.provider === "openai"
    && client._piModel?.api === "openai-completions"
  ) {
    return true;
  }
  if (client.service === "custom") {
    if (
      client.configSource === "studio"
      && (client.provider === "openai" || client.provider === "anthropic")
    ) {
      return true;
    }
    return client.provider === "openai" && shouldUseNativeLocalOpenAICompatibleTransport(client);
  }
  return client.service === "ollama"
    && client.provider === "openai"
    && shouldUseNativeLocalOpenAICompatibleTransport(client);
}

function shouldUseNativeLocalOpenAICompatibleTransport(client: LLMClient): boolean {
  // Studio/CLI often store a dummy key like "ollama" for local endpoints.
  // That must not force the pi-ai Ollama path — OpenAI-compatible /v1 works better
  // for dynamic local model ids such as deepseek-r1:14b.
  return isAbsentOrLocalPlaceholderApiKey(client._apiKey)
    && isApiKeyOptionalForEndpoint({
      provider: client.provider,
      baseUrl: client._piModel?.baseUrl,
    });
}

/** Treat common local dummy keys as "no real API key". */
export function isAbsentOrLocalPlaceholderApiKey(apiKey: string | undefined): boolean {
  const normalized = (apiKey ?? "").trim().toLowerCase();
  return normalized.length === 0
    || normalized === "ollama"
    || normalized === "local"
    || normalized === "none"
    || normalized === "n/a"
    || normalized === "sk-local"
    || normalized === "no-key";
}

function buildCustomHeaders(client: LLMClient): Record<string, string> {
  const apiKey = sanitizeHeaderApiKey(client._apiKey);
  return sanitizeHttpHeaders({
    "Content-Type": "application/json",
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    // OpenRouter asks for these attribution headers on free/paid traffic.
    ...(client.service === "openrouter"
      ? {
          "HTTP-Referer": "https://github.com/inkos-ai/inkos",
          "X-Title": "InkOS",
        }
      : {}),
    ...(client._piModel?.headers ?? {}),
  }) ?? { "Content-Type": "application/json" };
}

function defaultOpenAIChatExtra(client: LLMClient, model: string): Record<string, unknown> {
  if (client.service === "minimax") {
    // MiniMax OpenAI 兼容端点（issue #329）：
    // - reasoning_split: true 让 thinking 拆分到 reasoning_content / reasoning_details，
    //   不再以 <think>...</think> 内联在 content 里。M2.x 系列的 thinking 无法关闭，
    //   不拆分的话思考内容会混进章节/对话正文。
    // - M3 系列额外默认关闭 thinking（M2.x 不支持 thinking 参数，不能发送）。
    return {
      reasoning_split: true,
      ...(/^minimax-m3(?:$|[-_.])/i.test(model) ? { thinking: { type: "disabled" } } : {}),
    };
  }
  if (client.service === "zhipu") {
    // GLM-4.7+ defaults to thinking-on; leave it enabled only burns max_tokens on
    // reasoning and can yield empty chapter bodies. Older Flash models also accept
    // the field, so always send disabled for InkOS writing/settlement traffic.
    return { thinking: { type: "disabled" } };
  }
  if (client.service === "deepseek") {
    // deepseek-v4-* defaults to thinking mode; disable for drafting throughput.
    return { thinking: { type: "disabled" } };
  }
  if (client.service === "google") {
    // Gemini 3.x defaults to medium thinking; keep it minimal for novel drafting
    // so output tokens aren't burned on hidden thoughts.
    return { reasoning_effort: "minimal" };
  }
  if (client.service === "openrouter") {
    // Explicit thinkingBudget > 0 keeps light reasoning available for callers that opt in.
    if ((client.defaults.thinkingBudget ?? 0) > 0) {
      return { reasoning: { effort: "minimal" } };
    }
    // Writing stack (Ultra): disable reasoning — long free-route thoughts burn
    // completion tokens and wall time. Planning/audit stack (Super): light thinking.
    if (/nemotron-3-ultra/i.test(model)) {
      return { reasoning: { effort: "none" } };
    }
    if (/nemotron-3-super/i.test(model)) {
      return { reasoning: { effort: "minimal" } };
    }
    return { reasoning: { effort: "none" } };
  }
  return {};
}

function sanitizeHeaderApiKey(apiKey: string | undefined): string {
  const trimmed = apiKey?.trim() ?? "";
  if (!trimmed) return "";
  if (!/^[\x20-\x7e]+$/.test(trimmed)) {
    throw new Error("API Key contains non-ASCII characters; please remove any pasted Chinese notes or whitespace.");
  }
  return trimmed;
}

function joinSystemPrompt(messages: ReadonlyArray<LLMMessage>): string | undefined {
  const systemParts = messages
    .filter((message) => message.role === "system" && message.content.trim().length > 0)
    .map((message) => message.content.trim());
  return systemParts.length > 0 ? systemParts.join("\n\n") : undefined;
}

function buildChatMessages(messages: ReadonlyArray<LLMMessage>): Array<{ role: string; content: string }> {
  return messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role,
      content: message.content,
    }));
}

function buildAnthropicMessages(messages: ReadonlyArray<LLMMessage>): Array<{ role: "user" | "assistant"; content: string }> {
  return messages
    .filter((message): message is Readonly<LLMMessage> & { role: "user" | "assistant" } => message.role === "user" || message.role === "assistant")
    .map((message) => ({
      role: message.role,
      content: message.content,
    }));
}

function buildResponsesInput(messages: ReadonlyArray<LLMMessage>): Array<{ role: string; content: Array<{ type: "input_text"; text: string }> }> {
  return messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role,
      content: [{ type: "input_text", text: message.content }],
    }));
}

function hasSystemMessages(messages: ReadonlyArray<LLMMessage>): boolean {
  return messages.some((message) => message.role === "system" && message.content.trim().length > 0);
}

function foldSystemMessagesIntoFirstUser(messages: ReadonlyArray<LLMMessage>): LLMMessage[] {
  const system = joinSystemPrompt(messages);
  const nonSystemMessages = messages.filter((message) => message.role !== "system");
  if (!system) return [...nonSystemMessages];

  const firstUserIndex = nonSystemMessages.findIndex((message) => message.role === "user");
  const prefix = `System instructions:\n${system}\n\nUser request:\n`;
  if (firstUserIndex < 0) {
    return [{ role: "user", content: `System instructions:\n${system}` }, ...nonSystemMessages];
  }

  return nonSystemMessages.map((message, index) => index === firstUserIndex
    ? { ...message, content: `${prefix}${message.content}` }
    : message);
}

function isSystemRoleUnsupportedErrorText(text: string): boolean {
  const normalized = text.toLowerCase();
  const mentionsSystemRole = normalized.includes("system") && normalized.includes("role");
  if (!mentionsSystemRole) return false;
  return normalized.includes("unsupported")
    || normalized.includes("not support")
    || normalized.includes("does not support")
    || normalized.includes("invalid")
    || normalized.includes("不支持")
    || normalized.includes("不允许");
}

async function readErrorResponse(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const json = JSON.parse(text) as { error?: { message?: string } | string; detail?: string };
    if (typeof json.error === "string" && json.error) return `${res.status} ${json.error}`;
    if (json.error && typeof json.error === "object" && typeof json.error.message === "string") {
      return `${res.status} ${json.error.message}`;
    }
    if (typeof json.detail === "string" && json.detail) return `${res.status} ${json.detail}`;
  } catch {
    // fall through
  }
  return `${res.status} ${text || res.statusText}`.trim();
}

type ParsedSseEvent = {
  readonly event?: string;
  readonly data?: string;
};

function parseSseEvents(buffer: string): { readonly events: ParsedSseEvent[]; readonly rest: string } {
  const chunks = buffer.split(/\n\n/);
  const rest = chunks.pop() ?? "";
  const events: ParsedSseEvent[] = [];

  for (const chunk of chunks) {
    const lines = chunk.split(/\r?\n/);
    let eventName: string | undefined;
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith("event:")) {
        eventName = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trimStart());
      }
    }
    if (eventName || dataLines.length > 0) {
      events.push({
        ...(eventName ? { event: eventName } : {}),
        ...(dataLines.length > 0 ? { data: dataLines.join("\n") } : {}),
      });
    }
  }

  return { events, rest };
}

function extractOpenAITextPart(value: any): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => typeof item?.text === "string" ? item.text : typeof item?.content === "string" ? item.content : "")
      .join("");
  }
  return "";
}

function extractChatContent(json: any): string {
  const message = json?.choices?.[0]?.message;
  // Ollama deepseek-r1 等思考模型用 `reasoning`；OpenAI 兼容网关多用 `reasoning_content`。
  return extractOpenAITextPart(message?.content)
    || extractOpenAITextPart(message?.reasoning_content)
    || extractOpenAITextPart(message?.reasoning);
}

function extractChatDeltaContent(json: any): string {
  return extractOpenAITextPart(json?.choices?.[0]?.delta?.content);
}

function extractChatDeltaReasoningContent(json: any): string {
  const delta = json?.choices?.[0]?.delta;
  // MiniMax reasoning_split 模式下流式 thinking 走 delta.reasoning_details
  //（[{ text: "..." }] 数组）；其它服务走 delta.reasoning_content。
  // Ollama R1 流式思考字段为 delta.reasoning。
  return extractOpenAITextPart(delta?.reasoning_content)
    || extractOpenAITextPart(delta?.reasoning_details)
    || extractOpenAITextPart(delta?.reasoning);
}

function extractUpstreamDetailFromErrorMessage(message: string): string {
  // readErrorResponse 产出形如：`400 {"error":{"message":"..."}}` 或嵌套 JSON 字符串。
  const jsonStart = message.indexOf("{");
  if (jsonStart < 0) return "";
  try {
    const parsed = JSON.parse(message.slice(jsonStart)) as {
      error?: { message?: string; type?: string } | string;
      message?: string;
    };
    const raw = typeof parsed.error === "string"
      ? parsed.error
      : parsed.error?.message ?? parsed.message ?? "";
    if (!raw) return "";
    // Ollama 有时把内层 error 再 JSON.stringify 一次
    if (raw.trim().startsWith("{")) {
      try {
        const nested = JSON.parse(raw) as { error?: { message?: string }; message?: string };
        return nested.error?.message ?? nested.message ?? raw;
      } catch {
        return raw;
      }
    }
    return raw;
  } catch {
    return "";
  }
}

function resolveCallMaxTokens(
  client: LLMClient,
  model: string,
  explicit?: number,
): number {
  const card = lookupModel(client.service ?? "custom", model);
  const cardMax = card?.maxOutput ?? client.defaults.maxTokens;
  // Per-call fitMaxTokensToContextWindow clamps reserved output to remaining room.
  if (explicit === undefined) return cardMax;
  // Never send above the provider card — Zhipu returns HTTP 400 (code 1210)
  // when max_tokens exceeds the model-specific cap (e.g. glm-4-flash-250414 ≤ 16384).
  return Math.min(explicit, cardMax);
}

/** Clamp max_tokens so input + reserved output fit in the context window. */
export function fitMaxTokensToContextWindow(params: {
  readonly contextWindow: number;
  readonly estimatedInputTokens: number;
  readonly requestedMaxTokens: number;
}): number {
  const { contextWindow, estimatedInputTokens, requestedMaxTokens } = params;
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
    return requestedMaxTokens;
  }
  // Always keep ≥1 token of headroom for real input — OpenRouter rejects
  // max_tokens === context_length even when the prompt is only a few tokens.
  const room = Math.max(0, contextWindow - Math.max(1, estimatedInputTokens));
  return Math.min(requestedMaxTokens, room);
}

function resolveOllamaNumCtx(client: LLMClient, model: string): number {
  const fromEnv = Number.parseInt(process.env.OLLAMA_NUM_CTX ?? "", 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  const card = lookupModel(client.service ?? "custom", model);
  const fromCard = card?.contextWindowTokens;
  if (typeof fromCard === "number" && fromCard > 0) {
    return Math.min(fromCard, OLLAMA_DEFAULT_NUM_CTX);
  }
  return OLLAMA_DEFAULT_NUM_CTX;
}

function ollamaNativeBaseUrl(openaiCompatBaseUrl: string): string {
  // http://localhost:11434/v1 → http://localhost:11434
  return openaiCompatBaseUrl.replace(/\/v1\/?$/, "").replace(/\/$/, "");
}

/**
 * OpenAI 兼容 /v1 不会应用 options.num_ctx；Ollama 默认常以 4096 驻留。
 * 建书 prompt 往往 >4k，需先经原生 API 把 num_ctx 抬上去。
 * 已加载实例若 context 过小，必须先 unload 再以目标 num_ctx 加载，
 * 否则 /api/chat 可能 200 但实际仍沿用旧的 4096。
 */
async function ensureOllamaNumCtx(
  client: LLMClient,
  model: string,
  numCtx: number,
  signal?: AbortSignal,
): Promise<void> {
  const openaiBase = client._piModel?.baseUrl ?? "";
  if (!openaiBase) return;
  const nativeBase = ollamaNativeBaseUrl(openaiBase);

  let needsReload = true;
  try {
    const psRes = await fetchWithProxy(`${nativeBase}/api/ps`, {
      method: "GET",
      signal,
    }, client.proxyUrl);
    if (psRes.ok) {
      const ps = await psRes.json() as {
        models?: Array<{ name?: string; model?: string; context_length?: number }>;
      };
      const loaded = ps.models?.find((m) => m.name === model || m.model === model);
      if (loaded && (loaded.context_length ?? 0) >= numCtx) {
        needsReload = false;
      } else if (loaded) {
        await fetchWithProxy(`${nativeBase}/api/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model, prompt: "", keep_alive: 0 }),
          signal,
        }, client.proxyUrl);
      }
    }
  } catch {
    // probe/unload failed — still attempt preload below
  }

  if (!needsReload) return;

  const preload = await fetchWithProxy(`${nativeBase}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "." }],
      stream: false,
      keep_alive: "30m",
      options: { num_ctx: numCtx },
    }),
    signal,
  }, client.proxyUrl);
  if (!preload.ok) {
    const detail = await readErrorResponse(preload);
    throw wrapLLMError(new Error(detail), {
      baseUrl: openaiBase,
      model,
      service: client.service,
    });
  }

  // Confirm context actually stuck; surface a clear error if Ollama ignored num_ctx.
  try {
    const psRes = await fetchWithProxy(`${nativeBase}/api/ps`, {
      method: "GET",
      signal,
    }, client.proxyUrl);
    if (psRes.ok) {
      const ps = await psRes.json() as {
        models?: Array<{ name?: string; model?: string; context_length?: number }>;
      };
      const loaded = ps.models?.find((m) => m.name === model || m.model === model);
      const actual = loaded?.context_length ?? 0;
      if (actual > 0 && actual < numCtx) {
        throw wrapLLMError(
          new Error(
            `400 Ollama loaded "${model}" with context_length=${actual}, ` +
            `but InkOS needs >= ${numCtx}. Set OLLAMA_NUM_CTX or free VRAM and retry.`,
          ),
          { baseUrl: openaiBase, model, service: client.service },
        );
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("API 返回 400")) throw error;
    // ignore probe failures after successful preload
  }
}

function isOllamaCompatibleClient(client: LLMClient): boolean {
  if (client.service === "ollama") return true;
  const base = (client._piModel?.baseUrl ?? "").toLowerCase();
  return base.includes(":11434") || base.includes("localhost:11434") || base.includes("127.0.0.1:11434");
}

function extractResponsesContent(json: any): string {
  const output = Array.isArray(json?.output) ? json.output : [];
  return output
    .flatMap((item: any) => Array.isArray(item?.content) ? item.content : [])
    .map((part: any) => {
      if (typeof part?.text === "string") return part.text;
      if (typeof part?.content === "string") return part.content;
      if (typeof part?.output_text === "string") return part.output_text;
      return "";
    })
    .join("");
}

function extractAnthropicContent(json: any): string {
  const content = Array.isArray(json?.content) ? json.content : [];
  return content
    .map((part: any) => typeof part?.text === "string" ? part.text : "")
    .join("");
}

async function chatCompletionViaCustomAnthropicCompatible(
  client: LLMClient,
  model: string,
  messages: ReadonlyArray<LLMMessage>,
  resolved: { readonly temperature: number; readonly maxTokens: number; readonly extra: Record<string, unknown> },
  onStreamProgress?: OnStreamProgress,
  onTextDelta?: (text: string) => void,
  signal?: AbortSignal,
): Promise<LLMResponse> {
  const baseUrl = client._piModel?.baseUrl ?? "";
  const errorCtx = { baseUrl, model, service: client.service };
  const extra = stripReservedKeys(resolved.extra);
  const payload: Record<string, unknown> = {
    model,
    messages: buildAnthropicMessages(messages),
    stream: client.stream,
    max_tokens: resolved.maxTokens,
    temperature: resolved.temperature,
    ...extra,
  };
  const system = joinSystemPrompt(messages);
  if (system) payload.system = system;

  const apiKey = sanitizeHeaderApiKey(client._apiKey);
  const response = await fetchWithProxy(`${baseUrl.replace(/\/$/, "")}/messages`, {
    method: "POST",
    headers: sanitizeHttpHeaders({
      "User-Agent": INKOS_USER_AGENT,
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      ...(client._piModel?.headers ?? {}),
    }) ?? { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  }, client.proxyUrl);

  if (!response.ok) {
    throw wrapLLMError(new Error(await readErrorResponse(response)), errorCtx);
  }

  if (!client.stream) {
    const json = await response.json() as any;
    const content = extractAnthropicContent(json);
    if (!content) {
      throw wrapLLMError(new EmptyResponseError(), errorCtx);
    }
    return {
      content,
      usage: {
        promptTokens: json?.usage?.input_tokens ?? 0,
        completionTokens: json?.usage?.output_tokens ?? 0,
        totalTokens: (json?.usage?.input_tokens ?? 0) + (json?.usage?.output_tokens ?? 0),
      },
    };
  }

  const reader = response.body?.getReader();
  if (!reader) throw wrapLLMError(new Error("Streaming body unavailable"), errorCtx);
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let sawMessageStop = false;
  const monitor = createStreamMonitor(onStreamProgress);

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parsed = parseSseEvents(buffer);
      buffer = parsed.rest;
      for (const event of parsed.events) {
        if (!event.data) continue;
        const json = JSON.parse(event.data);
        if (json.type === "message_start" && json.message?.usage) {
          usage.promptTokens = json.message.usage.input_tokens ?? usage.promptTokens;
        }
        if (json.type === "content_block_delta" && json.delta?.type === "text_delta" && typeof json.delta.text === "string") {
          content += json.delta.text;
          monitor.onChunk(json.delta.text);
          onTextDelta?.(json.delta.text);
        }
        if (json.type === "message_delta" && json.usage) {
          usage.completionTokens = json.usage.output_tokens ?? usage.completionTokens;
        }
        if (json.type === "message_stop") {
          sawMessageStop = true;
          usage.totalTokens = usage.promptTokens + usage.completionTokens;
        }
      }
    }
  } finally {
    monitor.stop();
  }

  if (!content) {
    throw wrapLLMError(new EmptyResponseError(), errorCtx);
  }
  if (!sawMessageStop) {
    // Anthropic 协议的正常结束必须有 message_stop；没有就是流被中途掐断
    throw new PartialResponseError(content, new Error("stream closed without message_stop"));
  }
  if (!usage.totalTokens) {
    usage.totalTokens = usage.promptTokens + usage.completionTokens;
  }
  return { content, usage };
}

async function chatCompletionViaCustomOpenAICompatible(
  client: LLMClient,
  model: string,
  messages: ReadonlyArray<LLMMessage>,
  resolved: { readonly temperature: number; readonly maxTokens: number; readonly extra: Record<string, unknown> },
  onStreamProgress?: OnStreamProgress,
  onTextDelta?: (text: string) => void,
  signal?: AbortSignal,
  allowSystemRoleFallback = true,
  onThinkingDelta?: OnThinkingDelta,
): Promise<LLMResponse> {
  if (client.provider === "anthropic") {
    return chatCompletionViaCustomAnthropicCompatible(client, model, messages, resolved, onStreamProgress, onTextDelta, signal);
  }
  const baseUrl = client._piModel?.baseUrl ?? "";
  const headers = buildCustomHeaders(client);
  const errorCtx = { baseUrl, model, service: client.service };
  const extra = stripReservedKeys(resolved.extra);

  if (client.apiFormat === "responses") {
    const payload: Record<string, unknown> = {
      model,
      input: buildResponsesInput(messages),
      stream: client.stream,
      store: false,
      max_output_tokens: resolved.maxTokens,
      temperature: resolved.temperature,
      ...extra,
    };
    const instructions = joinSystemPrompt(messages);
    if (instructions) payload.instructions = instructions;

    const response = await fetchWithProxy(`${baseUrl.replace(/\/$/, "")}/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal,
    }, client.proxyUrl);
    if (!response.ok) {
      throw wrapLLMError(new Error(await readErrorResponse(response)), errorCtx);
    }

    if (!client.stream) {
      const json = await response.json() as any;
      const content = extractResponsesContent(json);
      if (!content) {
        throw wrapLLMError(new EmptyResponseError(), errorCtx);
      }
      return {
        content,
        usage: {
          promptTokens: json?.usage?.input_tokens ?? 0,
          completionTokens: json?.usage?.output_tokens ?? 0,
          totalTokens: json?.usage?.total_tokens ?? 0,
        },
      };
    }

    const reader = response.body?.getReader();
    if (!reader) throw wrapLLMError(new Error("Streaming body unavailable"), errorCtx);
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let sawResponseTerminal = false;
    const monitor = createStreamMonitor(onStreamProgress);

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSseEvents(buffer);
        buffer = parsed.rest;
        for (const event of parsed.events) {
          if (!event.data) continue;
          const json = JSON.parse(event.data);
          if (json.type === "response.output_text.delta" && typeof json.delta === "string") {
            content += json.delta;
            monitor.onChunk(json.delta);
            onTextDelta?.(json.delta);
          }
          if (json.type === "response.completed" || json.type === "response.incomplete") {
            sawResponseTerminal = true;
            usage = {
              promptTokens: json.response?.usage?.input_tokens ?? 0,
              completionTokens: json.response?.usage?.output_tokens ?? 0,
              totalTokens: json.response?.usage?.total_tokens ?? 0,
            };
            if (!content) {
              content = extractResponsesContent(json.response);
            }
          }
        }
      }
    } finally {
      monitor.stop();
    }

    if (!content) {
      throw wrapLLMError(new EmptyResponseError(), errorCtx);
    }
    if (!sawResponseTerminal) {
      // Responses 协议的正常结束必须有 response.completed/incomplete 终止事件
      throw new PartialResponseError(content, new Error("stream closed without response.completed"));
    }
    return { content, usage };
  }

  const payload: Record<string, unknown> = {
    model,
    messages: [
      ...messages
        .filter((message) => message.role === "system")
        .map((message) => ({ role: "system", content: message.content })),
      ...buildChatMessages(messages),
    ],
    stream: client.stream,
    temperature: resolved.temperature,
    max_tokens: resolved.maxTokens,
    ...defaultOpenAIChatExtra(client, model),
    ...extra,
  };
  if (client.stream) {
    payload.stream_options = { include_usage: true };
  }

  if (isOllamaCompatibleClient(client)) {
    await ensureOllamaNumCtx(client, model, resolveOllamaNumCtx(client, model), signal);
  }

  const response = await fetchWithProxy(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal,
  }, client.proxyUrl);
  if (!response.ok) {
    const detail = await readErrorResponse(response);
    if (allowSystemRoleFallback && hasSystemMessages(messages) && isSystemRoleUnsupportedErrorText(detail)) {
      return chatCompletionViaCustomOpenAICompatible(
        client,
        model,
        foldSystemMessagesIntoFirstUser(messages),
        resolved,
        onStreamProgress,
        onTextDelta,
        signal,
        false,
        onThinkingDelta,
      );
    }
    throw wrapLLMError(new Error(detail), errorCtx);
  }

  if (!client.stream) {
    const json = await response.json() as any;
    // MiniMax M2.x 等模型可能把思考内容以 <think>...</think> 内联在 content 开头，
    // 剥掉起始处的完整 think 块，防止思考内容混进章节/对话正文（issue #329）。
    const rawContent = extractChatContent(json);
    const thinkMatch = /^\s*<think>([\s\S]*?)<\/think>/i.exec(rawContent);
    if (thinkMatch?.[1]?.trim()) onThinkingDelta?.(thinkMatch[1].trim());
    const reasoningOnly = extractOpenAITextPart(json?.choices?.[0]?.message?.reasoning_content)
      || extractOpenAITextPart(json?.choices?.[0]?.message?.reasoning);
    if (reasoningOnly) onThinkingDelta?.(reasoningOnly);
    const content = stripLeadingThinkBlock(rawContent);
    if (!content) {
      throw wrapLLMError(new EmptyResponseError(), errorCtx);
    }
    return {
      content,
      usage: {
        promptTokens: json?.usage?.prompt_tokens ?? 0,
        completionTokens: json?.usage?.completion_tokens ?? 0,
        totalTokens: json?.usage?.total_tokens ?? 0,
      },
    };
  }

  const reader = response.body?.getReader();
  if (!reader) throw wrapLLMError(new Error("Streaming body unavailable"), errorCtx);
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let reasoningContent = "";
  let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  // OpenAI 协议的正常结束必须出现 [DONE] 哨兵或带 finish_reason 的 chunk。
  // 网关掐断长连接时流会"干净地"关闭但没有任何终止信号——那是截断，不是完成。
  let sawTerminal = false;
  const monitor = createStreamMonitor(onStreamProgress);
  // 内联 <think>...</think> 的模型（如 MiniMax M2.x）：剥掉响应起始处的完整
  // think 块，思考内容既不并入正文也不通过 onTextDelta 发给 UI（issue #329）。
  const thinkStripper = createLeadingThinkTagStripper({
    onThinking: (text) => {
      reasoningContent += (reasoningContent ? "\n" : "") + text;
      monitor.onChunk(text, "thinking");
      onThinkingDelta?.(text);
    },
  });

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parsed = parseSseEvents(buffer);
      buffer = parsed.rest;
      for (const event of parsed.events) {
        if (!event.data) continue;
        if (event.data === "[DONE]") {
          sawTerminal = true;
          continue;
        }
        const json = JSON.parse(event.data);
        if (json?.choices?.[0]?.finish_reason) {
          sawTerminal = true;
        }
        const delta = extractChatDeltaContent(json);
        if (delta) {
          const emittable = thinkStripper.push(delta);
          if (emittable) {
            monitor.onChunk(emittable, "text");
            content += emittable;
            onTextDelta?.(emittable);
          }
        } else {
          const reasoningDelta = extractChatDeltaReasoningContent(json);
          if (reasoningDelta) {
            reasoningContent += reasoningDelta;
            monitor.onChunk(reasoningDelta, "thinking");
            onThinkingDelta?.(reasoningDelta);
          }
        }
        if (json?.usage) {
          usage = {
            promptTokens: json.usage.prompt_tokens ?? usage.promptTokens,
            completionTokens: json.usage.completion_tokens ?? usage.completionTokens,
            totalTokens: json.usage.total_tokens ?? usage.totalTokens,
          };
        }
      }
    }
  } finally {
    monitor.stop();
  }

  // 流结束仍缓冲在剥离器里的文本（未闭合的 think 块等）原样并回，避免数据丢失。
  content += thinkStripper.flush();
  const finalContent = content || reasoningContent;
  if (!finalContent) {
    throw wrapLLMError(new EmptyResponseError(), errorCtx);
  }
  if (!sawTerminal) {
    throw new PartialResponseError(finalContent, new Error("stream closed without [DONE]/finish_reason"));
  }
  return { content: finalContent, usage };
}

// === Simple Chat (used by all agents via BaseAgent.chat()) ===

export async function chatCompletion(
  client: LLMClient,
  model: string,
  messages: ReadonlyArray<LLMMessage>,
  options?: {
    readonly temperature?: number;
    readonly maxTokens?: number;
    readonly webSearch?: boolean;
    readonly onStreamProgress?: OnStreamProgress;
    readonly onTextDelta?: (text: string) => void;
    readonly onThinkingDelta?: OnThinkingDelta;
    readonly signal?: AbortSignal;
    // Diagnostics / connectivity checks want a fast pass-or-fail — set false to
    // skip the transient 502/503/429 retry+backoff (e.g. the doctor probe).
    readonly retry?: boolean;
  },
): Promise<LLMResponse> {
  if (isLlmStubEnabled()) return Promise.resolve(stubChatCompletion(messages, model));
  const onStreamProgress = options?.onStreamProgress;
  const onTextDelta = options?.onTextDelta;
  const onThinkingDelta = options?.onThinkingDelta;
  const signal = options?.signal;
  const rotation = client.service === "zhipu"
    ? buildZhipuRateLimitModelRotation(model)
    : [model];
  let activeModel = model;
  let rotationIndex = 0;
  const errorCtx = {
    baseUrl: client._piModel?.baseUrl ?? "(unknown)",
    model: activeModel,
    service: client.service,
  };

  try {
    const hasStreamDeltas = Boolean(onTextDelta || onThinkingDelta);
    return await withTransientLLMRetry(
      async () => {
        signal?.throwIfAborted();
        const callModel = activeModel;
        errorCtx.model = callModel;
        const piModel = resolvePiModel(client, callModel);
        const estimatedInputTokens = estimateLLMMessagesTokens(messages);
        const requestedMaxTokens = resolveCallMaxTokens(client, callModel, options?.maxTokens);
        const maxTokens = fitMaxTokensToContextWindow({
          contextWindow: piModel.contextWindow,
          estimatedInputTokens,
          requestedMaxTokens,
        });
        const resolved = {
          temperature: clampTemperatureForModel(
            client.service,
            callModel,
            options?.temperature ?? client.defaults.temperature,
          ),
          maxTokens,
          extra: client.defaults.extra,
        };
        assertWithinContextWindow({
          piModel,
          model: callModel,
          estimatedInputTokens,
          reservedOutputTokens: resolved.maxTokens,
        });
        if (resolved.maxTokens <= 0) {
          throw new ContextWindowExceededError({
            estimatedInputTokens,
            reservedOutputTokens: requestedMaxTokens,
            contextWindow: piModel.contextWindow,
            model: callModel,
          });
        }
        if (shouldUseNativeCustomTransport(client)) {
          return chatCompletionViaCustomOpenAICompatible(
            client, callModel, messages, resolved, onStreamProgress, onTextDelta, signal, true, onThinkingDelta,
          );
        }
        return chatCompletionViaPiAi(
          client, callModel, messages, resolved, onStreamProgress, onTextDelta, signal, onThinkingDelta,
        );
      },
      // With stream deltas: still rewrite on PartialResponseError / 429. Callers can
      // opt out entirely (e.g. fast-fail diagnostics via retry: false).
      {
        enabled: options?.retry ?? true,
        rateLimitOnly: hasStreamDeltas,
        signal,
        modelRotationLength: rotation.length,
        onRateLimitRetry: () => {
          if (rotation.length <= 1) return false;
          const prev = activeModel;
          rotationIndex = (rotationIndex + 1) % rotation.length;
          activeModel = rotation[rotationIndex]!;
          if (activeModel === prev) return false;
          console.warn(`[llm] 429 on ${prev} — rotating to ${activeModel}`);
          return true;
        },
      },
    );
  } catch (error) {
    // 注意：中断的流（PartialResponseError）不再"打捞"半截内容当成功返回——
    // 那会产出写到一半就结束的章节/设定文件。重试由 withTransientLLMRetry
    // 负责（完整重新生成）；重试耗尽后如实抛错。
    if (error instanceof Error && error.message.startsWith("API 返回 ")) {
      throw error;
    }
    throw wrapLLMError(error, errorCtx);
  }
}

// === pi-ai Unified Implementation ===

/**
 * Build a pi-ai Model<Api> for a specific per-call model name.
 * The base template comes from client._piModel (created in createLLMClient);
 * we override .id / .name when the caller passes a different model string
 * (e.g. agent overrides).
 */
function resolvePiModel(client: LLMClient, model: string): PiModel<PiApi> {
  const base = client._piModel!;
  if (base.id === model && base.name === model) return base;
  const card = lookupModel(client.service ?? "custom", model);
  return {
    ...base,
    id: model,
    name: model,
    ...(card?.contextWindowTokens ? { contextWindow: card.contextWindowTokens } : {}),
    ...(card?.maxOutput ? { maxTokens: card.maxOutput } : {}),
  };
}

/** Convert inkos LLMMessage[] to pi-ai Context. */
function toPiContext(messages: ReadonlyArray<LLMMessage>): PiContext {
  const systemParts = messages.filter((m) => m.role === "system").map((m) => m.content);
  const systemPrompt = systemParts.length > 0 ? systemParts.join("\n\n") : undefined;
  const piMessages = messages
    .filter((m) => m.role !== "system")
    .map((m) => {
      if (m.role === "user") {
        return { role: "user" as const, content: m.content, timestamp: Date.now() };
      }
      // assistant
      return {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: m.content }],
        api: "openai-completions" as PiApi,
        provider: "openai",
        model: "",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop" as const,
        timestamp: Date.now(),
      };
    });
  return { systemPrompt, messages: piMessages };
}

async function chatCompletionViaPiAi(
  client: LLMClient,
  model: string,
  messages: ReadonlyArray<LLMMessage>,
  resolved: { readonly temperature: number; readonly maxTokens: number; readonly extra: Record<string, unknown> },
  onStreamProgress?: OnStreamProgress,
  onTextDelta?: (text: string) => void,
  signal?: AbortSignal,
  onThinkingDelta?: OnThinkingDelta,
): Promise<LLMResponse> {
  const piModel = resolvePiModel(client, model);
  const context = toPiContext(messages);
  const streamOpts = {
    temperature: resolved.temperature,
    maxTokens: resolved.maxTokens,
    apiKey: client._apiKey,
    headers: mergeUserAgent(piModel.headers),
    signal,
  };

  if (!client.stream) {
    const response = await piCompleteSimple(piModel, context, streamOpts);
    if (response.stopReason === "error" && response.errorMessage) {
      throw new Error(response.errorMessage);
    }
    const textContent = response.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("");
    const thinkingContent = response.content
      .filter((block): block is { type: "thinking"; thinking: string } => block.type === "thinking")
      .map((block) => block.thinking)
      .join("");
    if (thinkingContent) onThinkingDelta?.(thinkingContent);
    const content = textContent || thinkingContent;
    if (!content) {
      const diag = `usage=${response.usage.input}+${response.usage.output}`;
      console.warn(`[inkos] LLM 非流式响应无文本内容 (${diag})`);
      throw new EmptyResponseError(diag);
    }
    return {
      content,
      usage: {
        promptTokens: response.usage.input,
        completionTokens: response.usage.output,
        totalTokens: response.usage.totalTokens,
      },
    };
  }

  const eventStream = piStreamSimple(piModel, context, streamOpts);
  const chunks: string[] = [];
  const thinkingChunks: string[] = [];
  const monitor = createStreamMonitor(onStreamProgress);
  let inputTokens = 0;
  let outputTokens = 0;
  let sawDone = false;

  try {
    for await (const event of eventStream) {
      if (event.type === "text_delta") {
        chunks.push(event.delta);
        monitor.onChunk(event.delta, "text");
        onTextDelta?.(event.delta);
      }
      if (event.type === "thinking_delta") {
        const delta = typeof (event as { delta?: string }).delta === "string"
          ? (event as { delta: string }).delta
          : "";
        if (delta) {
          thinkingChunks.push(delta);
          monitor.onChunk(delta, "thinking");
          onThinkingDelta?.(delta);
        }
      }
      if (event.type === "done" || event.type === "error") {
        const msg = event.type === "done" ? event.message : event.error;
        inputTokens = msg.usage.input;
        outputTokens = msg.usage.output;
        if (event.type === "done") {
          sawDone = true;
          // Capture final thinking blocks when the stream never emitted text_delta.
          if (chunks.length === 0 && Array.isArray(msg.content)) {
            for (const block of msg.content) {
              if (block.type === "thinking") {
                const thinking = typeof (block as { thinking?: string }).thinking === "string"
                  ? (block as { thinking: string }).thinking
                  : "";
                if (thinking) thinkingChunks.push(thinking);
              }
            }
          }
        }
        if (event.type === "error" && msg.errorMessage) {
          const partial = chunks.join("") || thinkingChunks.join("");
          if (partial) {
            throw new PartialResponseError(partial, new Error(msg.errorMessage));
          }
          throw new Error(msg.errorMessage);
        }
      }
    }
  } catch (streamError) {
    monitor.stop();
    if (streamError instanceof PartialResponseError) throw streamError;
    const partial = chunks.join("") || thinkingChunks.join("");
    if (partial) {
      // 带着已收到的部分内容抛 PartialResponseError，让瞬时重试整体重新生成
      throw new PartialResponseError(partial, streamError);
    }
    throw streamError;
  } finally {
    monitor.stop();
  }

  const content = chunks.join("") || thinkingChunks.join("");
  if (!content) {
    const diag = `usage=${inputTokens}+${outputTokens}`;
    console.warn(`[inkos] LLM 流式响应无文本内容 (${diag})`);
    throw new EmptyResponseError(diag);
  }
  if (!sawDone) {
    // 事件流没有以 done 收尾就结束 = 上游把流掐断了，内容不可信
    throw new PartialResponseError(content, new Error("stream ended without done event"));
  }

  return {
    content,
    usage: {
      promptTokens: inputTokens,
      completionTokens: outputTokens,
      totalTokens: inputTokens + outputTokens,
    },
  };
}
