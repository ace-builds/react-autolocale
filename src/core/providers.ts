import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_KEY_ENV, DEFAULT_MODELS, type AnthropicProvider, type OpenAIProvider } from "./config.js";
import { getLanguage } from "./languages.js";
import type { Project } from "./project.js";
import { createLocalTranslator, ollama, toTranslator, TranslationError, type Translator } from "./translate.js";

export interface ResolvedProvider {
  translator: Translator;
  /** Short name recorded in the cache and shown in reports, e.g. "openai:gpt-6-astra". */
  name: string;
  /** Strings per chunk written to disk. Cloud providers batch inside each chunk. */
  chunkSize: number;
}

/**
 * Builds the configured engine. Called only by the `translate`/`generate`/`sync` commands; the Vite plugin never
 * loads this module. Throws a fatal TranslationError (before any request) when a key or package is missing.
 */
export async function createProvider(project: Project, log: (msg: string) => void): Promise<ResolvedProvider> {
  const p = project.config.provider ?? { name: "local" as const };
  if (typeof p === "function" || "translate" in p) return { translator: toTranslator(p), name: "custom", chunkSize: 40 };
  switch (p.name) {
    case "local":
      return { translator: createLocalTranslator(log), name: "local", chunkSize: 40 };
    case "ollama":
      return { translator: ollama({ model: p.model, url: p.url }), name: `ollama:${p.model}`, chunkSize: 20 };
    case "openai":
      return { translator: await openaiTranslator(project.root, p), name: `openai:${p.model ?? DEFAULT_MODELS.openai}`, chunkSize: 100 };
    case "anthropic":
      return { translator: await anthropicTranslator(project.root, p), name: `anthropic:${p.model ?? DEFAULT_MODELS.anthropic}`, chunkSize: 100 };
  }
}

export function apiKey(provider: "openai" | "anthropic", envName?: string): string {
  const name = envName ?? DEFAULT_KEY_ENV[provider];
  const key = process.env[name];
  if (!key) {
    throw new TranslationError(
      `${name} is not set. Add it to your environment or to .env in the project root (${name}=...), ` +
        `or run \`npx react-autolocale init\` again. No request was made.`,
      true,
    );
  }
  return key;
}

/** Loads a provider SDK from the user's project first (that's where they install it), then from ours. */
async function importFromProject<T>(root: string, pkg: string): Promise<T> {
  try {
    const entry = createRequire(path.join(root, "package.json")).resolve(pkg);
    return (await import(pathToFileURL(entry).href)) as T;
  } catch {
    /* try a normal import next */
  }
  try {
    return (await import(pkg)) as T;
  } catch {
    throw new TranslationError(`This provider needs the "${pkg}" package in your project: npm install -D ${pkg}`, true);
  }
}

// --- Shared LLM batching ------------------------------------------------------------------------------------

const BATCH = 25;
const CONCURRENCY = 3;

export const TRANSLATIONS_SCHEMA = {
  type: "object",
  properties: { translations: { type: "array", items: { type: "string" } } },
  required: ["translations"],
  additionalProperties: false,
} as const;

export function systemPrompt(from: string, to: string): string {
  const name = (code: string) => `${getLanguage(code)?.english ?? code} (${code})`;
  return [
    `You translate user-interface text for a website from ${name(from)} to ${name(to)}.`,
    `The user sends JSON {"items": [{"text", "element"?}]}; "element" is the HTML element or attribute the text appears in.`,
    `Reply with {"translations": [...]}: exactly one translation per item, in the same order.`,
    `Keep tokens such as X0X, X1X and {name} exactly as written. Keep labels as short as the original.`,
    `Translate only; add no notes, quotes or explanations.`,
  ].join("\n");
}

export function userPrompt(texts: string[], contexts: string[]): string {
  return JSON.stringify({ items: texts.map((text, i) => (contexts[i] ? { text, element: contexts[i] } : { text })) });
}

/** Parses {"translations": [...]} and checks there is one string per input. */
export function parseTranslations(raw: string, expected: number): string[] | null {
  try {
    const out = (JSON.parse(raw) as { translations?: unknown }).translations;
    return Array.isArray(out) && out.length === expected && out.every((t) => typeof t === "string") ? (out as string[]) : null;
  } catch {
    return null;
  }
}

/**
 * Splits work into batches, runs a few at a time, and retries a batch one string at a time if the model
 * returns the wrong number of items. Provider SDKs handle timeouts and retries of transient HTTP errors.
 */
