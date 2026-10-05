import { ProxyAgent } from "undici";

type ProxyEnv = Record<string, string | undefined>;
type FetchInitWithDispatcher = RequestInit & { dispatcher?: unknown };

const proxyAgents = new Map<string, ProxyAgent>();

/** Domestic / local upstream hosts that should never use Clash-style proxies. */
const DIRECT_LLM_HOSTS = new Set([
  "api.deepseek.com",
  "api-inference.modelscope.cn",
  "apihub.agnes-ai.com",
]);

function resolveFetchTargetUrl(input: Parameters<typeof fetch>[0]): string | undefined {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (typeof input === "object" && input !== null && "url" in input) {
    return String((input as Request).url);
  }
  return undefined;
}

export function shouldBypassEnvProxyForUrl(targetUrl: string | undefined): boolean {
  if (!targetUrl) return false;
  try {
    const { hostname } = new URL(targetUrl);
    const host = hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
    return DIRECT_LLM_HOSTS.has(host);
  } catch {
    return false;
  }
}

export function resolveProxyUrl(
  explicitProxyUrl?: string,
  env: ProxyEnv = process.env,
  targetUrl?: string,
): string | undefined {
  // Domestic/local upstreams must never go through Clash-style proxies — even when
  // INKOS_LLM_PROXY_URL was copied onto llm.proxyUrl and passed as explicitProxyUrl.
  if (shouldBypassEnvProxyForUrl(targetUrl)) {
    return undefined;
  }

  if (typeof explicitProxyUrl === "string" && explicitProxyUrl.trim().length > 0) {
    return explicitProxyUrl.trim();
  }

  const candidate = [
    env.INKOS_LLM_PROXY_URL,
    env.HTTPS_PROXY,
    env.https_proxy,
    env.HTTP_PROXY,
    env.http_proxy,
  ].find((value) => typeof value === "string" && value.trim().length > 0)?.trim();

  if (!candidate) return undefined;
  const parsed = new URL(candidate);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported proxy protocol: ${parsed.protocol}`);
  }
  return candidate;
}

/**
 * Proxy agent tuned for LLM traffic through flaky local proxies (Clash/FlClash):
 * - fail connect fast so withTransientLLMRetry can rewrite
 * - wait a bit for upstream headers (free queues)
 * - never idle-kill the body (Ultra streams can pause between thinking chunks)
 * - reuse one agent per proxy URL so TCP/TLS through Clash is not re-handshaken every call
 */
export function createLlmProxyAgent(proxyUrl: string): ProxyAgent {
  return new ProxyAgent({
    uri: proxyUrl,
    connect: { timeout: 20_000 },
    connectTimeout: 20_000,
    headersTimeout: 120_000,
    bodyTimeout: 0,
    keepAliveTimeout: 30_000,
    keepAliveMaxTimeout: 60_000,
  });
}

export function getLlmProxyAgent(proxyUrl: string): ProxyAgent {
  const existing = proxyAgents.get(proxyUrl);
  if (existing) return existing;
  const agent = createLlmProxyAgent(proxyUrl);
  proxyAgents.set(proxyUrl, agent);
  return agent;
}

/**
 * Drop cached proxy agents so the next request opens a fresh tunnel.
 * Call after transport/connect blips — Clash often leaves a half-dead keep-alive socket.
 */
export function resetLlmProxyAgents(): void {
  for (const agent of proxyAgents.values()) {
    try {
      void agent.close();
    } catch {
      // best-effort
    }
  }
  proxyAgents.clear();
}

export function buildProxyFetchInit(
  init: RequestInit = {},
  explicitProxyUrl?: string,
  env: ProxyEnv = process.env,
  targetUrl?: string,
): FetchInitWithDispatcher {
  const proxyUrl = resolveProxyUrl(explicitProxyUrl, env, targetUrl);
  if (!proxyUrl) return init;
  return {
    ...init,
    dispatcher: getLlmProxyAgent(proxyUrl),
  };
}

export function fetchWithProxy(
  input: Parameters<typeof fetch>[0],
  init: RequestInit = {},
  explicitProxyUrl?: string,
  env: ProxyEnv = process.env,
): ReturnType<typeof fetch> {
  const targetUrl = resolveFetchTargetUrl(input);
  return fetch(input, buildProxyFetchInit(init, explicitProxyUrl, env, targetUrl));
}
