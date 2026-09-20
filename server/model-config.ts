import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

export interface ModelProfile {
  id: string;
  name: string;
  baseURL: string;
  model: string;
  description: string;
  configured: boolean;
}

export interface ModelConfiguration extends ModelProfile {
  apiKey: string;
}

const profileSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/),
  name: z.string().trim().min(1).max(120),
  baseURL: z.string().trim().min(1),
  model: z.string().trim().min(1).max(160),
  apiKeyEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
  description: z.string().trim().max(1000).default('General coding tasks'),
});

const fileSchema = z.object({
  defaultModel: z.string().min(1),
  models: z.array(profileSchema).min(1).max(100),
});

function validatedBaseURL(value: string, label: string): string {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('invalid');
    }
    return url.toString().replace(/\/+$/, '');
  } catch {
    throw new Error(`${label} must be an HTTP(S) base URL without credentials, query parameters, or fragments.`);
  }
}

function readConfiguration(): { defaultModel?: string; models: ModelConfiguration[] } {
  const customFile = process.env.CODEGEIST_MODELS_FILE?.trim();
  const path = resolve(customFile || 'models.config.json');
  if (existsSync(path)) {
    let parsed: z.infer<typeof fileSchema>;
    try {
      const text = readFileSync(path, 'utf8');
      if (text.length > 200_000) throw new Error('too large');
      parsed = fileSchema.parse(JSON.parse(text));
    } catch {
      // Never echo JSON or validation input: a mistaken inline key may be present.
      throw new Error('Invalid model configuration. Expected defaultModel and models with id, name, baseURL, model, and apiKeyEnv.');
    }
    const ids = new Set(parsed.models.map((profile) => profile.id));
    if (ids.size !== parsed.models.length || !ids.has(parsed.defaultModel)) {
      throw new Error('Model configuration requires unique model IDs and a defaultModel matching one of them.');
    }
    return {
      defaultModel: parsed.defaultModel,
      models: parsed.models.map((profile) => {
        const apiKey = process.env[profile.apiKeyEnv]?.trim() || '';
        return {
          id: profile.id,
          name: profile.name,
          baseURL: validatedBaseURL(profile.baseURL, 'Model endpoint'),
          model: profile.model,
          description: profile.description,
          configured: Boolean(apiKey),
          apiKey,
        };
      }),
    };
  }
  if (customFile) throw new Error('The configured CODEGEIST_MODELS_FILE could not be found.');
  const model = process.env.OPENAI_MODEL?.trim();
  if (!model) return { models: [] };
  const apiKey = process.env.OPENAI_API_KEY?.trim() || '';
  return {
    defaultModel: 'default',
    models: [{
      id: 'default',
      name: process.env.OPENAI_MODEL_NAME?.trim() || model,
      baseURL: validatedBaseURL(process.env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1', 'OPENAI_BASE_URL'),
      model,
      description: 'Default OpenAI-compatible model for coding tasks',
      configured: Boolean(apiKey),
      apiKey,
    }],
  };
}

/** Safe for API responses. Credentials and environment variable names are omitted. */
export function loadModelProfiles(): ModelProfile[] {
  return readConfiguration().models.map(({ apiKey: _apiKey, ...profile }) => profile);
}

export function getDefaultModelId(): string | undefined {
  const config = readConfiguration();
  return config.models.find((model) => model.id === config.defaultModel && model.configured)?.id
    ?? config.models.find((model) => model.configured)?.id
    ?? config.defaultModel;
}

/** Server-only. Do not serialize this object into run events or API responses. */
export function getModelConfiguration(modelId?: string): ModelConfiguration {
  const config = readConfiguration();
  const selectedId = modelId ?? getDefaultModelId();
  const model = config.models.find((profile) => profile.id === selectedId);
  if (!model) {
    throw new Error(modelId
      ? 'The selected model profile does not exist. Choose a configured model.'
      : 'Configure OPENAI_MODEL and OPENAI_API_KEY, or a models.config.json file, before starting a live task.');
  }
  if (!model.configured) throw new Error('The selected model has no API key. Set its API key environment variable before starting a live task.');
  return model;
}

/** Server-only. Public callers should use only configured and model. */
export function getJevConfiguration() {
  const apiKey = process.env.TYPESAFE_API_KEY?.trim() || '';
  return {
    apiKey,
    configured: Boolean(apiKey),
    model: process.env.TYPESAFE_MODEL?.trim() || 'jev-1.13.0',
    baseURL: validatedBaseURL(process.env.TYPESAFE_BASE_URL?.trim() || 'https://api.typesafe.ai/v1', 'TYPESAFE_BASE_URL'),
  };
}
