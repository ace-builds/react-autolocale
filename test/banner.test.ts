import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ensureBanner } from "../src/core/banner.js";
import { BANNER_EN, suggestLanguage } from "../src/core/suggestion.js";
import type { Translator } from "../src/core/translate.js";

const base = { codes: ["en", "fr", "es"], current: "en", dismissed: [] as string[], chosen: false };

describe("suggestLanguage", () => {
  it("suggests the first supported browser language when it differs from the page", () => {
    expect(suggestLanguage({ ...base, browser: ["fr-FR", "en"] })).toBe("fr");
    expect(suggestLanguage({ ...base, browser: ["de", "es-MX"] })).toBe("es");
  });

  it("offers nothing when it matches the page, is unsupported, dismissed, or a language was chosen", () => {
    expect(suggestLanguage({ ...base, browser: ["en-US"] })).toBeNull();
    expect(suggestLanguage({ ...base, browser: ["ja"] })).toBeNull();
    expect(suggestLanguage({ ...base, browser: ["fr"], dismissed: ["fr"] })).toBeNull();
    expect(suggestLanguage({ ...base, browser: ["fr"], chosen: true })).toBeNull();
  });

  it("can suggest going back to the original language", () => {
    expect(suggestLanguage({ ...base, current: "fr", browser: ["en-GB"] })).toBe("en");
  });
});

describe("ensureBanner", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rl-banner-"));
  const calls: string[][] = [];
  const translator: Translator = {
    async translate(texts, _from, to) {
      calls.push(texts);
      return texts.map((t) => `${to}:${t}`);
    },
  };

  it("translates the phrases once per language, keeping {language} intact, and caches them", async () => {
    const first = await ensureBanner({ output: root, langs: ["en", "fr"], getTranslator: () => translator });
    expect(first.en).toEqual(BANNER_EN);
    expect(first.fr!.prompt).toBe("fr:This page is also available in {language}.");
    expect(first.fr!.switch).toBe("fr:Read in {language}");
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toContain("X0X");

    await ensureBanner({ output: root, langs: ["en", "fr"], getTranslator: () => translator });
    expect(calls).toHaveLength(1); // cached
  });

  it("falls back to English when the model loses the {language} placeholder", async () => {
    const r2 = fs.mkdtempSync(path.join(os.tmpdir(), "rl-banner-"));
    const bad: Translator = { translate: async (texts) => texts.map(() => "no placeholder here") };
    const out = await ensureBanner({ output: r2, langs: ["es"], getTranslator: () => bad });
    expect(out.es!.prompt).toBe(BANNER_EN.prompt);
  });
});
