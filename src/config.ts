// `react-autolocale/config`: safe to import from auto-locale.config.ts (no browser runtime, no Vite).
export { defineConfig } from "./core/config.js";
export type {
  AutoLocaleConfig,
  ProviderConfig,
  LocalProvider,
  OllamaProvider,
  OpenAIProvider,
  AnthropicProvider,
  GeminiProvider,
} from "./core/config.js";
export type { Translator, TranslateFn } from "./core/translate.js";
