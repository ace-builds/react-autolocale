#!/usr/bin/env node
import * as p from "@clack/prompts";
import { Config, Errors, flush, run } from "@oclif/core";
import { Cancelled } from "./prompt.js";

/** Edit distance, for "did you mean" on a mistyped command. */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const next = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = next;
    }
  }
  return row[b.length]!;
}

// `react-autolocale --help | head`: a closed pipe is not an error.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
});

// Some terminals (docker run -t, a few CI runners) report 0 columns; clack would then wrap every character.
if (process.stdout.isTTY && !process.stdout.columns) process.stdout.columns = 80;

const config = await Config.load(import.meta.url);
try {
  await run(process.argv.slice(2), config);
} catch (err) {
  const error = err as Error & { oclif?: { exit?: number } };
  const unknown = /^command (\S+) not found$/.exec(error.message ?? "");
  if (err instanceof Cancelled) {
    p.cancel("Cancelled.");
    process.exitCode = 130;
  } else if (unknown) {
    const ids = [...config.commandIDs, ...config.commands.flatMap((c) => c.aliases)];
    // A prefix ("gen", "trans") beats edit distance, which would pick a short unrelated id.
    const prefix = ids.find((id) => id.startsWith(unknown[1]!));
    const best = prefix ? { id: prefix, d: 0 } : ids.map((id) => ({ id, d: distance(unknown[1]!, id) })).sort((a, b) => a.d - b.d)[0];
    p.log.error(`Unknown command "${unknown[1]}".${best && best.d <= 3 ? ` Did you mean \`${config.bin} ${best.id}\`?` : ""}`);
    p.log.message(`Run \`${config.bin} --help\` to see every command.`);
    process.exitCode = 127;
  } else if (error.oclif) {
    // Flag and argument errors, `this.exit()`: oclif prints them with a pointer to --help.
    await Errors.handle(error);
  } else {
    p.cancel(error.message);
    if (process.env.DEBUG) console.error(error.stack);
    process.exitCode = 1;
  }
} finally {
  await flush();
}
