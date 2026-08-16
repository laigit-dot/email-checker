import { z } from "zod";

import type {
  AiModelOption,
  AiProvider,
  ListAiModelsRequest,
  ListAiModelsResult,
} from "../../shared/contracts.js";
import { validateOllamaEndpoint } from "./ollamaClassifier.js";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

const ollamaTagsSchema = z.object({
  models: z
    .array(
      z
        .object({
          name: z.string().min(1),
          model: z.string().optional(),
        })
        .passthrough(),
    )
    .default([]),
});

const openRouterModelsSchema = z.object({
  data: z
    .array(
      z
        .object({
          id: z.string().min(1),
          name: z.string().optional(),
        })
        .passthrough(),
    )
    .default([]),
});

const listRequestSchema = z
  .object({
    provider: z.enum(["ollama", "openrouter"]),
    endpoint: z.string().optional(),
    apiKey: z.string().optional(),
  })
  .strict();

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim();
    if (!text) {
      return `Provider request failed (${response.status}).`;
    }
    try {
      const json = JSON.parse(text) as {
        error?: { message?: string } | string;
        message?: string;
      };
      if (typeof json.error === "string" && json.error.trim()) {
        return json.error.trim();
      }
      if (
        json.error &&
        typeof json.error === "object" &&
        typeof json.error.message === "string" &&
        json.error.message.trim()
      ) {
        return json.error.message.trim();
      }
      if (typeof json.message === "string" && json.message.trim()) {
        return json.message.trim();
      }
    } catch {
      // Fall through to raw text.
    }
    return text.slice(0, 240);
  } catch {
    return `Provider request failed (${response.status}).`;
  }
}

export async function listOllamaModels(
  endpoint: string,
  apiKey?: string,
): Promise<AiModelOption[]> {
  const base = validateOllamaEndpoint(endpoint);
  const url = new URL("/api/tags", base);
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
  });
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
  const payload = ollamaTagsSchema.parse(await response.json());
  const models = payload.models
    .map((item) => {
      const id = (item.name || item.model || "").trim();
      return id ? { id, label: id } : null;
    })
    .filter((item): item is AiModelOption => item !== null)
    .sort((a, b) => a.label.localeCompare(b.label));
  if (models.length === 0) {
    throw new Error("No models were returned by the Ollama endpoint.");
  }
  return models;
}

export async function listOpenRouterModels(
  apiKey: string,
): Promise<AiModelOption[]> {
  const key = apiKey.trim();
  if (!key) {
    throw new Error("OpenRouter API key is required to load models.");
  }
  const response = await fetch(OPENROUTER_MODELS_URL, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${key}`,
    },
  });
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
  const payload = openRouterModelsSchema.parse(await response.json());
  const models = payload.data
    .map((item) => {
      const id = item.id.trim();
      if (!id) {
        return null;
      }
      const label = item.name?.trim() ? `${item.name.trim()} (${id})` : id;
      return { id, label };
    })
    .filter((item): item is AiModelOption => item !== null)
    .sort((a, b) => a.label.localeCompare(b.label));
  if (models.length === 0) {
    throw new Error("No models were returned by OpenRouter.");
  }
  return models;
}

export async function listAiModels(
  request: ListAiModelsRequest,
): Promise<ListAiModelsResult> {
  const parsed = listRequestSchema.parse(request);
  const provider: AiProvider = parsed.provider;
  if (provider === "openrouter") {
    return {
      models: await listOpenRouterModels(parsed.apiKey ?? ""),
    };
  }
  const endpoint = parsed.endpoint?.trim();
  if (!endpoint) {
    throw new Error("Ollama URL is required to load models.");
  }
  return {
    models: await listOllamaModels(endpoint, parsed.apiKey),
  };
}
