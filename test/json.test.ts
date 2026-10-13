import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isContentJson, jsonModule, jsonStrings } from "../src/core/json.js";
import { scanProjectDetailed } from "../src/core/scan.js";

const faq = JSON.stringify({
  title: "Frequently asked questions",
  url: "https://example.com/faq",
  items: [
    { id: "Main Nav", question: "How does it work?", answer: "You wrap your app once.", href: "/how", type: "Primary" },
    { id: "second", question: "Is it free?", answer: "Yes, the engine is free to use.", tags: ["billing", "Pricing info"] },
  ],
});

describe("jsonStrings", () => {
  it("finds text and skips ids, urls, types and code-like values", () => {
    expect(jsonStrings(faq).map((s) => s.text)).toEqual([
      "Frequently asked questions",
      "How does it work?",
      "You wrap your app once.",
      "Is it free?",
      "Yes, the engine is free to use.",
      "Pricing info",
    ]);
  });

  it("uses the key as context and lets array items inherit it", () => {
    const out = jsonStrings(faq);
    expect(out[0]).toEqual({ text: "Frequently asked questions", key: "title" });
    expect(out.at(-1)).toEqual({ text: "Pricing info", key: "tags" });
  });

  it("never touches strings the code compares", () => {
    expect(jsonStrings(JSON.stringify({ label: "Active", note: "Hello there" }), { codeValues: new Set(["Active"]) }).map((s) => s.text)).toEqual(["Hello there"]);
  });

  it("ignores invalid JSON", () => {
    expect(jsonStrings("{ not json")).toEqual([]);
  });
});

describe("jsonModule", () => {
  it("is a module with a default export, named exports and lookups for the text", () => {
    const code = jsonModule(faq)!;
    expect(code).toContain('import { __rlText } from "react-autolocale"');
    expect(code).toContain("export default __data");
    expect(code).toContain('export const title = __data["title"]');
    expect(code).toMatch(/__rlText\("msg_[0-9a-f]{10}","Frequently asked questions"\)/);
    expect(code).toContain('"https://example.com/faq"'); // the url stays a plain string
    expect(code).toContain('"id":"Main Nav"');
  });

  it("returns null when there is nothing to translate, so Vite handles the file", () => {
    expect(jsonModule(JSON.stringify({ a: 1, url: "https://x.com", theme: "dark" }))).toBeNull();
    expect(jsonModule(JSON.stringify(["a", "b"]))).toBeNull();
  });

  it("evaluates to the same shape as the JSON", async () => {
    const code = jsonModule(faq)!.replace('import { __rlText } from "react-autolocale";', "const __rlText = (_i, s) => s;").replace(/export default __data;|export const [^\n]+/g, "");
    const data = new Function(`${code}; return __data;`)();
    expect(data).toEqual(JSON.parse(faq));
  });
});

describe("isContentJson", () => {
  it("skips config files and skipped folders", () => {
    expect(isContentJson("/p/src/data/faq.json")).toBe(true);
    for (const f of ["/p/package.json", "/p/tsconfig.app.json", "/p/vercel.json", "/p/src/x.schema.json", "/p/node_modules/a/b.json"]) expect(isContentJson(f)).toBe(false);
    expect(isContentJson("/p/src/generated/auto-locale/fr.json", ["/p/src/generated/auto-locale"])).toBe(false);
  });
});

describe("scanning a project with JSON content", () => {
  const make = (files: Record<string, string>) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rl-json-"));
    for (const [f, c] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
      fs.writeFileSync(path.join(root, f), c);
    }
    return root;
  };

  it("reads JSON that source files import, and only that", () => {
    const root = make({
      "src/App.jsx": `import faq from "./data/faq.json";\nimport cfg from "@/data/site.json";\nexport default () => <div>{faq.title}</div>;`,
      "src/data/faq.json": faq,
      "src/data/site.json": JSON.stringify({ tagline: "Build something great" }),
      "src/data/unused.json": JSON.stringify({ title: "I am never imported" }),
      "src/generated/auto-locale/fr.json": JSON.stringify({ msg_1: "Bonjour tout le monde" }),
    });
    const scan = scanProjectDetailed(root, ["src"], { skip: [path.join(root, "src/generated/auto-locale")] });
    expect(scan.strings).toContain("Frequently asked questions");
    expect(scan.strings).toContain("Build something great"); // found through the "@/" alias by its path tail
    expect(scan.strings).not.toContain("I am never imported");
    expect(scan.strings).not.toContain("Bonjour tout le monde");
    expect(scan.files["How does it work?"]).toEqual(["src/data/faq.json"]);
    expect(scan.contexts["Frequently asked questions"]).toBe("title");
  });
});
