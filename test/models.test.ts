/**
 * Runs the real translation models. Slow and downloads models, so it only runs on request:
 *   RUN_MODELS=1 pnpm exec vitest run test/models.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ensureTranslations } from "../src/core/cache.js";
import { LANGUAGES } from "../src/core/languages.js";
import { createLocalTranslator, digitsPreserved } from "../src/core/translate.js";

const run = process.env.RUN_MODELS ? describe : describe.skip;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "rl-models-"));

const NUMBERS = [
  "Over 10,000 customers trust us",
  "Save 50% today",
  "Call us at 555-1234",
  "Version 2.5.1 is here",
  "Open 9am-5pm, Monday to Friday",
  "Only $19.99 per month",
  "Join 1,250,000 users",
];

run("number protection with the real models", () => {
  for (const lang of (process.env.NUM_LANGS ?? "fr,es,ja").split(",")) {
    it(`keeps every number intact in ${lang}`, async () => {
      const site = { original: "en", languages: [lang], exclude: [], seo: false };
      const dicts = await ensureTranslations({
        site, strings: NUMBERS, getTranslator: () => createLocalTranslator(), log: () => {},
      });
      for (const s of NUMBERS) {
        const out = dicts[lang]![s];
        console.log(`[${lang}] ${s}  =>  ${out ?? "(kept in English)"}`);
        if (out) expect(digitsPreserved(s, out), `${lang}: ${s} -> ${out}`).toBe(true);
      }
    }, 600_000);
  }
});

// Expected writing system of each language's output, to catch empty, English, or wrong-script results.
const SCRIPT: Record<string, RegExp> = {
  ru: /\p{Script=Cyrillic}/u, uk: /\p{Script=Cyrillic}/u, bg: /\p{Script=Cyrillic}/u,
  zh: /\p{Script=Han}/u, ja: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u,
  ko: /\p{Script=Hangul}/u, ar: /\p{Script=Arabic}/u, fa: /\p{Script=Arabic}/u, ur: /\p{Script=Arabic}/u,
  he: /\p{Script=Hebrew}/u, hi: /\p{Script=Devanagari}/u, bn: /\p{Script=Bengali}/u,
  th: /\p{Script=Thai}/u, el: /\p{Script=Greek}/u,
};
const SAMPLES = ["Welcome to our website", "Save 20% on your first order", "Contact us for help", "Sign in to your account"];

run("every supported language", () => {
  const targets = (process.env.ALL_LANGS ?? LANGUAGES.filter((l) => l.code !== "en").map((l) => l.code).join(",")).split(",");
  for (const lang of targets) {
    it(`${lang}: produces real, complete translations`, async () => {
      const site = { original: "en", languages: [lang], exclude: [], seo: false };
      const dicts = await ensureTranslations({
        site, strings: SAMPLES, getTranslator: () => createLocalTranslator(), log: () => {},
      });
      const problems: string[] = [];
      for (const s of SAMPLES) {
        const out = dicts[lang]![s];
        console.log(`[${lang}] ${s}  =>  ${out ?? "(none)"}`);
        if (!out) problems.push(`no translation for "${s}"`);
        else {
          if (out.trim().toLowerCase() === s.toLowerCase()) problems.push(`unchanged: "${s}"`);
          if (SCRIPT[lang] && !SCRIPT[lang]!.test(out)) problems.push(`wrong script: ${out}`);
          if (out.length > s.length * 4 + 20) problems.push(`runaway output: ${out.slice(0, 60)}`);
          if (/(\b\S+\b)(\s+\1){3,}/u.test(out)) problems.push(`repeated words: ${out.slice(0, 60)}`);
          if (!digitsPreserved(s, out)) problems.push(`digits changed: ${out}`);
        }
      }
      expect(problems, problems.join("; ")).toEqual([]);
    }, 900_000);
  }
});
