import { describe, expect, it, vi } from "vitest";
import { chatCompletion, createLLMClient } from "../llm/provider.js";

const { fetchCalls } = vi.hoisted(() => ({
  fetchCalls: [] as Array<{ url: string; body: Record<string, unknown> }>,
}));

vi.mock("../utils/proxy-fetch.js", () => ({
  fetchWithProxy: vi.fn(async (url: string, init: RequestInit) => {
    fetchCalls.push({
      url,
      body: JSON.parse(String(init.body ?? "{}")),
    });
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "你好" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    } as Response;
  }),
}));

vi.mock("@mariozechner/pi-ai", () => ({
  completeSimple: vi.fn(async () => {
    throw new Error("Agnes OpenAI-compatible requests must use InkOS native transport");
  }),
  streamSimple: vi.fn(async function* () {
    throw new Error("Agnes OpenAI-compatible requests must use InkOS native transport");
  }),
}));

describe("Agnes thinking defaults", () => {
  it("uses native transport and sends enable_thinking:false by default", async () => {
    fetchCalls.length = 0;
    const client = createLLMClient({
      provider: "openai",
      service: "agnes",
      model: "agnes-2.5-flash",
      apiKey: "sk-test",
      baseUrl: "https://apihub.agnes-ai.com/v1",
      apiFormat: "chat",
      stream: false,
      temperature: 0.7,
      thinkingBudget: 0,
      extra: {},
    } as never);

    const result = await chatCompletion(client, "agnes-2.5-flash", [
      { role: "user", content: "hi" },
    ], { retry: false });

    expect(result.content).toBe("你好");
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toContain("/chat/completions");
    expect(fetchCalls[0]?.body.enable_thinking).toBe(false);
    expect(fetchCalls[0]?.body.thinking).toBeUndefined();
  });
});
