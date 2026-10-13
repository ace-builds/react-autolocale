/**
 * Runs the transform over real-world code and checks that it never crashes and always produces code that still parses.
 * Opt-in, because it reads many files:
 *   RUN_ROBUSTNESS=1 ROBUST_DIRS=/path/one:/path/two pnpm exec vitest run test/robustness.test.ts
 */
import fs from "node:fs";
import path from "node:path";
import { parse } from "@babel/parser";
import { describe, expect, it } from "vitest";
import { codeValuesIn } from "../src/core/facts.js";
import { parserPlugins, transformJsx } from "../src/core/transform.js";

const run = process.env.RUN_ROBUSTNESS ? describe : describe.skip;

function* files(dir: string): Generator<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === ".git" || e.name === ".pnpm") continue;
      yield* files(f);
    } else if (/\.(jsx?|tsx?|mjs)$/.test(e.name) && !e.name.endsWith(".d.ts") && !e.name.endsWith(".min.js")) yield f;
  }
}

run("transform robustness on real code", () => {
  const dirs = (process.env.ROBUST_DIRS ?? "").split(":").filter(Boolean);
  const limit = Number(process.env.ROBUST_LIMIT ?? 4000);
  it(`never crashes or emits invalid code (${dirs.length} folders)`, () => {
    let seen = 0, changed = 0, strings = 0;
    const crashed: string[] = [], invalid: string[] = [];
    for (const dir of dirs) {
      for (const file of files(dir)) {
        if (seen >= limit) break;
        let code: string;
        try {
          code = fs.readFileSync(file, "utf8");
        } catch {
          continue;
        }
        if (code.length > 400_000) continue;
        seen++;
        try {
          const out = transformJsx(code, file, { facts: { codeValues: codeValuesIn(code, file) } });
          if (!out) continue;
          changed++;
          strings += out.strings.length;
          // the output must still be valid code (jsx plugin on, as the transform may add JSX)
          try {
            parse(out.code, { sourceType: "module", plugins: [...new Set([...parserPlugins(file), "jsx"])] as any });
          } catch (e) {
            invalid.push(`${file}: ${(e as Error).message.split("\n")[0]}`);
          }
        } catch (e) {
          crashed.push(`${file}: ${(e as Error).message.split("\n")[0]}`);
        }
      }
    }
    console.log(`checked ${seen} files, ${changed} had text, ${strings} strings`);
    expect(crashed, crashed.slice(0, 5).join("\n")).toEqual([]);
    expect(invalid, invalid.slice(0, 5).join("\n")).toEqual([]);
  }, 600_000);
});
