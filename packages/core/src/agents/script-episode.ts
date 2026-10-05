import { BaseAgent } from "./base.js";
import {
  renderScriptSpec,
  type ScriptCreationInput,
} from "./script-storyboard.js";

/** ~3k chars/ep keeps vertical-drama scenes dense without ballooning wave tokens. */
export const SCRIPT_DEFAULT_CHARS_PER_EPISODE = 3000;
export const SCRIPT_DEFAULT_WORDS_PER_EPISODE_EN = 2000;
export const SCRIPT_DEFAULT_EPISODES = 12;
export const SCRIPT_MIN_EPISODES = 8;
/** Cap inferred count so long novels don't spawn 80-wave runs that feel stuck. */
export const SCRIPT_MAX_EPISODES = 50;
/** 10 eps/wave: fewer LLM round-trips than 8, less truncation risk than 20. */
export const SCRIPT_EPISODE_WAVE_SIZE = 10;
export const SCRIPT_DRAFT_COMPLETION_ATTEMPTS = 6;
export const SCRIPT_WAVE_MAX_OUTPUT_TOKENS = 80_000;
/**
 * Full novel source is passed into outline/wave/fill calls (no head/tail clip).
 * Kept as Infinity so callers that still pass an explicit finite cap can opt in.
 */
export const SCRIPT_SOURCE_CONTEXT_CHARS = Number.POSITIVE_INFINITY;

export interface ScriptEpisodePlan {
  readonly episodeCount: number;
  readonly charsPerEpisode: number;
  readonly targetLength?: number;
}

export interface ScriptEpisodeDraft {
  readonly number: number;
  readonly title: string;
  readonly content: string;
  readonly charCount: number;
}

export interface ScriptBatchDraft {
  readonly title: string;
  readonly episodes: readonly ScriptEpisodeDraft[];
  readonly rawContent: string;
}

export interface ScriptEpisodeWaveInput extends ScriptCreationInput {
  readonly episodeCount: number;
  readonly charsPerEpisode: number;
  readonly outlineMarkdown: string;
  readonly startEpisode: number;
  readonly endEpisode: number;
  readonly priorDraft?: ScriptBatchDraft;
}

export interface ScriptEpisodeOutlineInput extends ScriptCreationInput {
  readonly episodeCount: number;
  readonly charsPerEpisode: number;
}

export interface ScriptEpisodeContinueInput extends ScriptCreationInput {
  readonly episodeCount: number;
  readonly charsPerEpisode: number;
  readonly outlineMarkdown: string;
  readonly draft: ScriptBatchDraft;
}

export class ScriptEpisodePipelineAgent extends BaseAgent {
  get name(): string {
    return "script-episode-pipeline";
  }

  async createEpisodeOutline(input: ScriptEpisodeOutlineInput): Promise<string> {
    const language = input.language ?? "zh";
    const response = await retryScriptCall(() => this.chat([
      { role: "system", content: buildEpisodeOutlineSystemPrompt(language) },
      { role: "user", content: buildEpisodeOutlineUserPrompt(input, language) },
    ], {
      temperature: 0.4,
      maxTokens: Math.min(32_000, Math.max(12_000, input.episodeCount * 400)),
    }), this.name, this.log);
    return response.content.trim();
  }

  async writeEpisodeWave(input: ScriptEpisodeWaveInput): Promise<ScriptBatchDraft> {
    const language = input.language ?? "zh";
    const waveSize = input.endEpisode - input.startEpisode + 1;
    const response = await retryScriptCall(() => this.chat([
      { role: "system", content: buildEpisodeWaveSystemPrompt(language) },
      { role: "user", content: buildEpisodeWaveUserPrompt(input, language) },
    ], {
      temperature: 0.55,
      maxTokens: estimateScriptWaveMaxTokens(waveSize, input.charsPerEpisode),
    }), this.name, this.log);

    const prior = input.priorDraft;
    const mergedRaw = prior
      ? `${prior.rawContent.trim()}\n\n${response.content.trim()}`
      : response.content.trim();
    return parseScriptBatchDraft(mergedRaw, {
      expectedEpisodes: input.episodeCount,
      language,
      titleFallback: input.title,
    });
  }

