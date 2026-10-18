import * as p from "@clack/prompts";

/** Thrown when the developer cancels a question (Ctrl+C or Esc). The CLI exits without a stack trace. */
export class Cancelled extends Error {
  constructor() {
    super("Cancelled.");
  }
}

export interface Choice<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

/** Terminal questions. With `interactive: false` (CI, pipes, --yes) every question returns its default. */
export interface Prompter {
  interactive: boolean;
  /** `validate` returns an error message to show, or undefined to accept. */
  ask(question: string, fallback?: string, validate?: (value: string) => string | undefined): Promise<string>;
  /** Typed characters are masked; the value is never printed. */
  secret(question: string): Promise<string>;
  confirm(question: string, fallback: boolean): Promise<boolean>;
  /** With no `fallback` there is no default: interactive runs must pick one; non-interactive runs get `undefined`. Long lists are searchable. */
  choose<T extends string>(question: string, options: Choice<T>[], fallback?: T): Promise<T | undefined>;
  /** A searchable list to pick one or more values from. Non-interactive runs get `fallback`. */
  pick<T extends string>(question: string, options: Choice<T>[], fallback: T[]): Promise<T[]>;
}

const answer = <T>(value: T): Exclude<T, symbol> => {
  if (p.isCancel(value)) throw new Cancelled();
  return value as Exclude<T, symbol>;
};

export function createPrompter(interactive: boolean): Prompter {
  return {
    interactive,
    async ask(question, fallback = "", validate) {
      if (!interactive) return fallback;
      const value = await p.text({
        message: question,
        placeholder: fallback || undefined,
        defaultValue: fallback,
        validate: validate && ((v) => validate((v ?? "").trim() || fallback)),
      });
      return answer(value).trim() || fallback;
    },
    async secret(question) {
      if (!interactive) return "";
      return (answer(await p.password({ message: question, mask: "•" })) ?? "").trim();
    },
    async confirm(question, fallback) {
      if (!interactive) return fallback;
      return answer(await p.confirm({ message: question, initialValue: fallback }));
    },
    async choose(question, options, fallback) {
      if (!interactive) return fallback;
      const opts = options as p.Option<(typeof options)[number]["value"]>[];
      if (options.length > 8) {
        return answer(await p.autocomplete({ message: question, options: opts, initialValue: fallback, placeholder: "Type to search", maxItems: 8 }));
      }
      return answer(await p.select({ message: question, options: opts, initialValue: fallback }));
    },
    async pick(question, options, fallback) {
      if (!interactive) return fallback;
      const opts = options as p.Option<(typeof options)[number]["value"]>[];
      return answer(
        await p.autocompleteMultiselect({ message: question, options: opts, initialValues: fallback, required: true, placeholder: "Type to search", maxItems: 10 }),
      );
    },
  };
}
