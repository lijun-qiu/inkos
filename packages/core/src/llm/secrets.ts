import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

/** One optional upstream key entry (legacy pool shape; unused by ModelScope proxy flow). */
export interface ServiceApiKeyEntry {
  key: string;
  label?: string;
}

export interface ServiceSecret {
  /** Active key used for calls. */
  apiKey: string;
  /** Optional legacy pool entries (kept for file compatibility; UI no longer manages pools). */
  apiKeys?: ServiceApiKeyEntry[];
}

export interface SecretsFile {
  services: Record<string, ServiceSecret>;
}

const SECRETS_DIR = ".inkos";
const SECRETS_FILE = "secrets.json";

const LEGACY_SERVICE_ID_REMAP: Record<string, string> = {
  siliconflow: "siliconcloud",
};

function migrateLegacyServiceIds(secrets: SecretsFile): { data: SecretsFile; changed: boolean } {
  let changed = false;
  for (const [oldId, newId] of Object.entries(LEGACY_SERVICE_ID_REMAP)) {
    if (secrets.services[oldId] && !secrets.services[newId]) {
      secrets.services[newId] = secrets.services[oldId];
      delete secrets.services[oldId];
      changed = true;
    }
  }
  return { data: secrets, changed };
}

/** Normalize a raw secrets service entry (legacy `{ apiKey }` or pool shape). */
export function normalizeServiceSecret(raw: unknown): ServiceSecret | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const apiKey = typeof obj.apiKey === "string" ? obj.apiKey.trim() : "";
  const poolRaw = obj.apiKeys;
  let apiKeys: ServiceApiKeyEntry[] | undefined;
  if (Array.isArray(poolRaw)) {
    apiKeys = poolRaw
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      .map((item) => {
        const key = typeof item.key === "string" ? item.key.trim() : "";
        if (!key) return null;
        const entry: ServiceApiKeyEntry = { key };
        if (typeof item.label === "string" && item.label.trim()) {
          entry.label = item.label.trim();
        }
        return entry;
      })
      .filter((item): item is ServiceApiKeyEntry => item !== null);
  }
  if (!apiKey && (!apiKeys || apiKeys.length === 0)) return null;
  return {
    apiKey,
    ...(apiKeys && apiKeys.length > 0 ? { apiKeys } : {}),
  };
}

/**
 * Active key for a service.
 * Prefers `apiKey`; falls back to the first pool entry when present (legacy files).
 */
export function resolveActiveServiceApiKey(secret: ServiceSecret | null | undefined): string | null {
  if (!secret) return null;
  const active = secret.apiKey?.trim() ?? "";
  if (active) return active;
  const first = secret.apiKeys?.find((entry) => entry.key.trim().length > 0);
  return first?.key ?? null;
}

async function readSecretsRaw(projectRoot: string): Promise<SecretsFile> {
  try {
    const raw = await readFile(
      join(projectRoot, SECRETS_DIR, SECRETS_FILE),
      "utf-8",
    );
    const parsed = JSON.parse(raw) as { services?: Record<string, unknown> };
    if (!parsed || typeof parsed !== "object" || !parsed.services) {
      return { services: {} };
    }
    const services: Record<string, ServiceSecret> = {};
    for (const [id, value] of Object.entries(parsed.services)) {
      const normalized = normalizeServiceSecret(value);
      if (normalized) services[id] = normalized;
    }
    return { services };
  } catch {
    return { services: {} };
  }
}

export async function loadSecrets(projectRoot: string): Promise<SecretsFile> {
  const raw = await readSecretsRaw(projectRoot);
  const { data, changed } = migrateLegacyServiceIds(raw);
  if (changed) await saveSecrets(projectRoot, data);
  return data;
}

export async function saveSecrets(
  projectRoot: string,
  secrets: SecretsFile,
): Promise<void> {
  const dir = join(projectRoot, SECRETS_DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, SECRETS_FILE),
    JSON.stringify(secrets, null, 2),
    "utf-8",
  );
}

/**
 * Upsert a service secret while preserving an existing key pool unless `apiKeys` is provided.
 */
export async function upsertServiceSecret(
  projectRoot: string,
  service: string,
  patch: {
    readonly apiKey?: string | null;
    readonly apiKeys?: ServiceApiKeyEntry[] | null;
    readonly clear?: boolean;
  },
): Promise<SecretsFile> {
  const secrets = await loadSecrets(projectRoot);
  if (patch.clear || (patch.apiKey === "" && patch.apiKeys == null)) {
    delete secrets.services[service];
    await saveSecrets(projectRoot, secrets);
    return secrets;
  }

  const existing = secrets.services[service];
  const nextApiKey =
    typeof patch.apiKey === "string" ? patch.apiKey.trim() : (existing?.apiKey ?? "");
  const nextPool =
    patch.apiKeys === null
      ? undefined
      : Array.isArray(patch.apiKeys)
        ? patch.apiKeys
          .map((entry) => ({
            key: entry.key.trim(),
            ...(entry.label?.trim() ? { label: entry.label.trim() } : {}),
          }))
          .filter((entry) => entry.key.length > 0)
        : existing?.apiKeys;

  if (!nextApiKey && (!nextPool || nextPool.length === 0)) {
    delete secrets.services[service];
  } else {
    secrets.services[service] = {
      apiKey: nextApiKey || nextPool?.[0]?.key || "",
      ...(nextPool && nextPool.length > 0 ? { apiKeys: nextPool } : {}),
    };
  }
  await saveSecrets(projectRoot, secrets);
  return secrets;
}

export async function getServiceApiKey(
  projectRoot: string,
  service: string,
): Promise<string | null> {
  // 1. secrets.json (active key)
  const secrets = await loadSecrets(projectRoot);
  const fromSecrets = resolveActiveServiceApiKey(secrets.services[service]);
  if (fromSecrets) return fromSecrets;

  // 2. Environment variable: MOONSHOT_API_KEY, DEEPSEEK_API_KEY, etc.
  const envKey = `${service.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()}_API_KEY`;
  if (process.env[envKey]) return process.env[envKey]!;

  return null;
}
