import { afterEach, describe, expect, it, vi } from "vitest";

const proxyAgentMock = vi.fn((opts: string | { uri: string }) => ({
  kind: "proxy-agent",
  url: typeof opts === "string" ? opts : opts.uri,
  close: vi.fn(async () => undefined),
}));

vi.mock("undici", () => ({
  ProxyAgent: proxyAgentMock,
}));

describe("proxy fetch helpers", () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("prefers explicit llm proxyUrl over environment proxy variables", async () => {
    const { fetchWithProxy, resolveProxyUrl, resetLlmProxyAgents } = await import("../utils/proxy-fetch.js");
    resetLlmProxyAgents();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const env = {
      INKOS_LLM_PROXY_URL: "http://inkos-env-proxy:9910",
      HTTPS_PROXY: "http://standard-proxy:9910",
    };

    expect(resolveProxyUrl("http://explicit-proxy:9910", env)).toBe("http://explicit-proxy:9910");
    await fetchWithProxy("https://api.example/v1/chat/completions", { method: "POST" }, "http://explicit-proxy:9910", env);

    expect(proxyAgentMock).toHaveBeenCalledWith(expect.objectContaining({
      uri: "http://explicit-proxy:9910",
      connectTimeout: 20_000,
      headersTimeout: 120_000,
      bodyTimeout: 0,
    }));
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        dispatcher: expect.objectContaining({ kind: "proxy-agent" }),
      }),
    );
  });

  it("reuses one ProxyAgent per proxy URL", async () => {
    const { fetchWithProxy, resetLlmProxyAgents } = await import("../utils/proxy-fetch.js");
    resetLlmProxyAgents();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    await fetchWithProxy("https://api.example/a", {}, "http://proxy:7890", {});
    await fetchWithProxy("https://api.example/b", {}, "http://proxy:7890", {});

    expect(proxyAgentMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.dispatcher).toBe(fetchMock.mock.calls[1]?.[1]?.dispatcher);
  });

  it("resetLlmProxyAgents forces a fresh tunnel on the next request", async () => {
    const { fetchWithProxy, resetLlmProxyAgents } = await import("../utils/proxy-fetch.js");
    resetLlmProxyAgents();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    await fetchWithProxy("https://api.example/a", {}, "http://proxy:7890", {});
    resetLlmProxyAgents();
    await fetchWithProxy("https://api.example/b", {}, "http://proxy:7890", {});

    expect(proxyAgentMock).toHaveBeenCalledTimes(2);
  });

  it("uses INKOS_LLM_PROXY_URL before standard HTTPS_PROXY/HTTP_PROXY env vars", async () => {
    const { fetchWithProxy, resolveProxyUrl, resetLlmProxyAgents } = await import("../utils/proxy-fetch.js");
    resetLlmProxyAgents();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const env = {
      INKOS_LLM_PROXY_URL: "http://inkos-proxy:9910",
      HTTPS_PROXY: "http://standard-proxy:9910",
      HTTP_PROXY: "http://http-proxy:9910",
    };

    expect(resolveProxyUrl(undefined, env)).toBe("http://inkos-proxy:9910");
    await fetchWithProxy("https://api.example/v1/models", {}, undefined, env);

    expect(proxyAgentMock).toHaveBeenCalledWith(expect.objectContaining({
      uri: "http://inkos-proxy:9910",
    }));
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example/v1/models",
      expect.objectContaining({
        dispatcher: expect.objectContaining({ kind: "proxy-agent" }),
      }),
    );
  });

  it("does not attach a dispatcher when no proxy is configured", async () => {
    const { fetchWithProxy, resolveProxyUrl, resetLlmProxyAgents } = await import("../utils/proxy-fetch.js");
    resetLlmProxyAgents();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    expect(resolveProxyUrl(undefined, {})).toBeUndefined();
    await fetchWithProxy("https://api.example/v1/models", { headers: { Authorization: "Bearer test" } }, undefined, {});

    expect(proxyAgentMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example/v1/models",
      { headers: { Authorization: "Bearer test" } },
    );
  });

  it("skips INKOS_LLM_PROXY_URL for domestic DeepSeek/Agnes and local proxy base URLs", async () => {
    const { fetchWithProxy, resolveProxyUrl, resetLlmProxyAgents } = await import("../utils/proxy-fetch.js");
    resetLlmProxyAgents();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const env = { INKOS_LLM_PROXY_URL: "http://127.0.0.1:7890" };
    expect(resolveProxyUrl(undefined, env, "https://api.deepseek.com/chat/completions")).toBeUndefined();
    expect(resolveProxyUrl(undefined, env, "https://apihub.agnes-ai.com/v1/images/generations")).toBeUndefined();
    expect(resolveProxyUrl(undefined, env, "http://127.0.0.1:9999/v1/chat/completions")).toBeUndefined();

    await fetchWithProxy("https://api.deepseek.com/chat/completions", { method: "POST" }, undefined, env);
    expect(proxyAgentMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.deepseek.com/chat/completions",
      { method: "POST" },
    );
  });

  it("skips explicit llm.proxyUrl for domestic Agnes/DeepSeek hosts", async () => {
    const { fetchWithProxy, resolveProxyUrl, resetLlmProxyAgents } = await import("../utils/proxy-fetch.js");
    resetLlmProxyAgents();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const clash = "http://127.0.0.1:7890";
    expect(resolveProxyUrl(clash, {}, "https://apihub.agnes-ai.com/v1/chat/completions")).toBeUndefined();
    expect(resolveProxyUrl(clash, {}, "https://api.deepseek.com/chat/completions")).toBeUndefined();
    // Overseas hosts still honor explicit proxy.
    expect(resolveProxyUrl(clash, {}, "https://openrouter.ai/api/v1/chat/completions")).toBe(clash);

    await fetchWithProxy(
      "https://apihub.agnes-ai.com/v1/chat/completions",
      { method: "POST" },
      clash,
      {},
    );
    expect(proxyAgentMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://apihub.agnes-ai.com/v1/chat/completions",
      { method: "POST" },
    );
  });
});
