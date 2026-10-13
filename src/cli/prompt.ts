import readline from "node:readline/promises";

/** Terminal questions. With `interactive: false` (CI, pipes, --yes) every question returns its default. */
export interface Prompter {
  interactive: boolean;
  ask(question: string, fallback?: string): Promise<string>;
  /** Typed characters are not echoed; the value is never printed. */
  secret(question: string): Promise<string>;
  confirm(question: string, fallback: boolean): Promise<boolean>;
  /** With no `fallback` there is no default: interactive runs must pick a number; non-interactive runs get `undefined`. */
  choose<T extends string>(question: string, options: { value: T; label: string; help?: string }[], fallback?: T): Promise<T | undefined>;
}

export function createPrompter(interactive: boolean): Prompter {
  const open = () => readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (question: string, fallback = ""): Promise<string> => {
    if (!interactive) return fallback;
    const rl = open();
    try {
      const answer = (await rl.question(`${question}${fallback ? ` (${fallback})` : ""}: `)).trim();
      return answer || fallback;
    } finally {
      rl.close();
    }
  };
  return {
    interactive,
    ask,
    async secret(question) {
      if (!interactive) return "";
      const rl = open();
      process.stdout.write(`${question}: `);
      (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {}; // hide what is typed
      try {
        return (await rl.question("")).trim();
      } finally {
        rl.close();
        process.stdout.write("\n");
      }
    },
    async confirm(question, fallback) {
      const answer = (await ask(`${question} ${fallback ? "[Y/n]" : "[y/N]"}`, "")).toLowerCase();
      return answer ? answer.startsWith("y") : fallback;
    },
    async choose(question, options, fallback) {
      if (!interactive) return fallback;
      console.log(`\n${question}\n`);
      options.forEach((o, i) => {
        console.log(`  ${i + 1}) ${o.label}`);
        if (o.help) console.log(o.help.replace(/^/gm, "     ") + "\n");
      });
      const index = options.findIndex((o) => o.value === fallback);
      const def = index >= 0 ? String(index + 1) : "";
      for (;;) {
        const answer = await ask("Choose a number", def);
        const picked = options[Number(answer) - 1];
        if (picked) return picked.value;
        console.log(`Please enter a number from 1 to ${options.length}.`);
      }
    },
  };
}
