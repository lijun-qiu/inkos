import type { ChatPageModelGroup, ChatPageModelPreference } from "../pages/chat-page-state";

/** Header model picker: Agnes, ModelScope proxy, OpenRouter proxy (free models only). */
export const STUDIO_PICKER_SERVICE_IDS = ["agnes", "modelscope", "openrouter"] as const;

export type StudioPickerServiceId = (typeof STUDIO_PICKER_SERVICE_IDS)[number];

/** Curated ModelScope models — never show the proxy's full live catalog. */
export const MODELSCOPE_PICKER_MODEL_IDS = [
  "modelscope/deepseek-v4-flash",
  "modelscope/deepseek-v4-pro",
] as const;

/** Curated Agnes models. */
export const AGNES_PICKER_MODEL_IDS = [
  "agnes-3.0-flash",
  "agnes-2.5-flash",
  "agnes-2.0-flash",
  "agnes-1.5-flash",
] as const;

const MODELSCOPE_ALLOW = new Set<string>(MODELSCOPE_PICKER_MODEL_IDS);
const AGNES_ALLOW = new Set<string>(AGNES_PICKER_MODEL_IDS);

export function isStudioPickerService(service: string | null | undefined): service is StudioPickerServiceId {
  return Boolean(service && (STUDIO_PICKER_SERVICE_IDS as readonly string[]).includes(service));
}

export function pickerPreference(
  preference: ChatPageModelPreference | null | undefined,
): ChatPageModelPreference | null {
  if (!preference) return null;
  const service = preference.service?.trim() || null;
  if (service && !isStudioPickerService(service)) {
    return { model: preference.model ?? null, service: null };
  }
  return preference;
}

export function isOpenRouterFreeModelId(modelId: string): boolean {
  const id = modelId.trim().toLowerCase();
  if (!id || id === "openrouter/free") return false;
  if (id.includes("content-safety") || id.includes("lyria")) return false;
  return id.endsWith(":free") || id === "inclusionai/ling-3.1-flash";
}

function isAllowedPickerModel(service: string, modelId: string): boolean {
  const id = modelId.trim();
  if (service === "modelscope") return MODELSCOPE_ALLOW.has(id);
  if (service === "agnes") return AGNES_ALLOW.has(id);
  if (service === "openrouter") return isOpenRouterFreeModelId(id);
  return false;
}

export function filterStudioPickerGroups(
  groups: ReadonlyArray<ChatPageModelGroup>,
): ChatPageModelGroup[] {
  return groups
    .filter((group) => isStudioPickerService(group.service))
    .map((group) => ({
      ...group,
      models: group.models.filter((model) =>
        isAllowedPickerModel(group.service, model.id)
        || isAllowedPickerModel(group.service, model.name ?? ""),
      ),
    }))
    .filter((group) => group.models.length > 0);
}
