import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_TOOL_LOGS,
  applyStreamTextDeltas,
  appendBoundedToolLogs,
  advanceStagesFromLog,
  createLatestEventThrottle,
  createStreamTextDeltaBatcher,
} from "./stream-events";
import type { ToolExecution } from "../../types";

describe("stream event performance helpers", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("applies queued text deltas in their original order", () => {
    const parts = applyStreamTextDeltas(
      [{ type: "thinking", content: "why", streaming: true }],
      [
        { kind: "thinking", text: " it matters" },
        { kind: "text", text: "Answer " },
        { kind: "text", text: "body." },
      ],
    );

    expect(parts).toEqual([
      { type: "thinking", content: "why it matters", streaming: true },
      { type: "text", content: "Answer body." },
    ]);
  });

  it("batches many text deltas into one scheduled flush", () => {
    vi.useFakeTimers();
    const flush = vi.fn();
    const batcher = createStreamTextDeltaBatcher(flush, 50);

    for (let i = 0; i < 100; i += 1) {
      batcher.enqueue({ kind: "text", text: "x" });
    }

    expect(flush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(49);
    expect(flush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush.mock.calls[0][0]).toHaveLength(100);
  });

  it("flushes queued text immediately before structural stream events", () => {
    vi.useFakeTimers();
    const flush = vi.fn();
    const batcher = createStreamTextDeltaBatcher(flush, 50);

    batcher.enqueue({ kind: "text", text: "before tool" });
    batcher.flush();
    vi.advanceTimersByTime(50);

    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith([{ kind: "text", text: "before tool" }]);
  });

  it("throttles frequent progress events and publishes the latest one", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const publish = vi.fn();
    const throttle = createLatestEventThrottle<string>(publish, 1000);

    throttle.enqueue("first");
    throttle.enqueue("second");
    throttle.enqueue("third");

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenLastCalledWith("first");

    vi.advanceTimersByTime(999);
    expect(publish).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenLastCalledWith("third");
  });

  it("keeps only recent tool logs", () => {
    const existing = Array.from({ length: MAX_TOOL_LOGS + 20 }, (_, i) => `old-${i}`);
    const logs = appendBoundedToolLogs(existing, ["latest"]);

    expect(logs).toHaveLength(MAX_TOOL_LOGS);
    expect(logs[0]).toBe("old-21");
    expect(logs.at(-1)).toBe("latest");
  });

  it("advances pipeline stages from matching log messages", () => {
    const execution: ToolExecution = {
      id: "t1",
      tool: "sub_agent",
      agent: "writer",
      label: "写作",
      status: "running",
      startedAt: Date.now(),
      stages: [
        { label: "准备章节输入", status: "pending" },
        { label: "撰写章节草稿", status: "pending" },
        { label: "落盘最终章节", status: "pending" },
      ],
    };

    const next = advanceStagesFromLog(execution, "正在撰写章节草稿…");
    expect(next.stages?.[0]?.status).toBe("completed");
    expect(next.stages?.[1]?.status).toBe("active");
    expect(next.stages?.[2]?.status).toBe("pending");
  });
});
