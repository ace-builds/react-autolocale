/**
 * Where commands report to. `log` is all a caller has to provide (tests collect lines); the terminal adds `ui`
 * for styled steps, notes and progress bars. Every helper below falls back to plain `log` lines.
 */
export interface Out {
  log(msg: string): void;
  ui?: Ui;
}

export interface Ui {
  intro(title: string): void;
  outro(msg: string): void;
  success(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  note(body: string, title?: string): void;
  /** A live progress line. Anything logged while it runs is shown in it or printed once it ends. */
  progress(title: string, total: number): Progress;
}

export interface Progress {
  advance(done: number, msg?: string): void;
  stop(msg: string): void;
  fail(msg: string): void;
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export const ok = (out: Out, msg: string) => (out.ui ? out.ui.success(msg) : out.log(`✓ ${msg}`));
export const info = (out: Out, msg: string) => (out.ui ? out.ui.info(msg) : out.log(msg));
export const warn = (out: Out, msg: string) => (out.ui ? out.ui.warn(msg) : out.log(`! ${msg}`));
export const fail = (out: Out, msg: string) => (out.ui ? out.ui.error(msg) : out.log(`✗ ${msg}`));
export const note = (out: Out, body: string, title?: string) => (out.ui ? out.ui.note(body, title) : out.log(title ? `\n${title}:\n${indent(body)}` : `\n${body}`));
export const intro = (out: Out, title: string) => (out.ui ? out.ui.intro(title) : out.log(`${title}\n`));
export const outro = (out: Out, msg: string) => (out.ui ? out.ui.outro(msg) : out.log(`\n${msg}`));

const indent = (s: string) => s.replace(/^/gm, "  ");