  async continueMissingEpisodes(input: ScriptEpisodeContinueInput): Promise<ScriptBatchDraft> {
    const language = input.language ?? "zh";
    const missing = findEmptyScriptEpisodes(input.draft).slice(0, SCRIPT_EPISODE_WAVE_SIZE);
    if (missing.length === 0) return input.draft;

    const response = await retryScriptCall(() => this.chat([
      { role: "system", content: buildEpisodeWaveSystemPrompt(language) },
      { role: "user", content: buildMissingEpisodesUserPrompt(input, missing, language) },
    ], {
      temperature: 0.6,
      maxTokens: estimateScriptWaveMaxTokens(missing.length, input.charsPerEpisode),
    }), this.name, this.log);

    return parseScriptBatchDraft(
      `${input.draft.rawContent.trim()}\n\n${response.content.trim()}`,
      {
        expectedEpisodes: input.episodeCount,
        language,
        titleFallback: input.title,
      },
    );
  }
}

export function resolveScriptEpisodePlan(options: {
  readonly requirements?: string;
  readonly episodeCount?: number;
  readonly language?: "zh" | "en";
  readonly sourceText?: string;
}): ScriptEpisodePlan {
  const language = options.language ?? "zh";
  const charsPerEpisode = language === "en"
    ? SCRIPT_DEFAULT_WORDS_PER_EPISODE_EN
    : SCRIPT_DEFAULT_CHARS_PER_EPISODE;

  if (options.episodeCount != null && Number.isFinite(options.episodeCount)) {
    return {
      episodeCount: clamp(Math.round(options.episodeCount), 1, SCRIPT_MAX_EPISODES),
      charsPerEpisode,
    };
  }

  const fromSourceChapters = countSourceChapters(options.sourceText);
  if (fromSourceChapters) {
    return {
      episodeCount: clamp(fromSourceChapters, 1, SCRIPT_MAX_EPISODES),
      charsPerEpisode,
      targetLength: fromSourceChapters * charsPerEpisode,
    };
  }

  const targetLength = parseTargetScriptLength(options.requirements, language);
  if (targetLength) {
    const inferred = Math.ceil(targetLength / charsPerEpisode);
    return {
      episodeCount: clamp(inferred, SCRIPT_MIN_EPISODES, SCRIPT_MAX_EPISODES),
      charsPerEpisode,
      targetLength,
    };
  }

  return {
    episodeCount: SCRIPT_DEFAULT_EPISODES,
    charsPerEpisode,
  };
}

export function parseScriptBatchDraft(
  rawContent: string,
  options: {
    readonly expectedEpisodes: number;
    readonly language?: "zh" | "en";
    readonly titleFallback?: string;
  },
): ScriptBatchDraft {
  const language = options.language ?? "zh";
  const fallbackTitle = options.titleFallback?.trim()
    || (language === "en" ? "Untitled Script" : "未命名剧本");
  const storyTitle = normalizeTitle(
    extractTaggedBlock(rawContent, "SCRIPT_TITLE")
    || extractFirstHeading(rawContent)
    || fallbackTitle,
  ) || fallbackTitle;

  const episodes: ScriptEpisodeDraft[] = [];
  for (let number = 1; number <= options.expectedEpisodes; number += 1) {
    const title = normalizeEpisodeTitle(
      extractTaggedBlock(rawContent, `EPISODE ${number} TITLE`)
      || extractMarkdownEpisodeTitle(rawContent, number)
      || fallbackEpisodeTitle(number, language),
      number,
      language,
    );
    const content = sanitizeEpisodeContent(
      extractLastNonEmptyTaggedBlock(rawContent, `EPISODE ${number} CONTENT`)
      || extractMarkdownEpisodeContent(rawContent, number)
      || "",
    );
    episodes.push({
      number,
      title,
      content,
      charCount: countUnits(content, language),
    });
  }

  return {
    title: storyTitle,
    episodes,
    rawContent: rawContent.trim(),
  };
}

export function findEmptyScriptEpisodes(draft: ScriptBatchDraft): number[] {
  return draft.episodes
    .filter((ep) => !ep.content.trim())
    .map((ep) => ep.number);
}

