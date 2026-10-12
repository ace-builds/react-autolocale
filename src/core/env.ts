import fs from "node:fs";
import path from "node:path";

/** Parses KEY=value lines (optional quotes, # comments, `export ` prefix). */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(raw);
    if (!m) continue;
    let value = m[2]!;
    const quoted = /^(['"])(.*)\1$/.exec(value);
    value = quoted ? quoted[2]! : value.replace(/\s+#.*$/, "");
    out[m[1]!] = value;
  }
  return out;
}

/** Loads .env.local and .env into process.env for the CLI. Variables already set always win. */
export function loadEnv(root: string): void {
  for (const name of [".env.local", ".env"]) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;
    for (const [key, value] of Object.entries(parseEnv(fs.readFileSync(file, "utf8")))) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}
