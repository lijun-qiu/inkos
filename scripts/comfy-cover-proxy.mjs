#!/usr/bin/env node
/**
 * OpenAI-compatible /v1/images/generations → ComfyUI API bridge for InkOS covers.
 *
 * Env:
 *   COMFY_URL          default http://127.0.0.1:8188
 *   COMFY_CHECKPOINT   default checkpoint filename (e.g. model.safetensors)
 *   COMFY_STEPS        default 20
 *   COMFY_CFG          default 7
 *   COMFY_SAMPLER      default euler
 *   COMFY_SCHEDULER    default normal
 *   COMFY_NEGATIVE     default negative prompt
 *   COVER_PROXY_PORT   default 8788
 *
 * InkOS:
 *   INKOS_COVER_BASE_URL=http://127.0.0.1:8788/v1
 *   INKOS_COVER_MODEL=<checkpoint filename or leave blank to use COMFY_CHECKPOINT>
 *   INKOS_COVER_API_KEY=local
 */
import http from "node:http";
import { randomInt } from "node:crypto";

const COMFY_URL = (process.env.COMFY_URL || "http://127.0.0.1:8188").replace(/\/+$/, "");
const PORT = Number(process.env.COVER_PROXY_PORT || 8788);
const DEFAULT_CKPT = process.env.COMFY_CHECKPOINT || "";
const STEPS = Number(process.env.COMFY_STEPS || 20);
const CFG = Number(process.env.COMFY_CFG || 7);
const SAMPLER = process.env.COMFY_SAMPLER || "euler";
const SCHEDULER = process.env.COMFY_SCHEDULER || "normal";
const NEGATIVE = process.env.COMFY_NEGATIVE
  || "lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, jpeg artifacts, signature, watermark, username, blurry";

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

function parseSize(size) {
  const m = String(size || "1024x1360").match(/^(\d+)\s*[xX×]\s*(\d+)$/);
  if (!m) return { width: 1024, height: 1360 };
  return {
    width: Math.max(64, Math.min(2048, Number(m[1]))),
    height: Math.max(64, Math.min(2048, Number(m[2]))),
  };
}

async function comfyFetch(path, init) {
  const res = await fetch(`${COMFY_URL}${path}`, init);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`ComfyUI ${path} HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function listCheckpoints() {
  try {
    const models = await comfyFetch("/models/checkpoints");
    if (Array.isArray(models) && models.length) return models.map(String);
  } catch {
    // older ComfyUI
  }
  const info = await comfyFetch("/object_info/CheckpointLoaderSimple");
  const values = info?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0];
  return Array.isArray(values) ? values.map(String) : [];
}

function buildWorkflow({ ckpt, prompt, negative, width, height, seed }) {
  return {
    "3": {
      class_type: "KSampler",
      inputs: {
        seed,
        steps: STEPS,
        cfg: CFG,
        sampler_name: SAMPLER,
        scheduler: SCHEDULER,
        denoise: 1,
        model: ["4", 0],
        positive: ["6", 0],
        negative: ["7", 0],
        latent_image: ["5", 0],
      },
    },
    "4": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: ckpt },
    },
    "5": {
      class_type: "EmptyLatentImage",
      inputs: { width, height, batch_size: 1 },
    },
    "6": {
      class_type: "CLIPTextEncode",
      inputs: { text: prompt, clip: ["4", 1] },
    },
    "7": {
      class_type: "CLIPTextEncode",
      inputs: { text: negative, clip: ["4", 1] },
    },
    "8": {
      class_type: "VAEDecode",
      inputs: { samples: ["3", 0], vae: ["4", 2] },
    },
    "9": {
      class_type: "SaveImage",
      inputs: { filename_prefix: "inkos_cover", images: ["8", 0] },
    },
  };
}

async function waitForImage(promptId, timeoutMs = 300_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const history = await comfyFetch(`/history/${promptId}`);
    const entry = history?.[promptId];
    if (entry?.status?.completed || entry?.outputs) {
      const images = entry.outputs?.["9"]?.images;
      if (Array.isArray(images) && images[0]) return images[0];
      if (entry.status?.status_str === "error") {
        throw new Error(`ComfyUI job failed: ${JSON.stringify(entry.status).slice(0, 400)}`);
      }
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  throw new Error(`ComfyUI timed out waiting for prompt ${promptId}`);
}

async function fetchImageBase64(imageInfo) {
  const qs = new URLSearchParams({
    filename: imageInfo.filename,
    subfolder: imageInfo.subfolder || "",
    type: imageInfo.type || "output",
  });
  const res = await fetch(`${COMFY_URL}/view?${qs}`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ComfyUI /view HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.toString("base64");
}

async function resolveCheckpoint(requested) {
  const checkpoints = await listCheckpoints();
  if (!checkpoints.length) {
    throw new Error(`No checkpoints found on ComfyUI at ${COMFY_URL}. Put .safetensors under models/checkpoints and restart ComfyUI.`);
  }
  const want = (requested || DEFAULT_CKPT || "").trim();
  if (!want || want === "comfy" || want === "default") return checkpoints[0];
  const exact = checkpoints.find((c) => c === want);
  if (exact) return exact;
  const loose = checkpoints.find((c) => c.toLowerCase().includes(want.toLowerCase()));
  if (loose) return loose;
  throw new Error(`Checkpoint "${want}" not found. Available: ${checkpoints.slice(0, 20).join(", ")}`);
}

async function generateImage(body) {
  const prompt = String(body.prompt || "").trim();
  if (!prompt) throw new Error("prompt is required");
  const { width, height } = parseSize(body.size);
  const ckpt = await resolveCheckpoint(body.model);
  const seed = randomInt(0, 2_147_483_647);
  const workflow = buildWorkflow({
    ckpt,
    prompt,
    negative: NEGATIVE,
    width,
    height,
    seed,
  });

  const queued = await comfyFetch("/prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: workflow }),
  });
  const promptId = queued?.prompt_id;
  if (!promptId) throw new Error(`ComfyUI queue returned no prompt_id: ${JSON.stringify(queued).slice(0, 300)}`);

  const imageInfo = await waitForImage(promptId);
  const b64 = await fetchImageBase64(imageInfo);
  return {
    created: Math.floor(Date.now() / 1000),
    data: [{ b64_json: b64 }],
    model: ckpt,
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
    if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/v1/health")) {
      try {
        const ckpts = await listCheckpoints();
        return json(res, 200, { ok: true, comfy: COMFY_URL, checkpoints: ckpts.length, default: ckpts[0] || null });
      } catch (e) {
        return json(res, 503, { ok: false, comfy: COMFY_URL, error: String(e.message || e) });
      }
    }
    if (req.method === "GET" && url.pathname === "/v1/models") {
      const ckpts = await listCheckpoints();
      return json(res, 200, {
        object: "list",
        data: ckpts.map((id) => ({ id, object: "model", owned_by: "comfyui" })),
      });
    }
    if (req.method === "POST" && url.pathname === "/v1/images/generations") {
      const body = await readBody(req);
      const out = await generateImage(body);
      return json(res, 200, out);
    }
    json(res, 404, { error: { message: `Not found: ${req.method} ${url.pathname}` } });
  } catch (e) {
    json(res, 500, { error: { message: String(e.message || e) } });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[comfy-cover-proxy] http://127.0.0.1:${PORT}/v1  →  ${COMFY_URL}`);
  console.log(`[comfy-cover-proxy] set INKOS_COVER_BASE_URL=http://127.0.0.1:${PORT}/v1`);
});