export function validateScriptDraftForFinal(draft: ScriptBatchDraft): void {
  const empty = findEmptyScriptEpisodes(draft);
  if (empty.length > 0) {
    throw new Error(`Script draft still missing episodes: ${empty.join(", ")}`);
  }
  if (draft.episodes.length === 0) {
    throw new Error("Script draft has no episodes.");
  }
}

export function renderScriptDraftMarkdown(draft: ScriptBatchDraft, language: "zh" | "en" = "zh"): string {
  const lines = [
    `=== SCRIPT_TITLE ===`,
    draft.title,
    "",
  ];
  for (const ep of draft.episodes) {
    lines.push(`=== EPISODE ${ep.number} TITLE ===`);
    lines.push(ep.title);
    lines.push(`=== EPISODE ${ep.number} CONTENT ===`);
    lines.push(ep.content.trim() || (language === "en" ? "(empty)" : "（空）"));
    lines.push("");
  }
  return lines.join("\n").trim();
}

export function assembleScriptMarkdown(
  draft: ScriptBatchDraft,
  language: "zh" | "en" = "zh",
): string {
  const last = draft.episodes.length;
  const blocks = [
    `# ${draft.title}`,
    "",
    language === "en" ? "## Script" : "## 剧本正文",
    "",
  ];
  for (const ep of draft.episodes) {
    const heading = language === "en"
      ? `### Episode ${ep.number} ${ep.title}`.trim()
      : `### 第${ep.number}集 ${ep.title}`.trim();
    let body = ep.content.trim();
    if (ep.number < last) {
      body = stripScriptFinaleMarkers(body);
    } else {
      body = ensureSingleFinale(body, language);
    }
    blocks.push(heading, "", body, "", "---", "");
  }
  return `${blocks.join("\n").replace(/\n---\n\s*$/u, "\n").trim()}\n`;
}

