import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { runShortFictionProductionMock } = vi.hoisted(() => ({
  runShortFictionProductionMock: vi.fn(async (_options: Record<string, unknown>) => ({
    storyId: "length-check",
    outlinePath: "shorts/length-check/outline/v002.md",
    outlineReviewPath: "shorts/length-check/reviews/outline-v001.md",
    draftReviewPath: "shorts/length-check/reviews/draft-v001.md",
    finalMarkdownPath: "shorts/length-check/final/story.md",
    finalJsonPath: "shorts/length-check/final/story.json",
    salesPackagePath: "shorts/length-check/final/sales.md",
    coverPromptPath: "shorts/length-check/final/cover-prompt.md",
    coverImagePath: "shorts/length-check/final/cover.png",
  })),
}));

vi.mock("../pipeline/short-fiction-runner.js", async () => {
  const actual = await vi.importActual<any>("../pipeline/short-fiction-runner.js");
  return { ...actual, runShortFictionProduction: runShortFictionProductionMock };
});

import { ShortRunActionPayloadSchema, normalizeActionPayload } from "../interaction/action-envelope.js";
import { createProposeActionTool, createShortFictionRunTool } from "../agent/agent-tools.js";

describe("short_run charsPerChapter validation (envelope layer)", () => {
  it("rejects an English charsPerChapter in the zh char range (en+2000)", () => {
    const parsed = ShortRunActionPayloadSchema.safeParse({
      direction: "an office suspense story",
      language: "en",
      charsPerChapter: 2000,
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(!parsed.success ? parsed.error.issues : [])).toMatch(/1200-1500/);
  });

  it("rejects a Chinese charsPerChapter in the en word range (zh+1350)", () => {
    const parsed = ShortRunActionPayloadSchema.safeParse({
      direction: "女频短篇 婚姻背叛 证据反杀",
      language: "zh",
      charsPerChapter: 1350,
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(!parsed.success ? parsed.error.issues : [])).toMatch(/1800-2200/);
  });

  it("accepts en+1350 and zh+2000", () => {
    expect(ShortRunActionPayloadSchema.safeParse({
      direction: "an office suspense story",
      language: "en",
      charsPerChapter: 1350,
    }).success).toBe(true);
    expect(ShortRunActionPayloadSchema.safeParse({
      direction: "女频短篇 婚姻背叛 证据反杀",
      language: "zh",
      charsPerChapter: 2000,
    }).success).toBe(true);
  });

  it("keeps the en/zh union when language is omitted (session default decides later)", () => {
    expect(ShortRunActionPayloadSchema.safeParse({
      direction: "a short story",
      charsPerChapter: 1500,
    }).success).toBe(true);
  });

  it("surfaces the language-specific range through normalizeActionPayload", () => {
    expect(() => normalizeActionPayload({
      shortRun: {
        direction: "an office suspense story",
        language: "en",
        charsPerChapter: 2000,
      },
    })).toThrow(/1200-1500/);
  });
});

describe("short_run charsPerChapter validation (propose_action)", () => {
  it("rejects en+2000 when the model proposes the confirmation card", async () => {
    await expect(createProposeActionTool("zh").execute("propose-short-en-2000", {
      action: "short_run",
      instruction: "用户要求写一篇英文短篇，每章 2000",
      shortRun: {
        direction: "an English office suspense story",
        language: "en",
        chapters: 50,
        charsPerChapter: 2000,
        cover: false,
      },
    } as never)).rejects.toThrow(/1200-1500/);
  });
});

describe("short_run charsPerChapter validation (tool layer, before pipeline start)", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-short-length-"));
    runShortFictionProductionMock.mockClear();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("throws before starting the pipeline when a zh session confirms en+2000", async () => {
    const pipeline = { createAgentContext: vi.fn(() => ({})) };
    const tool = createShortFictionRunTool(pipeline as never, root, {
      language: "zh",
      actionPayload: {
        shortRun: {
          direction: "an English office suspense story",
          language: "en",
          charsPerChapter: 2000,
          cover: false,
        },
      },
    });
    await expect(tool.execute("short-en-2000", {
      direction: "an English office suspense story",
    } as never)).rejects.toThrow(/1200-1500/);
    expect(runShortFictionProductionMock).not.toHaveBeenCalled();
  });

  it("throws before starting the pipeline when params alone carry an out-of-range en value", async () => {
    const pipeline = { createAgentContext: vi.fn(() => ({})) };
    const tool = createShortFictionRunTool(pipeline as never, root, { language: "en" });
    await expect(tool.execute("short-en-params-2000", {
      direction: "an English office suspense story",
      language: "en",
      charsPerChapter: 2000,
    } as never)).rejects.toThrow(/1200-1500/);
    expect(runShortFictionProductionMock).not.toHaveBeenCalled();
  });

  it("keeps the en no-length behavior: runner receives undefined and applies its own 1350 default", async () => {
    const pipeline = { createAgentContext: vi.fn(() => ({})) };
    const tool = createShortFictionRunTool(pipeline as never, root, {
      language: "zh",
      actionPayload: {
        shortRun: {
          direction: "an English office suspense story",
          language: "en",
          cover: false,
        },
      } as never,
    });

    await tool.execute("short-en-no-length", { direction: "fallback direction" } as never);

    expect(runShortFictionProductionMock).toHaveBeenCalledTimes(1);
    const runnerOptions = runShortFictionProductionMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(runnerOptions.language).toBe("en");
    expect(runnerOptions.charsPerChapter).toBeUndefined();
  });
});
