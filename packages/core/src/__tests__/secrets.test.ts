import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  loadSecrets,
  saveSecrets,
  getServiceApiKey,
  upsertServiceSecret,
} from "../llm/secrets.js";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("secrets", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-secrets-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe("loadSecrets", () => {
    it("returns empty when .inkos/secrets.json does not exist", async () => {
      const secrets = await loadSecrets(root);
      expect(secrets).toEqual({ services: {} });
    });

    it("reads existing secrets file", async () => {
      await mkdir(join(root, ".inkos"), { recursive: true });
      await writeFile(
        join(root, ".inkos", "secrets.json"),
        JSON.stringify({ services: { moonshot: { apiKey: "sk-test" } } }),
      );
      const secrets = await loadSecrets(root);
      expect(secrets.services.moonshot.apiKey).toBe("sk-test");
    });

    it("strips legacy remaining fields from key pool entries", async () => {
      await mkdir(join(root, ".inkos"), { recursive: true });
      await writeFile(
        join(root, ".inkos", "secrets.json"),
        JSON.stringify({
          services: {
            modelscope: {
              apiKey: "ms-a",
              apiKeys: [{ key: "ms-a", remaining: 5, label: "A" }],
            },
          },
        }),
      );
      const secrets = await loadSecrets(root);
      expect(secrets.services.modelscope.apiKeys).toEqual([{ key: "ms-a", label: "A" }]);
    });
  });

  describe("saveSecrets", () => {
    it("creates .inkos dir and writes secrets file", async () => {
      await saveSecrets(root, {
        services: { deepseek: { apiKey: "sk-deep" } },
      });
      const raw = await readFile(join(root, ".inkos", "secrets.json"), "utf-8");
      const parsed = JSON.parse(raw);
      expect(parsed.services.deepseek.apiKey).toBe("sk-deep");
    });

    it("overwrites existing secrets file", async () => {
      await mkdir(join(root, ".inkos"), { recursive: true });
      await writeFile(
        join(root, ".inkos", "secrets.json"),
        JSON.stringify({ services: { old: { apiKey: "old-key" } } }),
      );
      await saveSecrets(root, {
        services: { new: { apiKey: "new-key" } },
      });
      const secrets = await loadSecrets(root);
      expect(secrets.services.new.apiKey).toBe("new-key");
      expect(secrets.services.old).toBeUndefined();
    });
  });

  describe("getServiceApiKey", () => {
    it("returns key from secrets.json first", async () => {
      await mkdir(join(root, ".inkos"), { recursive: true });
      await writeFile(
        join(root, ".inkos", "secrets.json"),
        JSON.stringify({ services: { moonshot: { apiKey: "sk-from-file" } } }),
      );
      const key = await getServiceApiKey(root, "moonshot");
      expect(key).toBe("sk-from-file");
    });

    it("falls back to environment variable", async () => {
      vi.stubEnv("MOONSHOT_API_KEY", "sk-from-env");
      const key = await getServiceApiKey(root, "moonshot");
      expect(key).toBe("sk-from-env");
      vi.unstubAllEnvs();
    });

    it("returns null when neither secrets nor env exists", async () => {
      const key = await getServiceApiKey(root, "moonshot");
      expect(key).toBeNull();
    });

    it("handles custom service with colon key format", async () => {
      await mkdir(join(root, ".inkos"), { recursive: true });
      await writeFile(
        join(root, ".inkos", "secrets.json"),
        JSON.stringify({
          services: { "custom:内网GPT": { apiKey: "sk-custom" } },
        }),
      );
      const key = await getServiceApiKey(root, "custom:内网GPT");
      expect(key).toBe("sk-custom");
    });

    it("returns manually selected pool key", async () => {
      await saveSecrets(root, {
        services: {
          modelscope: {
            apiKey: "ms-b",
            apiKeys: [
              { key: "ms-a", label: "A" },
              { key: "ms-b", label: "B" },
            ],
          },
        },
      });
      expect(await getServiceApiKey(root, "modelscope")).toBe("ms-b");
    });
  });

  describe("key pool", () => {
    it("preserves apiKeys when upserting only apiKey", async () => {
      await upsertServiceSecret(root, "modelscope", {
        apiKey: "ms-a",
        apiKeys: [
          { key: "ms-a" },
          { key: "ms-b" },
        ],
      });
      await upsertServiceSecret(root, "modelscope", { apiKey: "ms-b" });
      const secrets = await loadSecrets(root);
      expect(secrets.services.modelscope.apiKey).toBe("ms-b");
      expect(secrets.services.modelscope.apiKeys).toHaveLength(2);
    });
  });
});