export function batchedTranslator(call: (texts: string[], contexts: string[], from: string, to: string) => Promise<string>): Translator {
  const one = async (texts: string[], contexts: string[], from: string, to: string): Promise<string[]> => {
    const parsed = parseTranslations(await call(texts, contexts, from, to), texts.length);
    if (parsed) return parsed;
    if (texts.length === 1) return [""]; // reported as a failed string, never stored
    const out: string[] = [];
    for (let i = 0; i < texts.length; i++) out.push(...(await one([texts[i]!], [contexts[i] ?? ""], from, to)));
    return out;
  };
  return {
    async translate(texts, from, to, contexts = []) {
      const batches: number[] = [];
      for (let i = 0; i < texts.length; i += BATCH) batches.push(i);
      const results: string[][] = new Array(batches.length);
      let next = 0;
      const worker = async () => {
        while (next < batches.length) {
          const b = next++;
          const start = batches[b]!;
          results[b] = await one(texts.slice(start, start + BATCH), contexts.slice(start, start + BATCH), from, to);
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));
      return results.flat();
    },
  };
}

/** Turns SDK errors into TranslationErrors; credential, permission and request errors stop the run. */
function classify(err: unknown, sdk: Record<string, any>, label: string): never {
  const msg = (err as Error).message;
  if (err instanceof sdk.AuthenticationError) throw new TranslationError(`${label}: the API key was rejected (${msg}).`, true);
  if (err instanceof sdk.PermissionDeniedError) throw new TranslationError(`${label}: permission denied (${msg}).`, true);
  if (err instanceof sdk.NotFoundError) throw new TranslationError(`${label}: not found; check the model name (${msg}).`, true);
  if (err instanceof sdk.BadRequestError) throw new TranslationError(`${label}: request rejected (${msg}).`, true);
  if (err instanceof sdk.RateLimitError) throw new TranslationError(`${label}: rate limit or quota reached after retries (${msg}). Run the command again later.`, true);
  if (err instanceof sdk.APIError || err instanceof sdk.APIConnectionError) throw new TranslationError(`${label}: ${msg}`);
  throw err;
}

// --- OpenAI ----------------------------------------------------------------------------------------------------

async function openaiTranslator(root: string, p: OpenAIProvider): Promise<Translator> {
  const key = apiKey("openai", p.apiKeyEnv);
  const sdk = await importFromProject<typeof import("openai")>(root, "openai");
  const OpenAI = sdk.default;
  const client = new OpenAI({ apiKey: key, baseURL: p.baseURL, timeout: 120_000, maxRetries: 3 });
  const model = p.model ?? DEFAULT_MODELS.openai;
  return batchedTranslator(async (texts, contexts, from, to) => {
    try {
      const res = await client.responses.create({
        model,
        instructions: systemPrompt(from, to),
        input: userPrompt(texts, contexts),
        text: { format: { type: "json_schema", name: "translations", strict: true, schema: { ...TRANSLATIONS_SCHEMA } } },
      });
      return res.output_text;
    } catch (err) {
      classify(err, OpenAI as unknown as Record<string, any>, "OpenAI");
    }
  });
}

// --- Anthropic ---------------------------------------------------------------------------------------------------

/** Models that accept server-side refusal fallbacks (`fallbacks: "default"`). */
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

async function anthropicTranslator(root: string, p: AnthropicProvider): Promise<Translator> {
  const key = apiKey("anthropic", p.apiKeyEnv);
  const sdk = await importFromProject<typeof import("@anthropic-ai/sdk")>(root, "@anthropic-ai/sdk");
  const Anthropic = sdk.default;
  const client = new Anthropic({ apiKey: key, timeout: 120_000, maxRetries: 3 });
  const model = p.model ?? DEFAULT_MODELS.anthropic;
  const fallback = FALLBACK_MODELS.has(model);
  return batchedTranslator(async (texts, contexts, from, to) => {
    try {
      const res = await client.beta.messages.create({
        model,
        max_tokens: 16000,
        // A safety-classifier decline is retried on a suitable model server-side instead of failing the batch.
        ...(fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
        system: systemPrompt(from, to),
        messages: [{ role: "user", content: userPrompt(texts, contexts) }],
        output_config: { effort: p.effort ?? "low", format: { type: "json_schema", schema: { ...TRANSLATIONS_SCHEMA } } },
      });
      if (res.stop_reason === "refusal") throw new TranslationError("Claude declined to translate this batch.");
      if (res.stop_reason === "max_tokens") return ""; // too long for one reply: retried one string at a time
      return res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    } catch (err) {
      if (err instanceof TranslationError) throw err;
      classify(err, Anthropic as unknown as Record<string, any>, "Anthropic");
    }
  });
}
