export interface ChatPageModelInfo {
  readonly id: string;
  readonly name?: string;
}

export interface ChatPageModelGroup {
  readonly service: string;
  readonly label: string;
  readonly models: ReadonlyArray<ChatPageModelInfo>;
}

export interface ChatPageModelPreference {
  readonly model?: string | null;
  readonly service?: string | null;
}

export interface ChatPageSessionSummary {
  readonly sessionId: string;
  readonly sessionKind?: string;
  readonly messageCount: number;
}

const BOOK_CREATE_SESSION_KEY = "inkos.book-create.session-id";
const PROJECT_CHAT_SESSION_KEY = "inkos.project-chat.session-id";

export function getBookCreateSessionId(): string | null {
  return globalThis.localStorage?.getItem(BOOK_CREATE_SESSION_KEY) ?? null;
}

export function setBookCreateSessionId(sessionId: string): void {
  globalThis.localStorage?.setItem(BOOK_CREATE_SESSION_KEY, sessionId);
}

export function clearBookCreateSessionId(): void {
  globalThis.localStorage?.removeItem(BOOK_CREATE_SESSION_KEY);
}

export function getProjectChatSessionId(): string | null {
  return globalThis.localStorage?.getItem(PROJECT_CHAT_SESSION_KEY) ?? null;
}

export function setProjectChatSessionId(sessionId: string): void {
  globalThis.localStorage?.setItem(PROJECT_CHAT_SESSION_KEY, sessionId);
}

/**
 * 模型选择器里/外统一带平台前缀，便于区分同名模型
 *（如 modelscope/deepseek-v4-flash vs deepseek/deepseek-v4-flash）。
 * 已含 `/` 的 id（OpenRouter org/model、魔搭前缀等）原样显示。
 */
export function formatModelDisplayId(service: string, modelId: string): string {
  const id = modelId.trim();
  if (!id) return id;
  if (id.includes("/")) return id;
  const svc = service.trim();
  if (!svc || svc.startsWith("custom")) return id;
  return `${svc}/${id}`;
}

/** 触发器文案：服务名 · 带平台前缀的模型 id */
export function formatSelectedModelLabel(
  serviceLabel: string | null | undefined,
  service: string | null | undefined,
  modelId: string,
): string {
  const displayId = formatModelDisplayId(service ?? "", modelId);
  const label = serviceLabel?.trim();
  return label ? `${label} · ${displayId}` : displayId;
}

function modelMatchesPreference(
  model: ChatPageModelInfo,
  preferredModel: string,
  preferredService?: string,
): boolean {
  if (model.id === preferredModel) return true;
  if (model.name === preferredModel) return true;
  // 旧配置短名 deepseek-v4-flash → 银行 id deepseek/deepseek-v4-flash
  if (model.id.endsWith(`/${preferredModel}`)) return true;
  if (preferredService && model.id === `${preferredService}/${preferredModel}`) return true;
  return false;
}

export function filterModelGroups(
  groupedModels: ReadonlyArray<ChatPageModelGroup>,
  search: string,
): ReadonlyArray<ChatPageModelGroup> {
  const query = search.trim().toLowerCase();
  if (!query) return groupedModels;

  return groupedModels
    .map((group) => ({
      ...group,
      models: group.models.filter((model) => {
        const displayId = formatModelDisplayId(group.service, model.name ?? model.id);
        return displayId.toLowerCase().includes(query)
          || (model.name ?? model.id).toLowerCase().includes(query)
          || group.label.toLowerCase().includes(query)
          || group.service.toLowerCase().includes(query);
      }),
    }))
    .filter((group) => group.models.length > 0);
}

export function pickModelSelection(
  groupedModels: ReadonlyArray<ChatPageModelGroup>,
  selectedModel: string | null,
  selectedService: string | null,
  preference?: ChatPageModelPreference | null,
): { model: string; service: string } | null {
  const selectedStillAvailable = selectedModel && selectedService
    ? groupedModels.some((group) =>
        group.service === selectedService
        && group.models.some((model) => model.id === selectedModel),
      )
    : false;
  if (selectedStillAvailable) return null;

  const preferredService = preference?.service?.trim();
  const preferredModel = preference?.model?.trim();
  if (preferredService) {
    const preferredGroup = groupedModels.find((group) => group.service === preferredService);
    // Preferred service is configured but its models are not loaded yet — wait.
    // Do not fall through to another service that happens to share a short model id
    // (e.g. deepseek-v4-flash on MyProxy vs modelscope/deepseek-v4-flash).
    if (!preferredGroup) return null;
    const exactModel = preferredModel
      ? preferredGroup.models.find((model) =>
          modelMatchesPreference(model, preferredModel, preferredService),
        )
      : undefined;
    if (exactModel) {
      return { model: exactModel.id, service: preferredGroup.service };
    }
    const firstPreferredModel = preferredGroup.models[0];
    if (firstPreferredModel) {
      return { model: firstPreferredModel.id, service: preferredGroup.service };
    }
    return null;
  }

  if (preferredModel) {
    for (const group of groupedModels) {
      const exactModel = group.models.find((model) =>
        modelMatchesPreference(model, preferredModel, group.service),
      );
      if (exactModel) return { model: exactModel.id, service: group.service };
    }
  }

  const firstGroup = groupedModels.find((group) => group.models.length > 0);
  const firstModel = firstGroup?.models[0];
  if (!firstGroup || !firstModel) return null;
  return { model: firstModel.id, service: firstGroup.service };
}

export function pickProjectChatSessionId(
  sessions: ReadonlyArray<ChatPageSessionSummary>,
): string | null {
  const projectSurfaceSessions = sessions.filter((session) =>
    !session.sessionKind
    || session.sessionKind === "chat"
    || session.sessionKind === "short"
    || session.sessionKind === "play"
    || session.sessionKind === "script"
    || session.sessionKind === "storyboard"
    || session.sessionKind === "interactive-film"
  );
  return projectSurfaceSessions.find((session) => session.messageCount > 0)?.sessionId
    ?? projectSurfaceSessions[0]?.sessionId
    ?? null;
}

export function shouldShowPlayChoicePanel(input: {
  readonly playMode?: string | null;
  readonly choiceSetKey?: string | null;
  readonly consumedChoiceKey?: string | null;
  readonly choiceCount: number;
}): boolean {
  if (input.playMode !== "guided") return false;
  if (!input.choiceSetKey) return false;
  if (input.choiceCount <= 0) return false;
  return input.choiceSetKey !== input.consumedChoiceKey;
}

export function isChatScrollNearBottom(input: {
  readonly scrollTop: number;
  readonly clientHeight: number;
  readonly scrollHeight: number;
  readonly thresholdPx?: number;
}): boolean {
  const threshold = input.thresholdPx ?? 96;
  const distanceFromBottom = input.scrollHeight - input.scrollTop - input.clientHeight;
  return distanceFromBottom <= threshold;
}

export function getChatScrollBehavior(isStreaming: boolean): "auto" | "smooth" {
  return isStreaming ? "auto" : "smooth";
}
