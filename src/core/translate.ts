import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getLanguage } from "./languages.js";

export interface Translator {
  /** `contexts[i]` says where `texts[i]` appears ("button", "h1", "placeholder", ...). Engines may ignore it. */
  translate(texts: string[], from: string, to: string, contexts?: string[]): Promise<string[]>;
}

/**
 * A translation that could not be done. `fatal` errors (missing key, bad credentials, unknown model, missing
 * package) stop the whole run, since every further request would fail the same way.
 */
export class TranslationError extends Error {
  constructor(
    message: string,
    readonly fatal = false,
  ) {
    super(message);
    this.name = "TranslationError";
  }
}

/** The simplest way to plug in your own engine (DeepL, an LLM, ...): one function. */
export type TranslateFn = (request: { texts: string[]; contexts: string[]; from: string; to: string }) => Promise<string[]>;

export function toTranslator(engine: Translator | TranslateFn): Translator {
  if (typeof engine !== "function") return engine;
  return { translate: (texts, from, to, contexts = []) => engine({ texts, contexts: texts.map((_, i) => contexts[i] ?? ""), from, to }) };
}

/**
 * Uses a local LLM through Ollama (free, runs on your machine). Unlike the default models it is told
 * where each string appears, which fixes most one-word mistakes ("Home" in a nav bar is not "Sommaire").
 */
export function ollama(options: { model: string; url?: string } = { model: "llama3.1" }): Translator {
  const url = (options.url ?? "http://localhost:11434").replace(/\/+$/, "");
  return {
    async translate(texts, from, to, contexts = []) {
      const out: string[] = [];
      for (let i = 0; i < texts.length; i++) {
        const where = contexts[i] ? ` It appears in a website ${contexts[i]} element.` : "";
        const res = await fetch(`${url}/api/chat`, {
          method: "POST",
          signal: AbortSignal.timeout(120_000),
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: options.model,
            stream: false,
            options: { temperature: 0 },
            messages: [
              {
                role: "system",
                content:
                  `You translate website interface text from ${from} to ${to}.${where} ` +
                  `Keep tokens like X0X, X1X and {name} exactly as written. Reply with only the translation.`,
              },
              { role: "user", content: texts[i]! },
            ],
          }),
        }).catch((err: Error) => {
          throw new TranslationError(`Could not reach Ollama at ${url} (${err.message}). Is it running?`, err.name !== "TimeoutError");
        });
        if (!res.ok) throw new TranslationError(`Ollama request failed (${res.status}). Is the model "${options.model}" pulled?`, res.status === 404);
        const body = (await res.json()) as { message?: { content?: string } };
        out.push((body.message?.content ?? "").trim());
      }
      return out;
    },
  };
}

type Engine = typeof import("@huggingface/transformers");

const ENGINE_PACKAGE = "@huggingface/transformers@^4.3.1";
const ENGINE_DIR = path.join(os.homedir(), ".cache", "react-autolocale", "engine");

/**
 * Finds the translation engine. Uses the project's own copy if it has one; otherwise installs it once
 * into ~/.cache/react-autolocale/engine (shared by all projects, never touches the project's node_modules).
 */
async function loadEngine(log: (msg: string) => void): Promise<Engine> {
  try {
    return await import("@huggingface/transformers");
  } catch {
    /* not installed in the project, use the private copy */
  }
  const require = createRequire(path.join(ENGINE_DIR, "package.json"));
  const find = () => require.resolve("@huggingface/transformers");
  let entry: string;
  try {
    entry = find();
  } catch {
    log("[react-autolocale] Installing the translation engine (one time, about 440 MB)...");
    fs.mkdirSync(ENGINE_DIR, { recursive: true });
    const pkg = path.join(ENGINE_DIR, "package.json");
    if (!fs.existsSync(pkg)) fs.writeFileSync(pkg, JSON.stringify({ name: "react-autolocale-engine", private: true }));
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    // Async and captured, so a progress line keeps moving and npm's output doesn't draw over it.
    const errors = await new Promise<string | null>((resolve) => {
      const child = spawn(npm, ["install", "--prefix", ENGINE_DIR, "--no-audit", "--no-fund", "--loglevel=error", ENGINE_PACKAGE], {
        stdio: ["ignore", "ignore", "pipe"],
        shell: process.platform === "win32",
      });
      let stderr = "";
      child.stderr!.on("data", (d) => (stderr += d));
      child.on("error", (err) => resolve(err.message));
      child.on("close", (code) => resolve(code === 0 ? null : stderr.trim() || `npm exited with code ${code}`));
    });
    try {
      if (errors) throw new Error(errors);
      entry = find();
    } catch (err) {
      throw new TranslationError(
        `Could not install the translation engine automatically (${(err as Error).message.split("\n").slice(-3).join(" ")}). ` +
          `Install it yourself: npm install -D @huggingface/transformers`,
        true,
      );
    }
  }
  const mod = await import(pathToFileURL(entry).href);
  return (mod.pipeline ? mod : mod.default) as Engine;
}

type Pipe = (input: string[], options?: Record<string, unknown>) => Promise<{ translation_text: string }[]>;

const NLLB_MODEL = "Xenova/nllb-200-distilled-600M";
// One string per call for NLLB: batched generation with padding produced runaway garbage after the real
// translation. OPUS-MT batches cleanly and runs about 5x faster with 8 strings per call (measured on en->fr/es/de).
const batchSize = (model: string) => (model.includes("opus-mt") ? 8 : 1);

