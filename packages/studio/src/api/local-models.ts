/**
 * Local model manager for InkOS Studio — Ollama LLM + ComfyUI image,
 * patterned after huobao-drama's local-model-manager / local-service-starter.
 */
import { spawn, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";

export type LocalModelStage = "idle" | "llm" | "image";

export interface LocalModelStatus {
  readonly stage: LocalModelStage;
  readonly ollamaOnline: boolean;
  readonly comfyOnline: boolean;
  readonly ollamaLoaded: readonly string[];
  readonly ollamaModel: string;
  readonly ollamaModels: readonly string[];
  readonly comfyCheckpoints: readonly string[];
  readonly comfyCheckpoint: string | null;
  readonly busy: boolean;
  readonly message: string;
}

const OLLAMA_BASE = (process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/+$/, "");
const COMFY_BASE = (process.env.COMFYUI_BASE_URL || "http://127.0.0.1:8188").replace(/\/+$/, "");
const DEFAULT_LLM = process.env.INKOS_LOCAL_LLM_MODEL || process.env.OLLAMA_TEXT_MODEL || "qwen3.5:9b";
const START_TIMEOUT_MS = 120_000;
const POLL_MS = 2_000;

let currentStage: LocalModelStage = "idle";
let preferredLlm = DEFAULT_LLM;
let preferredCheckpoint: string | null = null;
let busy = false;
let lastMessage = "";

function spawnDetached(command: string, args: string[], opts?: { cwd?: string }) {
  // On Windows, shell:true + absolute .exe paths often fails silently.
  // Prefer direct spawn for absolute executables; fall back to shell for bare commands.
  const useShell = process.platform === "win32" && !/[\\/]/.test(command) && !command.endsWith(".exe");
  const child = spawn(command, args, {
    cwd: opts?.cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    shell: useShell,
    windowsHide: true,
  });
  child.on("error", (err) => {
    console.warn(`[local-models] spawn error (${command}):`, err.message);
  });
  child.unref();
}

async function waitUntil(check: () => Promise<boolean>): Promise<boolean> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  return false;
}