export function stripScriptFinaleMarkers(text: string): string {
  return text
    .replace(/^[（(]?\s*全剧终\s*[）)]?\s*$/gmu, "")
    .replace(/^[（(]?\s*(?:本剧完|剧终|完)\s*[）)]?\s*$/gmu, "")
    .replace(/^(?:The\s+End|END|Fin)\s*$/gmu, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function countFilledEpisodes(draft: ScriptBatchDraft): number {
  return draft.episodes.filter((ep) => ep.content.trim().length > 0).length;
}

export function summarizePriorEpisodes(
  draft: ScriptBatchDraft | undefined,
  language: "zh" | "en",
  maxChars = 180,
): string {
  if (!draft) return language === "en" ? "(none yet)" : "（尚无）";
  const filled = draft.episodes.filter((ep) => ep.content.trim());
  if (filled.length === 0) return language === "en" ? "(none yet)" : "（尚无）";
  return filled.map((ep) => {
    const snippet = ep.content.replace(/\s+/g, " ").trim().slice(0, maxChars);
    return language === "en"
      ? `- Episode ${ep.number} ${ep.title}: ${snippet}`
      : `- 第${ep.number}集 ${ep.title}：${snippet}`;
  }).join("\n");
}

export function clipScriptSourceForContext(
  sourceText: string | undefined,
  maxChars = SCRIPT_SOURCE_CONTEXT_CHARS,
): string {
  const text = sourceText?.trim();
  if (!text) return "";
  // Default: upload the full novel. Optional finite maxChars keeps an escape hatch.
  if (!Number.isFinite(maxChars) || text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.55);
  const tail = maxChars - head - 80;
  return [
    text.slice(0, head).trim(),
    "",
    "…[源素材过长，中间已截断以防止生成卡死；请严格依据分集大纲覆盖全部情节]…",
    "",
    text.slice(-tail).trim(),
  ].join("\n");
}

export function countSourceChapters(sourceText: string | undefined): number | undefined {
  if (!sourceText?.trim()) return undefined;
  const zh = new Set<number>();
  for (const match of sourceText.matchAll(/^#{1,3}\s*第\s*(\d+)\s*章/gmu)) {
    zh.add(Number(match[1]));
  }
  if (zh.size >= 3) return Math.max(...zh);
  const en = new Set<number>();
  for (const match of sourceText.matchAll(/^#{1,3}\s*Chapter\s+(\d+)\b/gimu)) {
    en.add(Number(match[1]));
  }
  if (en.size >= 3) return Math.max(...en);
  return undefined;
}

function buildEpisodeOutlineSystemPrompt(language: "zh" | "en"): string {
  if (language === "en") {
    return [
      "You outline a script as a numbered episode plan for production.",
      "Cover the full source arc; do not skip late-plot beats.",
      "Each episode needs conflict, characters, and an end hook.",
      "Output Markdown only. No script body yet.",
    ].join("\n");
  }
  return [
    "你负责写可执行的分集大纲，供后续按集写剧本。",
    "必须覆盖源素材全剧情弧，禁止跳过后半高潮/决战/真相揭露。",
    "每集写清冲突、人物、关键场面、集尾钩子。",
    "只输出 Markdown 大纲，不要写完整剧本正文。",
  ].join("\n");
}

function buildEpisodeOutlineUserPrompt(input: ScriptEpisodeOutlineInput, language: "zh" | "en"): string {
  const source = clipScriptSourceForContext(input.sourceText);
  if (language === "en") {
    return [
      "## Spec",
      renderScriptSpec(input),
      "",
      `## Plan: exactly ${input.episodeCount} episodes, ~${input.charsPerEpisode} words each`,
      "",
      "## Source (full novel)",
      source || "(none)",
      "",
      "## Output",
      `=== SCRIPT_OUTLINE_TITLE ===`,
      input.title,
      "",
      `List Episode 1..${input.episodeCount}. For each: title, source beats covered, conflict, cast, end hook.`,
      "If the source has numbered chapters, map episodes to those chapters without skipping late chapters.",
    ].join("\n");
  }
  return [
    "## 创作规格",
    renderScriptSpec(input),
    "",
    `## 分集计划：必须正好 ${input.episodeCount} 集，每集约 ${input.charsPerEpisode} 字`,
    "",
    "## 源素材（完整小说）",
    source || "（无）",
    "",
    "## 输出格式",
    `=== SCRIPT_OUTLINE_TITLE ===`,
    input.title,
    "",
    `按第1集…第${input.episodeCount}集列出：集标题、对应原作情节、本集冲突、人物、集尾钩子。`,
    "若源素材有章节编号，必须覆盖到最后几章，禁止只写前半再跳大结局。",
  ].join("\n");
}

function buildEpisodeWaveSystemPrompt(language: "zh" | "en"): string {
  if (language === "en") {
    return [
      "You write shootable script episodes in tagged blocks.",
      "Full scenes + dialogue; never synopsis-only.",
      "Use exact === EPISODE N TITLE/CONTENT === tags for every episode in the requested range.",
      "Do not restart the series, dump remaining outlines, or write THE END except on the final episode of the whole series.",
      "No process notes.",
    ].join("\n");
  }
  return [
    "你按集写可拍可演的剧本正文，使用固定标签块。",
    "每集必须是完整场次+对白，禁止只写梗概。",
    "严格使用 === EPISODE N TITLE === / === EPISODE N CONTENT === 标签覆盖本波要求的每一集。",
    "禁止重开系列、倾倒后续大纲；非全剧最后一集禁止写「全剧终/本剧完」。",
    "不要写流程说明或模型自述。",
  ].join("\n");
}

function buildEpisodeWaveUserPrompt(input: ScriptEpisodeWaveInput, language: "zh" | "en"): string {
  const source = clipScriptSourceForContext(input.sourceText);
  const prior = summarizePriorEpisodes(input.priorDraft, language);
  const range = `${input.startEpisode}-${input.endEpisode}`;
  const isFinalWave = input.endEpisode >= input.episodeCount;
  if (language === "en") {
    return [
      "## Spec",
      renderScriptSpec(input),
      "",
      `## Write ONLY episodes ${range} of ${input.episodeCount} (~${input.charsPerEpisode} words each)`,
      isFinalWave ? "Finale markers allowed only on the last episode." : "Do NOT write series finale markers in this wave.",
      "",
      "## Episode outline",
      input.outlineMarkdown.trim(),
      "",
      "## Prior episodes (summary)",
      prior,
      "",
      "## Source (full novel)",
      source || "(none)",
      "",
      "## Output tags (required for each episode in range)",
      `=== SCRIPT_TITLE ===`,
      input.title,
      `=== EPISODE ${input.startEpisode} TITLE ===`,
      "...",
      `=== EPISODE ${input.startEpisode} CONTENT ===`,
      "scenes / characters / action / dialogue / end hook",
    ].join("\n");
  }
  return [
    "## 创作规格",
    renderScriptSpec(input),
    "",
    `## 本波只写第 ${range} 集（共 ${input.episodeCount} 集），每集约 ${input.charsPerEpisode} 字`,
    isFinalWave ? "仅全剧最后一集可写「全剧终」。" : "本波禁止写「全剧终/本剧完」。",
    "",
    "## 分集大纲",
    input.outlineMarkdown.trim(),
    "",
    "## 已写集摘要",
    prior,
    "",
    "## 源素材（完整小说）",
    source || "（无）",
    "",
    "## 输出标签（本波每一集都必须有）",
    `=== SCRIPT_TITLE ===`,
    input.title,
    `=== EPISODE ${input.startEpisode} TITLE ===`,
    "…",
    `=== EPISODE ${input.startEpisode} CONTENT ===`,
    "场次 / 人物 / 动作 / 对白 / 集尾钩子",
    "",
    "竖屏短剧格式优先。严格承接前文，不要重开故事。",
  ].join("\n");
}

function buildMissingEpisodesUserPrompt(
  input: ScriptEpisodeContinueInput,
  missing: readonly number[],
  language: "zh" | "en",
): string {
  const source = clipScriptSourceForContext(input.sourceText);
  if (language === "en") {
    return [
      `## Fill ONLY these missing episodes: ${missing.join(", ")} of ${input.episodeCount}`,
      `~${input.charsPerEpisode} words each. Full scenes, not summaries.`,
      missing.includes(input.episodeCount)
        ? "Finale markers only if writing the final episode."
        : "No series finale markers.",
      "",
      "## Outline",
      input.outlineMarkdown.trim(),
      "",
      "## Prior summaries",
      summarizePriorEpisodes(input.draft, language),
      "",
      "## Source (full novel)",
      source || "(none)",
      "",
      "Output tagged EPISODE blocks for the missing numbers only.",
    ].join("\n");
  }
  return [
    `## 只补这些空集：${missing.join("、")}（共 ${input.episodeCount} 集）`,
    `每集约 ${input.charsPerEpisode} 字。写完整场次对白，不要梗概。`,
    missing.includes(input.episodeCount) ? "仅当补到最后一集时才可写全剧终。" : "禁止写全剧终。",
    "",
    "## 分集大纲",
    input.outlineMarkdown.trim(),
    "",
    "## 已写集摘要",
    summarizePriorEpisodes(input.draft, language),
    "",
    "## 源素材（完整小说）",
    source || "（无）",
    "",
    "只输出上述空集的 EPISODE 标签块。",
  ].join("\n");
}

function estimateScriptWaveMaxTokens(episodeCount: number, charsPerEpisode: number): number {
  const estimate = Math.ceil(episodeCount * charsPerEpisode * 2.2) + 4096;
  return Math.min(SCRIPT_WAVE_MAX_OUTPUT_TOKENS, Math.max(12_288, estimate));
}

function parseTargetScriptLength(requirements: string | undefined, language: "zh" | "en"): number | undefined {
  const text = requirements?.trim();
  if (!text) return undefined;
  if (language === "en") {
    const words = /(\d+(?:\.\d+)?)\s*k\s*words?\b/i.exec(text)
      || /(?:about|around|~)?\s*(\d{2,6})\s*words?\b/i.exec(text);
    if (words) {
      const value = Number(words[1]);
      if (!Number.isFinite(value)) return undefined;
      return /k\s*words?/i.test(words[0]!) ? Math.round(value * 1000) : Math.round(value);
    }
    return undefined;
  }
  const wan = /约?\s*(\d+(?:\.\d+)?)\s*万\s*字/.exec(text);
  if (wan) return Math.round(Number(wan[1]) * 10_000);
  const chars = /约?\s*(\d{4,7})\s*字/.exec(text);
  if (chars) return Math.round(Number(chars[1]));
  return undefined;
}

function ensureSingleFinale(text: string, language: "zh" | "en"): string {
  const cleaned = stripScriptFinaleMarkers(text);
  const marker = language === "en" ? "(The End)" : "（全剧终）";
  return `${cleaned}\n\n${marker}`.trim();
}

function extractTaggedBlock(raw: string, tag: string): string | undefined {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^\\s*===\\s*${escaped}\\s*===\\s*$`, "imu");
  const match = re.exec(raw);
  if (!match || match.index == null) return undefined;
  const start = match.index + match[0].length;
  const rest = raw.slice(start);
  const next = rest.search(/^\s*===\s*[A-Z0-9][A-Z0-9 _]*\s*===\s*$/imu);
  const body = (next >= 0 ? rest.slice(0, next) : rest).trim();
  return body || undefined;
}

function extractLastNonEmptyTaggedBlock(raw: string, tag: string): string | undefined {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^\\s*===\\s*${escaped}\\s*===\\s*$`, "gimu");
  let last: string | undefined;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) != null) {
    const start = match.index + match[0].length;
    const rest = raw.slice(start);
    const next = rest.search(/^\s*===\s*[A-Z0-9][A-Z0-9 _]*\s*===\s*$/imu);
    const body = (next >= 0 ? rest.slice(0, next) : rest).trim();
    if (body) last = body;
  }
  return last;
}

function extractFirstHeading(raw: string): string | undefined {
  const match = /^#\s+(.+)$/mu.exec(raw);
  return match?.[1]?.trim();
}

function extractMarkdownEpisodeTitle(raw: string, number: number): string | undefined {
  const re = new RegExp(
    `^#{1,4}\\s*(?:第\\s*${number}\\s*集|Episode\\s*${number})(?:\\s+(.+))?\\s*$`,
    "imu",
  );
  const match = re.exec(raw);
  return match?.[1]?.trim();
}

function extractMarkdownEpisodeContent(raw: string, number: number): string | undefined {
  const re = new RegExp(
    `^#{1,4}\\s*(?:第\\s*${number}\\s*集|Episode\\s*${number})(?:\\s+.*)?\\s*$`,
    "imu",
  );
  const match = re.exec(raw);
  if (!match || match.index == null) return undefined;
  const start = match.index + match[0].length;
  const rest = raw.slice(start);
  const next = rest.search(/^#{1,4}\s*(?:第\s*\d+\s*集|Episode\s*\d+)\b/imu);
  return (next >= 0 ? rest.slice(0, next) : rest).trim() || undefined;
}

function sanitizeEpisodeContent(content: string): string {
  return content
    .replace(/^===.*?===\s*$/gmu, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeTitle(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeEpisodeTitle(value: string, number: number, language: "zh" | "en"): string {
  const cleaned = value
    .replace(new RegExp(`^(?:第\\s*${number}\\s*集|Episode\\s*${number})\\s*[:：\\-—]?\\s*`, "iu"), "")
    .trim();
  return cleaned || fallbackEpisodeTitle(number, language);
}

function fallbackEpisodeTitle(number: number, language: "zh" | "en"): string {
  return language === "en" ? `Episode ${number}` : `第${number}集`;
}

function countUnits(text: string, language: "zh" | "en"): number {
  if (language === "en") {
    const words = text.trim().match(/[A-Za-z0-9]+(?:'[A-Za-z0-9]+)?/g);
    return words?.length ?? 0;
  }
  return text.replace(/\s+/g, "").length;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

async function retryScriptCall<T>(
  operation: () => Promise<T>,
  label: string,
  logger?: { warn(message: string): void },
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await operation();
    } catch (e) {
      lastError = e;
      if (attempt >= 2 || !isTransientScriptError(e)) throw e;
      logger?.warn(`[${label}] transient LLM interruption, retrying once: ${String(e)}`);
    }
  }
  throw lastError;
}

function isTransientScriptError(error: unknown): boolean {
  const message = String(error).toLowerCase();
  return message.includes("unexpected eof")
    || message.includes("econnreset")
    || message.includes("socket hang up")
    || message.includes("terminated")
    || message.includes("fetch failed")
    || message.includes("429")
    || message.includes("rate limit")
    || message.includes("timeout");
}
