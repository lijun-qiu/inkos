import { describe, expect, it } from "vitest";
import {
  buildZhipuRateLimitModelRotation,
  isRateLimitLLMError,
  isTransientLLMHttpError,
  ZHIPU_FREE_FLASH_ROTATION,
} from "../llm/provider.js";

describe("isTransientLLMHttpError", () => {
  it("retries transient upstream HTTP failures (429/502/503/504)", () => {
    expect(isTransientLLMHttpError(new Error("Request failed with status code 503"))).toBe(true);
    expect(isTransientLLMHttpError(new Error("502 Bad Gateway"))).toBe(true);
    expect(isTransientLLMHttpError(new Error("504 Gateway Timeout"))).toBe(true);
    expect(isTransientLLMHttpError(new Error("429 Too Many Requests"))).toBe(true);
  });

  it("matches the real aggregator 503 message that aborted whole runs", () => {
    expect(
      isTransientLLMHttpError(
        new Error("503 The model provider is temporarily unavailable. Please retry later or contact support."),
      ),
    ).toBe(true);
  });

  it("matches transient phrasing without a status code", () => {
    expect(isTransientLLMHttpError(new Error("the model is currently overloaded"))).toBe(true);
    expect(isTransientLLMHttpError(new Error("service unavailable, try again later"))).toBe(true);
    expect(isTransientLLMHttpError(new Error("rate limit exceeded"))).toBe(true);
  });

  it("looks through a nested cause", () => {
    const err = new Error("upstream call failed") as Error & { cause?: unknown };
    err.cause = new Error("503 temporarily unavailable");
    expect(isTransientLLMHttpError(err)).toBe(true);
  });

  it("does NOT retry permanent failures", () => {
    expect(isTransientLLMHttpError(new Error("401 Unauthorized"))).toBe(false);
    expect(isTransientLLMHttpError(new Error("403 Forbidden"))).toBe(false);
    expect(isTransientLLMHttpError(new Error("400 Bad Request"))).toBe(false);
    expect(isTransientLLMHttpError(new Error("some ordinary validation error"))).toBe(false);
  });

  it("does NOT retry a 500 / MODEL_NOT_AVAILABLE (model not on inference — retry is futile)", () => {
    expect(isTransientLLMHttpError(new Error("500 Internal Server Error"))).toBe(false);
    expect(
      isTransientLLMHttpError(new Error('{"code":500,"reason":"MODEL_NOT_AVAILABLE","message":"model not available"}')),
    ).toBe(false);
  });
});

describe("isRateLimitLLMError", () => {
  it("matches HTTP 429 and rate-limit phrasing", () => {
    expect(isRateLimitLLMError(new Error("429 Too Many Requests"))).toBe(true);
    expect(isRateLimitLLMError(new Error("Request failed with status code 429"))).toBe(true);
    expect(isRateLimitLLMError(new Error("rate limit exceeded"))).toBe(true);
    expect(isRateLimitLLMError(new Error("API 返回 429 (请求过多)。请稍后重试"))).toBe(true);
    expect(isRateLimitLLMError(new Error("触发限流，请稍后重试"))).toBe(true);
  });

  it("matches Zhipu business codes 1302/1305 even without HTTP 429 text", () => {
    expect(isRateLimitLLMError(new Error('{"error":{"code":"1302","message":"您的账户已达到速率限制"}}'))).toBe(true);
    expect(isRateLimitLLMError(new Error('{"error":{"code":"1305","message":"该模型当前访问量过大"}}'))).toBe(true);
    expect(isTransientLLMHttpError(new Error("business code 1302 rate limit"))).toBe(true);
    expect(isTransientLLMHttpError(new Error("1305 platform overload"))).toBe(true);
  });

  it("does NOT treat gateway blips as rate limits", () => {
    expect(isRateLimitLLMError(new Error("503 temporarily unavailable"))).toBe(false);
    expect(isRateLimitLLMError(new Error("502 Bad Gateway"))).toBe(false);
    expect(isRateLimitLLMError(new Error("socket hang up"))).toBe(false);
  });
});

describe("buildZhipuRateLimitModelRotation", () => {
  it("stays on primary only (no free Flash hop)", () => {
    expect(buildZhipuRateLimitModelRotation("glm-4.7-flash")).toEqual([
      "glm-4.7-flash",
    ]);
    expect(buildZhipuRateLimitModelRotation("glm-4-flash")).toEqual([
      "glm-4-flash",
    ]);
    // Pool constant retained for docs/compat; not used in rotation.
    expect(ZHIPU_FREE_FLASH_ROTATION.length).toBeGreaterThan(0);
  });
});
