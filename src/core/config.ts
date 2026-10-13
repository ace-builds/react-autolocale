import type { TranslateFn, Translator } from "./translate.js";

/** The free local models (OPUS-MT / NLLB-200 through Transformers.js). Downloads happen only on `translate`. */
export interface LocalProvider {
  name: "local";
}
/** A local LLM served by Ollama. */
export interface OllamaProvider {
  name: "ollama";
  model: string;
  url?: string;
}
/** OpenAI through the official `openai` package (install it in your project). */
export interface OpenAIProvider {
  name: "openai";
  /** Defaults to "gpt-6-astra". */
  model?: string;
  /** Environment variable holding the key. Defaults to OPENAI_API_KEY. */
  apiKeyEnv?: string;
  /** Custom endpoint, e.g. an Azure or self-hosted OpenAI-compatible gateway. */
  baseURL?: string;
}
/** Anthropic Claude through the official `@anthropic-ai/sdk` package (install it in your project). */
export interface AnthropicProvider {
  name: "anthropic";
  /** Defaults to "claude-opus-5-5". */
  model?: string;
  /** Environment variable holding the key. Defaults to ANTHROPIC_API_KEY. */
  apiKeyEnv?: string;
  /** How much the model thinks per request. Short UI strings rarely need more than "low" (the default). */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

/** Google Gemini through its REST API. No SDK needed. Get a key at https://aistudio.google.com/apikey. */
export interface GeminiProvider {
  name: "gemini";
  /** Defaults to "gemini-3.8-flash". Use any model id listed in Google AI Studio. */
  model?: string;
  /** Environment variable holding the key. Defaults to GEMINI_API_KEY. */
  apiKeyEnv?: string;
  /** Custom endpoint, e.g. a proxy. Defaults to https://generativelanguage.googleapis.com/v1beta. */
  baseURL?: string;
}

export type ProviderConfig = LocalProvider | OllamaProvider | OpenAIProvider | AnthropicProvider | GeminiProvider;

export interface AutoLocaleConfig {
  /** Language the source code is written in, e.g. "en". */
  sourceLocale?: string;
  /** Every language the site ships in. The source language may be listed too. */
  locales?: string[];
  /**
   * Where catalogs are written, relative to the project root. Defaults to `src/generated/auto-locale` when the
   * project has a root-level `src/`, otherwise `generated/auto-locale`.
   */
  output?: string;
  /** Folders scanned for JSX. Defaults to "src" (or the project root when there is no src/). */
  include?: string[];
  /** Phrases never translated (brand and product names). Adds to `<AutoScale exclude>`. */
  exclude?: string[];
  /** Terms that must always translate a given way: { fr: { Roadmap: "Feuille de route" } }. */
  glossary?: Record<string, Record<string, string>>;
  /** Translation engine used by `react-autolocale translate`. Defaults to the local models. */
  provider?: ProviderConfig | Translator | TranslateFn;
}

/** Typed helper for auto-locale.config.ts. */
export function defineConfig(config: AutoLocaleConfig): AutoLocaleConfig {
  return config;
}

export const PROVIDER_NAMES = ["local", "ollama", "openai", "anthropic", "gemini"] as const;
export const DEFAULT_MODELS = { openai: "gpt-6-astra", anthropic: "claude-opus-5-5", gemini: "gemini-3.8-flash" } as const;
export const DEFAULT_KEY_ENV = { openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY", gemini: "GEMINI_API_KEY" } as const;
