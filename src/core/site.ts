import fs from "node:fs";
import path from "node:path";
import { parse } from "@babel/parser";
import _traverse from "@babel/traverse";
import * as t from "@babel/types";
import { parserPlugins } from "./transform.js";
import { walk } from "./scan.js";

const traverse: typeof _traverse = (_traverse as any).default ?? _traverse;

export interface SiteConfig {
  /** Language the source code is written in. */
  original: string;
  /** Languages to generate (not including `original`). */
  languages: string[];
  /** Phrases that are never translated (brand and product names). */
  exclude: string[];
  /** Opt in to SEO changes: translated title/meta, canonical, hreflang, sitemap. */
  seo: boolean;
  /** Public site URL, used for absolute hreflang/canonical links and the sitemap. */
  siteUrl?: string;
}

function literal(node: t.Node | null | undefined): string | string[] | boolean | undefined {
  if (!node) return undefined;
  if (t.isJSXExpressionContainer(node)) return literal(node.expression);
  if (t.isStringLiteral(node)) return node.value;
  if (t.isBooleanLiteral(node)) return node.value;
  if (t.isTemplateLiteral(node) && node.expressions.length === 0) return node.quasis[0]!.value.cooked ?? undefined;
  if (t.isArrayExpression(node)) {
    const items = node.elements.map((e) => literal(e));
    return items.every((i) => typeof i === "string") ? (items as string[]) : undefined;
  }
  return undefined;
}

/**
 * Reads the literal props of `<AutoScale ...>` from source code. Returns null if the file has none.
 * With `required: false` (languages come from auto-locale.config.ts), missing props are allowed.
 */
export function parseAutoScale(code: string, file: string, opts: { required?: boolean } = {}): SiteConfig | null {
  if (!code.includes("AutoScale")) return null;
  let ast: t.File;
  try {
    ast = parse(code, { sourceType: "module", plugins: parserPlugins(file) });
  } catch {
    return null;
  }
  let found: SiteConfig | null = null;
  traverse(ast, {
    JSXOpeningElement(path) {
      const name = path.node.name;
      if (found || !t.isJSXIdentifier(name) || name.name !== "AutoScale") return;
      const props: Record<string, string | string[] | boolean | undefined> = {};
      for (const attr of path.node.attributes) {
        if (t.isJSXAttribute(attr) && t.isJSXIdentifier(attr.name)) props[attr.name.name] = attr.value === null ? true : literal(attr.value); // bare `seo` means true
      }
      const { original, languages, exclude, seo, siteUrl } = props;
      if (opts.required !== false && (typeof original !== "string" || !Array.isArray(languages))) {
        throw new Error(
          `${file}: <AutoScale> needs literal props, e.g. original="en" languages={["fr", "es"]}. ` +
            `Values must be written inline (not variables) so they can be read at build time.`,
        );
      }
      found = {
        original: typeof original === "string" ? original : "",
        languages: Array.isArray(languages) ? languages.filter((l) => l !== original) : [],
        exclude: Array.isArray(exclude) ? exclude : [],
        seo: seo === true || seo === "true",
        siteUrl: typeof siteUrl === "string" ? siteUrl : undefined,
      };
    },
  });
  return found;
}

/** Finds the first <AutoScale> in the project's source folders. */
export function findSite(root: string, include: string[]): SiteConfig;
export function findSite(root: string, include: string[], opts: { required: false }): SiteConfig | null;
export function findSite(root: string, include: string[], opts: { required?: boolean } = {}): SiteConfig | null {
  for (const dir of include) {
    for (const file of walk(path.resolve(root, dir))) {
      const site = parseAutoScale(fs.readFileSync(file, "utf8"), file, opts);
      if (site) return site;
    }
  }
  if (opts.required === false) return null;
  throw new Error(
    `No <AutoScale> found in ${include.join(", ")}. Wrap your app: ` +
      `<AutoScale original="en" languages={["fr", "es"]}><App /></AutoScale>`,
  );
}

/** Folders scanned for JSX. */
export function defaultInclude(root: string): string[] {
  return fs.existsSync(path.join(root, "src")) ? ["src"] : ["."];
}
