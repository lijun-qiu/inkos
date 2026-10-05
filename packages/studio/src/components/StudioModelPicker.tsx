import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { fetchJson, putApi } from "../hooks/use-api";
import { tr } from "../lib/app-language";
import {
  filterStudioPickerGroups,
  isStudioPickerService,
  pickerPreference,
} from "../lib/studio-model-picker";
import {
  type ChatPageModelPreference,
  filterModelGroups,
  formatModelDisplayId,
  formatSelectedModelLabel,
  pickModelSelection,
} from "../pages/chat-page-state";
import { useChatStore } from "../store/chat";
import { useServiceStore } from "../store/service";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

interface ServiceConfigPayload {
  readonly service?: string | null;
  readonly defaultModel?: string | null;
}

export function StudioModelPicker({ onManage }: { readonly onManage: () => void }) {
  const selectedModel = useChatStore((s) => s.selectedModel);
  const selectedService = useChatStore((s) => s.selectedService);
  const setSelectedModel = useChatStore((s) => s.setSelectedModel);

  const services = useServiceStore((s) => s.services);
  const servicesLoading = useServiceStore((s) => s.servicesLoading);
  const bankModelsLoading = useServiceStore((s) => s.bankModelsLoading);
  const modelsByService = useServiceStore((s) => s.modelsByService);
  const fetchServices = useServiceStore((s) => s.fetchServices);
  const fetchBankModels = useServiceStore((s) => s.fetchBankModels);
  const fetchLiveModels = useServiceStore((s) => s.fetchLiveModels);

  const [configuredModelSelection, setConfiguredModelSelection] = useState<ChatPageModelPreference | null>(null);
  const [serviceConfigLoaded, setServiceConfigLoaded] = useState(false);
  const appliedPreferenceKeyRef = useRef<string | null>(null);

  useEffect(() => { void fetchServices(); }, [fetchServices]);
  // Bank catalog for Agnes / 魔塔（白名单）。OpenRouter 再拉 live :free，对齐官网免费列表。
  useEffect(() => { void fetchBankModels(); }, [fetchBankModels]);
  useEffect(() => {
    const openrouter = services.find((s) => s.service === "openrouter" && s.connected);
    if (openrouter) void fetchLiveModels("openrouter");
  }, [fetchLiveModels, services]);
  useEffect(() => {
    let cancelled = false;
    void fetchJson<ServiceConfigPayload>("/services/config")
      .then((payload) => {
        if (cancelled) return;
        setConfiguredModelSelection({
          service: payload.service ?? null,
          model: payload.defaultModel ?? null,
        });
      })
      .catch(() => {
        if (!cancelled) setConfiguredModelSelection(null);
      })
      .finally(() => {
        if (!cancelled) setServiceConfigLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const groupedModels = useMemo(() => {
    return filterStudioPickerGroups(
      services
        .filter((s) => s.connected && (modelsByService[s.service]?.length ?? 0) > 0)
        .map((s) => ({ service: s.service, label: s.label, models: modelsByService[s.service]! })),
    );
  }, [modelsByService, services]);

  const pickerStatus = useMemo(() => {
    if (servicesLoading) return "loading" as const;
    const connected = services.filter((s) => s.connected && isStudioPickerService(s.service));
    if (connected.length === 0) return "no-models" as const;
    if (bankModelsLoading && groupedModels.length === 0) return "loading" as const;
    if (groupedModels.length > 0) return "ready" as const;
    return "no-models" as const;
  }, [bankModelsLoading, groupedModels.length, services, servicesLoading]);

  const selectedModelLabel = useMemo(() => {
    if (!selectedModel) return tr("选择模型", "Select model");
    const group = groupedModels.find((item) => item.service === selectedService);
    const model = group?.models.find((item) => item.id === selectedModel);
    const modelLabel = model?.name ?? selectedModel;
    return formatSelectedModelLabel(group?.label, selectedService ?? group?.service, modelLabel);
  }, [groupedModels, selectedModel, selectedService]);

  const persistSelection = useCallback((model: string, service: string) => {
    appliedPreferenceKeyRef.current = `${service}::${model}`;
    setConfiguredModelSelection({ service, model });
    void putApi("/project/default-model", { service, defaultModel: model }).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!serviceConfigLoaded) return;
    const preference = pickerPreference(configuredModelSelection);
    const preferenceKey = preference
      ? `${preference.service ?? ""}::${preference.model ?? ""}`
      : "";

    if (
      preferenceKey
      && preferenceKey !== appliedPreferenceKeyRef.current
      && preference
    ) {
      const preferred = pickModelSelection(groupedModels, null, null, preference);
      if (preferred) {
        const preferredService = preference.service?.trim();
        if (!preferredService || preferred.service === preferredService) {
          appliedPreferenceKeyRef.current = preferenceKey;
        }
        if (preferred.model !== selectedModel || preferred.service !== selectedService) {
          setSelectedModel(preferred.model, preferred.service);
        }
        if (
          preferred.service !== configuredModelSelection?.service
          || preferred.model !== configuredModelSelection?.model
        ) {
          persistSelection(preferred.model, preferred.service);
        }
        return;
      }
      if (preference.service?.trim()) return;
    }

    const nextSelection = pickModelSelection(
      groupedModels,
      selectedModel,
      selectedService,
      preference,
    );
    if (nextSelection) {
      setSelectedModel(nextSelection.model, nextSelection.service);
      if (
        nextSelection.service !== configuredModelSelection?.service
        || nextSelection.model !== configuredModelSelection?.model
      ) {
        persistSelection(nextSelection.model, nextSelection.service);
      }
    }
  }, [
    configuredModelSelection,
    groupedModels,
    selectedModel,
    selectedService,
    persistSelection,
    serviceConfigLoaded,
    setSelectedModel,
  ]);

  const onSelect = (model: string, service: string) => {
    setSelectedModel(model, service);
    persistSelection(model, service);
  };

  if (pickerStatus === "loading") {
    return (
      <span className="text-[15px] text-muted-foreground/40 animate-pulse">
        {tr("加载模型...", "Loading models...")}
      </span>
    );
  }

  if (pickerStatus !== "ready") {
    return (
      <button
        type="button"
        onClick={onManage}
        className="text-[15px] text-muted-foreground/70 hover:text-primary transition-colors"
      >
        {tr("配置模型 →", "Set up models →")}
      </button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex max-w-[360px] items-center gap-1.5 rounded-md px-2 py-1.5 text-[16px] transition-colors hover:bg-muted cursor-pointer">
        <span className="truncate font-medium">{selectedModelLabel}</span>
        <ChevronDown size={17} className="shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <ModelPickerContent
        groupedModels={groupedModels}
        selectedModel={selectedModel}
        selectedService={selectedService}
        onSelect={onSelect}
        onManage={onManage}
      />
    </DropdownMenu>
  );
}

function ModelPickerContent({
  groupedModels,
  selectedModel,
  selectedService,
  onSelect,
  onManage,
}: {
  groupedModels: ReadonlyArray<{ service: string; label: string; models: ReadonlyArray<{ id: string; name?: string }> }>;
  selectedModel: string | null;
  selectedService: string | null;
  onSelect: (model: string, service: string) => void;
  onManage: () => void;
}) {
  const [search, setSearch] = useState("");
  const filtered = useMemo(() => filterModelGroups(groupedModels, search), [groupedModels, search]);

  return (
    <DropdownMenuContent side="bottom" align="end" className="w-72 max-h-80 flex flex-col">
      <div className="px-2 py-1.5 border-b border-border/30">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={tr("搜索模型...", "Search models...")}
          className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/40"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        />
      </div>
      <div className="overflow-y-auto flex-1">
        {filtered.map((group) => (
          <div key={group.service}>
            <div className="px-2 py-1.5 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
              {group.label}
            </div>
            {group.models.map((m) => {
              const isSelected = selectedModel === m.id && selectedService === group.service;
              const displayId = formatModelDisplayId(group.service, m.name ?? m.id);
              return (
                <DropdownMenuItem
                  key={`${group.service}:${m.id}`}
                  onClick={() => onSelect(m.id, group.service)}
                  className={isSelected ? "bg-muted/50" : ""}
                >
                  <div className="flex flex-1 items-center justify-between gap-2">
                    <span className="text-sm truncate" title={displayId}>{displayId}</span>
                    {isSelected && <Check size={14} className="text-primary shrink-0" />}
                  </div>
                </DropdownMenuItem>
              );
            })}
          </div>
        ))}
        {filtered.length === 0 && (
          <div className="px-3 py-4 text-xs text-muted-foreground/50 text-center italic">
            {tr("无匹配模型", "No matching models")}
          </div>
        )}
      </div>
      <div className="border-t border-border/30">
        <DropdownMenuItem onClick={onManage} className="text-primary">
          {tr("管理服务商", "Manage providers")}
        </DropdownMenuItem>
      </div>
    </DropdownMenuContent>
  );
}