/**
 * Free, offline translation using Transformers.js (ONNX models run on the CPU).
 * Models are downloaded once from Hugging Face and cached in ~/.cache/react-autolocale.
 * English -> X uses small per-language OPUS-MT models where they exist; everything else uses NLLB-200.
 */
export function createLocalTranslator(log: (msg: string) => void = () => {}): Translator {
  const pipes = new Map<string, Promise<Pipe>>();
  let hf: Promise<Engine> | null = null;

  const getPipe = (model: string): Promise<Pipe> => {
    let p = pipes.get(model);
    if (!p) {
      hf ??= loadEngine(log).then((m) => {
        m.env.cacheDir = path.join(os.homedir(), ".cache", "react-autolocale", "models");
        return m;
      });
      log(`Loading model ${model} (downloaded once into ~/.cache/react-autolocale/models)...`);
      const lastPct = new Map<string, number>(); // per file, so each download reports its own progress
      p = hf.then((m) =>
        m.pipeline("translation", model, {
          dtype: "q8",
          progress_callback: (e: any) => {
            if (e.status === "progress" && e.progress - (lastPct.get(e.file) ?? -10) >= 10) {
              lastPct.set(e.file, e.progress);
              log(`  model ${model.split("/").pop()} ${e.file}: ${Math.round(e.progress)}% (download or cache read)`);
            }
          },
        } as any),
      ) as unknown as Promise<Pipe>;
      pipes.set(model, p);
    }
    return p;
  };

  const run = async (model: string, texts: string[], options: Record<string, unknown>): Promise<string[]> => {
    const pipe = await getPipe(model);
    const out: string[] = [];
    const step = batchSize(model);
    for (let i = 0; i < texts.length; i += step) {
      const res = await pipe(texts.slice(i, i + step), { max_new_tokens: 256, ...options });
      out.push(...res.map((r) => r.translation_text.trim()));
    }
    return out;
  };

  return {
    async translate(texts, from, to) {
      const src = getLanguage(from);
      const dst = getLanguage(to);
      if (!src || !dst) throw new Error(`Unsupported language: ${!src ? from : to}`);
      if (from === "en" && dst.opus) {
        try {
          return await run(`Xenova/opus-mt-en-${dst.opus}`, texts, {});
        } catch (err) {
          log(`  OPUS-MT model for "${to}" unavailable (${(err as Error).message}); falling back to NLLB.`);
        }
      }
      return run(NLLB_MODEL, texts, { src_lang: src.nllb, tgt_lang: dst.nllb });
    },
  };
}

const token = (i: number) => `X${i}X`;

/** Prices, phone numbers, versions, hours, percentages: kept exactly as written. */
const NUMBER = /[$€£¥]?\d+(?:[.,:\-/]\d+)*(?:[a-zA-Z]{1,2}\b)?%?/g;
/** Runtime values like {name} must survive translation untouched. */
const PLACEHOLDER = /\{\w+\}/g;

export interface MaskOptions {
  /** Keep numbers exactly as written (default true). */
  numbers?: boolean;
  /** Source term -> required translation. */
  glossary?: Record<string, string>;
}

/**
 * Swaps protected pieces for placeholders so the model leaves them alone: excluded phrases and glossary terms
 * (restored as given), {placeholders}, and numbers. `phrases[i]` is what `X{i}X` turns back into.
 */
export function mask(text: string, exclude: string[], opts: MaskOptions = {}): { masked: string; phrases: string[] } {
  const phrases: string[] = [];
  // Private-use characters (no digits or letters) mark spots first, so later patterns can't match inside them.
  const mark = (restore: string) => {
    phrases.push(restore);
    return String.fromCharCode(0xe000) + String.fromCharCode(0xe100 + phrases.length - 1) + String.fromCharCode(0xe001);
  };
  let masked = text;
  const entries: [string, string][] = [
    ...exclude.map((p): [string, string] => [p, p]),
    ...Object.entries(opts.glossary ?? {}),
  ].sort((a, b) => b[0].length - a[0].length);
  for (const [from, to] of entries) {
    if (from && masked.includes(from)) masked = masked.split(from).join(mark(to));
  }
  masked = masked.replace(PLACEHOLDER, (m) => mark(m));
  if (opts.numbers !== false) masked = masked.replace(NUMBER, (m) => mark(m));
  return {
    masked: masked.replace(/\uE000([\uE100-\uE9FF])\uE001/g, (_, c: string) => token(c.charCodeAt(0) - 0xe100)),
    phrases,
  };
}

/** Puts protected pieces back. Returns null if the model dropped or mangled a placeholder. */
export function unmask(translated: string, phrases: string[]): string | null {
  let out = translated;
  for (let i = 0; i < phrases.length; i++) {
    if (!out.includes(token(i))) return null;
    out = out.split(token(i)).join(phrases[i]!);
  }
  return /X\d+X/.test(out) ? null : out;
}

/** True if every run of digits in the source still appears in the translation. */
export function digitsPreserved(source: string, translated: string): boolean {
  const key = (s: string) => (s.match(/\d+/g) ?? []).sort().join(",");
  return key(source) === key(translated);
}
