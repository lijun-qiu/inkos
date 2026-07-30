import { useCallback, useEffect, useState } from "react";
import { postApi } from "../hooks/use-api";
import { tr } from "../lib/app-language";

export interface LocalModelStatus {
  readonly stage: "idle" | "llm" | "image";
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

const EMPTY: LocalModelStatus = {
  stage: "idle",
  ollamaOnline: false,
  comfyOnline: false,
  ollamaLoaded: [],
  ollamaModel: "qwen3.5:9b",
  ollamaModels: [],
  comfyCheckpoints: [],
  comfyCheckpoint: null,
  busy: false,
  message: "",
};

export function LocalModelBar() {
  const [status, setStatus] = useState<LocalModelStatus>(EMPTY);
  const [stage, setStage] = useState<"llm" | "image">("llm");
  const [ollamaModel, setOllamaModel] = useState("qwen3.5:9b");
  const [checkpoint, setCheckpoint] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/local-models/status");
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json() as LocalModelStatus;
      setStatus(data);
      if (data.ollamaModel) setOllamaModel(data.ollamaModel);
      if (data.comfyCheckpoint) setCheckpoint(data.comfyCheckpoint);
      setBusy(data.busy);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const ms = busy ? 2000 : 15000;
    const timer = window.setInterval(() => { void refresh(); }, ms);
    return () => window.clearInterval(timer);
  }, [refresh, busy]);

  const onLoad = async () => {
    setBusy(true);
    setError(null);
    try {
      const data = await postApi<LocalModelStatus>("/local-models/ensure", {
        stage,
        ollamaModel,
        comfyCheckpoint: checkpoint || undefined,
      });
      setStatus(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const onUnload = async () => {
    setBusy(true);
    setError(null);
    try {
      const data = await postApi<LocalModelStatus>("/local-models/stage", { stage: "idle" });
      setStatus(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const statusText = busy
    ? (status.message || tr("加载中…", "Loading…"))
    : status.ollamaLoaded.length
      ? tr(`已加载：${status.ollamaLoaded.join(", ")}`, `Loaded: ${status.ollamaLoaded.join(", ")}`)
      : status.comfyOnline && status.stage === "image"
        ? tr("ComfyUI 就绪", "ComfyUI ready")
        : tr("就绪", "Ready");

  return (
    <div className="border-b border-border/40 bg-muted/20 px-4 py-2 space-y-2 text-[13px]">
      <div className="flex flex-wrap items-center gap-3">
        <div className={`inline-flex items-center gap-2 rounded-md border border-border/50 bg-card/70 px-2.5 py-1 ${busy ? "opacity-80" : ""}`}>
          {busy && <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />}
          <span className="text-foreground/90">{statusText}</span>
        </div>
        <Chip ok={status.ollamaOnline} label="Ollama" />
        <Chip ok={status.comfyOnline} label="ComfyUI" />
        <span className="rounded-md bg-secondary/60 px-2 py-0.5 text-muted-foreground">
          {status.stage === "idle" ? "idle" : status.stage === "llm" ? `LLM · ${status.ollamaModel}` : `Image · ${status.comfyCheckpoint ?? "ComfyUI"}`}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label className="inline-flex items-center gap-1.5">
          <span className="text-muted-foreground">{tr("文本", "LLM")}</span>
          <select
            className="h-8 min-w-[10rem] rounded-md border border-border/60 bg-background px-2"
            value={ollamaModel}
            disabled={busy}
            onChange={(e) => setOllamaModel(e.target.value)}
          >
            {(status.ollamaModels.length ? status.ollamaModels : [ollamaModel]).map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </label>
        <label className="inline-flex items-center gap-1.5">
          <span className="text-muted-foreground">{tr("生图", "Image")}</span>
          <select
            className="h-8 min-w-[10rem] rounded-md border border-border/60 bg-background px-2"
            value={checkpoint}
            disabled={busy || status.comfyCheckpoints.length === 0}
            onChange={(e) => setCheckpoint(e.target.value)}
          >
            {status.comfyCheckpoints.length === 0 && (
              <option value="">{tr("（Comfy 未在线）", "(Comfy offline)")}</option>
            )}
            {status.comfyCheckpoints.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </label>

        <span className="text-muted-foreground">{tr("加载到显存", "Load VRAM")}</span>
        <select
          className="h-8 rounded-md border border-border/60 bg-background px-2"
          value={stage}
          disabled={busy}
          onChange={(e) => setStage(e.target.value as "llm" | "image")}
        >
          <option value="llm">LLM</option>
          <option value="image">{tr("生图", "Image")}</option>
        </select>
        <button
          type="button"
          disabled={busy}
          onClick={() => void onLoad()}
          className="h-8 rounded-md bg-primary px-3 font-medium text-primary-foreground disabled:opacity-50"
        >
          {busy ? tr("加载中…", "Loading…") : tr("加载", "Load")}
        </button>
        <button
          type="button"
          disabled={busy || (status.stage === "idle" && status.ollamaLoaded.length === 0)}
          onClick={() => void onUnload()}
          className="h-8 rounded-md border border-destructive/40 bg-destructive/10 px-3 font-medium text-destructive disabled:opacity-50"
        >
          {tr("卸载", "Unload")}
        </button>
      </div>

      {(error || (!status.ollamaOnline || !status.comfyOnline)) && (
        <div className="text-muted-foreground">
          {error
            ? error
            : [
                !status.ollamaOnline ? tr("Ollama 离线 — 点「加载 LLM」可自动启动", "Ollama offline — Load LLM to auto-start") : null,
                !status.comfyOnline ? tr("ComfyUI 离线 — 点「加载 生图」可自动启动", "ComfyUI offline — Load Image to auto-start") : null,
              ].filter(Boolean).join(" · ")}
        </div>
      )}
    </div>
  );
}

function Chip({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-border/50 bg-card/60 px-2 py-0.5">
      <span className={`h-2 w-2 rounded-full ${ok ? "bg-emerald-500" : "bg-rose-500"}`} />
      <span>{label}</span>
    </span>
  );
}
