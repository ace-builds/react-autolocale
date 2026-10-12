import fs from "node:fs";
import path from "node:path";
import { legacyCacheDir } from "./cache.js";
import { writeJson } from "./files.js";
import { BANNER_EN, type BannerText } from "./suggestion.js";
import { mask, unmask, type Translator } from "./translate.js";

/** The banner phrases live next to the catalogs. */
export function bannerFile(output: string): string {
  return path.join(output, "banner.json");
}

/** Banner phrases for the plugin: the generated file, else what older versions cached, else English only. */
export function readBanner(output: string, root: string): Record<string, BannerText> {
  const source = JSON.stringify(BANNER_EN);
  for (const file of [bannerFile(output), path.join(legacyCacheDir(root), "_banner.json")]) {
    try {
      const { _source, ...langs } = JSON.parse(fs.readFileSync(file, "utf8"));
      if (_source === source) return { ...langs, en: BANNER_EN };
    } catch {
      /* not generated yet */
    }
  }
  return { en: BANNER_EN };
}

/** The banner's fixed phrases in every language, so a visitor sees them in their own language. */
export async function ensureBanner(opts: {
  /** Catalog directory. */
  output: string;
  langs: string[];
  getTranslator: () => Translator;
  log?: (msg: string) => void;
}): Promise<Record<string, BannerText>> {
  // The cache is tied to the English source phrases, so rewording them re-translates everything.
  const source = JSON.stringify(BANNER_EN);
  let cached: Record<string, BannerText> = {};
  try {
    const file = JSON.parse(fs.readFileSync(bannerFile(opts.output), "utf8"));
    if (file._source === source) cached = file;
  } catch {
    /* first run */
  }
  const out: Record<string, BannerText> = { en: BANNER_EN };
  let changed = false;
  const keys = Object.keys(BANNER_EN) as (keyof BannerText)[];

  for (const lang of opts.langs) {
    if (lang === "en") continue;
    if (cached[lang]) {
      out[lang] = cached[lang]!;
      continue;
    }
    opts.log?.(`[react-autolocale] ${lang}: translating banner text...`);
    const jobs = keys.map((k) => mask(BANNER_EN[k], ["{language}"]));
    const translated = await opts.getTranslator().translate(jobs.map((j) => j.masked), "en", lang);
    const text = { ...BANNER_EN };
    keys.forEach((k, i) => {
      text[k] = unmask(translated[i] ?? "", jobs[i]!.phrases) ?? BANNER_EN[k];
    });
    out[lang] = text;
    cached[lang] = text;
    changed = true;
  }
  if (changed) writeJson(bannerFile(opts.output), { _source: source, ...cached });
  return out;
}
