import { describe, expect, it } from "vitest";
import {
  filterStudioPickerGroups,
  isStudioPickerService,
  pickerPreference,
} from "./studio-model-picker";

describe("studio model picker", () => {
  it("allows only agnes, modelscope, and openrouter", () => {
    expect(isStudioPickerService("agnes")).toBe(true);
    expect(isStudioPickerService("modelscope")).toBe(true);
    expect(isStudioPickerService("openrouter")).toBe(true);
    expect(isStudioPickerService("google")).toBe(false);
    expect(isStudioPickerService("ollama")).toBe(false);
    expect(isStudioPickerService("custom:local")).toBe(false);
  });

  it("keeps only curated modelscope/agnes ids and openrouter free models", () => {
    expect(filterStudioPickerGroups([
      {
        service: "google",
        label: "Google Gemini",
        models: [{ id: "gemini-2.5-flash" }],
      },
      {
        service: "modelscope",
        label: "魔塔代理",
        models: [
          { id: "modelscope/deepseek-v4-flash" },
          { id: "modelscope/deepseek-v4-pro" },
          { id: "Qwen/Qwen3.5-35B-A5B" },
          { id: "Shanghai_AI_Laboratory/Intern-S1" },
        ],
      },
      {
        service: "agnes",
        label: "Agnes AI",
        models: [
          { id: "agnes-3.0-flash" },
          { id: "some-other-agnes" },
        ],
      },
      {
        service: "openrouter",
        label: "OpenRouter 代理",
        models: [
          { id: "qwen/qwen3.8-27b:free" },
          { id: "inclusionai/ling-3.1-flash" },
          { id: "openai/gpt-4o" },
          { id: "nvidia/nemotron-3.5-content-safety:free" },
        ],
      },
    ])).toEqual([
      {
        service: "modelscope",
        label: "魔塔代理",
        models: [
          { id: "modelscope/deepseek-v4-flash" },
          { id: "modelscope/deepseek-v4-pro" },
        ],
      },
      {
        service: "agnes",
        label: "Agnes AI",
        models: [{ id: "agnes-3.0-flash" }],
      },
      {
        service: "openrouter",
        label: "OpenRouter 代理",
        models: [
          { id: "qwen/qwen3.8-27b:free" },
          { id: "inclusionai/ling-3.1-flash" },
        ],
      },
    ]);
  });

  it("ignores a configured service that is not in the picker", () => {
    expect(pickerPreference({ service: "google", model: "gemini-2.5-flash" })).toEqual({
      service: null,
      model: "gemini-2.5-flash",
    });
    expect(pickerPreference({ service: "agnes", model: "agnes-3.0-flash" })).toEqual({
      service: "agnes",
      model: "agnes-3.0-flash",
    });
  });
});