async function checkOllamaOnline(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: AbortSignal.timeout(5_000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function checkComfyOnline(): Promise<boolean> {
  try {
    const res = await fetch(`${COMFY_BASE}/system_stats`, { signal: AbortSignal.timeout(5_000) });
    return res.ok;
  } catch {
    return false;
  }
}

function resolveOllamaExe(): string {
  const candidates = [
    process.env.OLLAMA_EXE,
    join(process.env.LOCALAPPDATA || "", "Programs", "Ollama", "ollama.exe"),
    "C:\\my\\ollama\\bin\\ollama.exe",
    "ollama",
  ].filter(Boolean) as string[];
  for (const exe of candidates) {
    if (exe === "ollama") return exe;
    if (existsSync(exe)) return exe;
  }
  return "ollama";
}

function resolveComfyRoot(): string {
  return process.env.COMFYUI_ROOT || "C:\\my\\comfyui\\ComfyUI";
}

export async function ensureOllamaRunning(): Promise<void> {
  if (await checkOllamaOnline()) return;
  const exe = resolveOllamaExe();
  spawnDetached(exe, ["serve"]);
  if (!(await waitUntil(checkOllamaOnline))) {
    throw new Error(`Ollama 启动超时（${exe}）。请手动运行 ollama serve`);
  }
}

export async function ensureComfyUIRunning(): Promise<void> {
  if (await checkComfyOnline()) return;
  const root = resolveComfyRoot();
  if (!existsSync(join(root, "main.py"))) {
    throw new Error(`未找到 ComfyUI：${join(root, "main.py")}。请设置 COMFYUI_ROOT 或手动启动`);
  }
  const pythonCandidates = [
    process.env.COMFYUI_PYTHON,
    join(root, "..", "venv", "Scripts", "python.exe"),
    join("C:\\my\\comfyui", "venv", "Scripts", "python.exe"),
    "python",
  ].filter(Boolean) as string[];
  const extraArgs = String(process.env.COMFYUI_EXTRA_ARGS || "")
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const args = ["main.py", "--listen", "127.0.0.1", "--port", "8188", ...extraArgs];
  let started = false;
  for (const python of pythonCandidates) {
    try {
      spawnDetached(python, args, { cwd: root });
      started = true;
      break;
    } catch {
      // try next
    }
  }
  if (!started) throw new Error("无法启动 ComfyUI，请设置 COMFYUI_ROOT / COMFYUI_PYTHON");
  if (!(await waitUntil(checkComfyOnline))) {
    throw new Error("ComfyUI 启动超时，请手动启动（默认 http://127.0.0.1:8188）");
  }
}

async function listOllamaModels(): Promise<string[]> {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return [];
    const data = await res.json() as { models?: Array<{ name?: string }> };
    return (data.models ?? []).map((m) => m.name).filter((n): n is string => Boolean(n));
  } catch {
    return [];
  }
}

async function listLoadedOllamaModels(): Promise<string[]> {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/ps`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return [];
    const data = await res.json() as { models?: Array<{ name?: string; model?: string }> };
    return (data.models ?? [])
      .map((m) => m.name || m.model)
      .filter((n): n is string => Boolean(n));
  } catch {
    return [];
  }
}

async function listComfyCheckpoints(): Promise<string[]> {
  try {
    const res = await fetch(`${COMFY_BASE}/models/checkpoints`, { signal: AbortSignal.timeout(8_000) });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data)) return data.map(String);
    }
  } catch {
    // fall through
  }
  try {
    const res = await fetch(`${COMFY_BASE}/object_info/CheckpointLoaderSimple`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return [];
    const info = await res.json() as {
      CheckpointLoaderSimple?: { input?: { required?: { ckpt_name?: [string[]] } } };
    };
    const values = info?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0];
    return Array.isArray(values) ? values.map(String) : [];
  } catch {
    return [];
  }
}

export async function preloadOllamaModel(model: string): Promise<void> {
  const numCtx = Number.parseInt(process.env.OLLAMA_NUM_CTX ?? "", 10);
  const targetCtx = Number.isFinite(numCtx) && numCtx > 0 ? numCtx : 32_768;

  try {
    const psRes = await fetch(`${OLLAMA_BASE}/api/ps`, { signal: AbortSignal.timeout(10_000) });
    if (psRes.ok) {
      const ps = await psRes.json() as {
        models?: Array<{ name?: string; model?: string; context_length?: number }>;
      };
      const loaded = ps.models?.find((m) => m.name === model || m.model === model);
      if (loaded && (loaded.context_length ?? 0) >= targetCtx) return;
      if (loaded) {
        await fetch(`${OLLAMA_BASE}/api/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model, prompt: "", keep_alive: 0 }),
          signal: AbortSignal.timeout(60_000),
        });
      }
    }
  } catch {
    // continue to load
  }

  // Prefer /api/chat so num_ctx actually applies (OpenAI /v1 ignores it).
  const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "." }],
      stream: false,
      keep_alive: "30m",
      options: { num_ctx: targetCtx },
    }),
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`加载 Ollama 模型失败: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
}

export async function unloadOllamaModels(models?: readonly string[]): Promise<void> {
  const targets = models?.length ? models : await listLoadedOllamaModels();
  await Promise.all(
    targets.map(async (model) => {
      try {
        await fetch(`${OLLAMA_BASE}/api/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model, prompt: "", keep_alive: 0 }),
          signal: AbortSignal.timeout(60_000),
        });
      } catch {
        // ignore per-model unload errors
      }
    }),
  );
}

