#!/usr/bin/env node
/**
 * Local AIGC detection shim for InkOS (provider=custom).
 * POST /detect  body: { content: string }  →  { score: number }  // 0 human .. 1 AI
 *
 * Env:
 *   OLLAMA_URL           default http://127.0.0.1:11434
 *   DETECT_MODEL         default qwen3.5:9b
 *   DETECT_PROXY_PORT    default 8791
 */
import http from "node:http";

const OLLAMA_URL = (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/+$/, "");
const MODEL = process.env.DETECT_MODEL || "qwen3.5:9b";
const PORT = Number(process.env.DETECT_PROXY_PORT || 8791);

function json(res, status, body) {
  const raw = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(raw),
  });
  res.end(raw);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function clampScore(n) {
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

function extractScore(text) {
  const m = String(text || "").match(/([01](?:\.\d+)?)/);
  if (!m) return 0.5;
  return clampScore(Number(m[1]));
}

async function scoreContent(content) {
  const sample = String(content || "").slice(0, 6000);
  const prompt = [
    "You are an AI-writing detector. Score how likely the text was written by an AI.",
    "Return ONLY a number between 0 and 1 (0=human, 1=AI). No other words.",
    "",
    "TEXT:",
    sample,
  ].join("\n");

  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      options: { temperature: 0 },
      messages: [
        { role: "system", content: "Reply with a single float in [0,1] only." },
        { role: "user", content: prompt },
      ],
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${text.slice(0, 300)}`);
  const data = JSON.parse(text);
  const reply = data?.message?.content ?? data?.response ?? "";
  return extractScore(reply);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, { ok: true, model: MODEL, ollama: OLLAMA_URL });
    }
    if (req.method === "POST" && (url.pathname === "/detect" || url.pathname === "/")) {
      const body = await readBody(req);
      const score = await scoreContent(body.content ?? body.document ?? "");
      return json(res, 200, { score });
    }
    json(res, 404, { error: "Not found" });
  } catch (e) {
    json(res, 500, { error: String(e.message || e), score: 0.5 });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[local-aigc-detector] http://127.0.0.1:${PORT}/detect  model=${MODEL}`);
});