export async function freeComfyUIMemory(): Promise<void> {
  try {
    await fetch(`${COMFY_BASE}/interrupt`, { method: "POST", signal: AbortSignal.timeout(5_000) });
  } catch {
    // ignore
  }
  try {
    await fetch(`${COMFY_BASE}/free`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    // ignore
  }
}

export async function getLocalModelStatus(): Promise<LocalModelStatus> {
  const [ollamaOnline, comfyOnline] = await Promise.all([checkOllamaOnline(), checkComfyOnline()]);
  const [ollamaModels, ollamaLoaded, comfyCheckpoints] = await Promise.all([
    ollamaOnline ? listOllamaModels() : Promise.resolve([] as string[]),
    ollamaOnline ? listLoadedOllamaModels() : Promise.resolve([] as string[]),
    comfyOnline ? listComfyCheckpoints() : Promise.resolve([] as string[]),
  ]);
  if (!preferredCheckpoint && comfyCheckpoints[0]) preferredCheckpoint = comfyCheckpoints[0];
  return {
    stage: currentStage,
    ollamaOnline,
    comfyOnline,
    ollamaLoaded,
    ollamaModel: preferredLlm,
    ollamaModels,
    comfyCheckpoints,
    comfyCheckpoint: preferredCheckpoint,
    busy,
    message: lastMessage,
  };
}

export async function setLocalModelStage(
  stage: LocalModelStage,
  options?: { readonly ollamaModel?: string; readonly comfyCheckpoint?: string },
): Promise<LocalModelStatus> {
  if (options?.ollamaModel) preferredLlm = options.ollamaModel;
  if (options?.comfyCheckpoint) preferredCheckpoint = options.comfyCheckpoint;

  if (stage === "idle") {
    busy = true;
    lastMessage = "正在卸载本地模型…";
    try {
      await unloadOllamaModels();
      if (await checkComfyOnline()) await freeComfyUIMemory();
      currentStage = "idle";
      lastMessage = "已卸载本地模型，显存已释放";
    } finally {
      busy = false;
    }
    return getLocalModelStatus();
  }

  // Switching stages: unload the other side first (GPU mutual exclusion)
  busy = true;
  lastMessage = stage === "llm" ? "正在准备 LLM…" : "正在准备 ComfyUI…";
  try {
    if (stage === "llm") {
      if (await checkComfyOnline()) await freeComfyUIMemory();
      currentStage = "llm";
      lastMessage = `已切到 LLM（未预热）：${preferredLlm}`;
    } else {
      await unloadOllamaModels();
      currentStage = "image";
      lastMessage = "已切到生图阶段（未确保 Comfy 在线）";
    }
  } finally {
    busy = false;
  }
  return getLocalModelStatus();
}

export async function ensureLocalModelStage(
  stage: Exclude<LocalModelStage, "idle">,
  options?: { readonly ollamaModel?: string; readonly comfyCheckpoint?: string },
): Promise<LocalModelStatus> {
  if (options?.ollamaModel) preferredLlm = options.ollamaModel;
  if (options?.comfyCheckpoint) preferredCheckpoint = options.comfyCheckpoint;

  busy = true;
  lastMessage = stage === "llm" ? `正在加载 ${preferredLlm}…` : "正在启动 / 连接 ComfyUI…";
  try {
    if (stage === "llm") {
      if (await checkComfyOnline()) await freeComfyUIMemory();
      await ensureOllamaRunning();
      await preloadOllamaModel(preferredLlm);
      currentStage = "llm";
      lastMessage = `已加载：${preferredLlm}`;
    } else {
      await unloadOllamaModels();
      await ensureComfyUIRunning();
      const ckpts = await listComfyCheckpoints();
      if (!preferredCheckpoint && ckpts[0]) preferredCheckpoint = ckpts[0];
      currentStage = "image";
      lastMessage = preferredCheckpoint
        ? `ComfyUI 就绪，默认 checkpoint：${preferredCheckpoint}`
        : "ComfyUI 就绪（未发现 checkpoint）";
    }
  } catch (e) {
    lastMessage = String((e as Error).message || e);
    throw e;
  } finally {
    busy = false;
  }
  return getLocalModelStatus();
}

export function registerLocalModelRoutes(app: Hono): void {
  app.get("/api/v1/local-models/status", async (c) => {
    return c.json(await getLocalModelStatus());
  });

  app.post("/api/v1/local-models/stage", async (c) => {
    const body = await c.req.json().catch(() => ({})) as {
      stage?: string;
      ollamaModel?: string;
      comfyCheckpoint?: string;
    };
    const stage = body.stage as LocalModelStage;
    if (stage !== "idle" && stage !== "llm" && stage !== "image") {
      return c.json({ error: "stage must be idle | llm | image" }, 400);
    }
    try {
      const status = await setLocalModelStage(stage, {
        ollamaModel: body.ollamaModel,
        comfyCheckpoint: body.comfyCheckpoint,
      });
      return c.json(status);
    } catch (e) {
      return c.json({ error: String((e as Error).message || e) }, 500);
    }
  });

  app.post("/api/v1/local-models/ensure", async (c) => {
    const body = await c.req.json().catch(() => ({})) as {
      stage?: string;
      ollamaModel?: string;
      comfyCheckpoint?: string;
    };
    if (body.stage !== "llm" && body.stage !== "image") {
      return c.json({ error: "ensure stage must be llm | image" }, 400);
    }
    try {
      const status = await ensureLocalModelStage(body.stage, {
        ollamaModel: body.ollamaModel,
        comfyCheckpoint: body.comfyCheckpoint,
      });
      return c.json(status);
    } catch (e) {
      return c.json({ error: String((e as Error).message || e), ...(await getLocalModelStatus()) }, 500);
    }
  });
}

/** Kill whatever holds Comfy port then start again — used when free() is not enough. */
export async function restartComfyUI(): Promise<void> {
  try {
    await freeComfyUIMemory();
  } catch {
    // ignore
  }
  if (process.platform === "win32") {
    try {
      execSync(
        "powershell -NoProfile -Command \"Get-NetTCPConnection -LocalPort 8188 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }\"",
        { stdio: "ignore", timeout: 20_000 },
      );
    } catch {
      // ignore
    }
  }
  await new Promise((r) => setTimeout(r, 2_000));
  await ensureComfyUIRunning();
}
