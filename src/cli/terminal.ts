import readline from "node:readline";
import { stripVTControlCharacters, styleText } from "node:util";
import * as p from "@clack/prompts";
import type { Out, Progress } from "./out.js";

const FRAMES = p.unicode ? ["◒", "◐", "◓", "◑"] : ["•", "o", "O", "0"];
const BAR = 20;
const trim = (msg: string) => msg.replace(/^\n+|\n+$/g, "");

/**
 * The CLI's output: clack-styled steps and notes, and a progress line for long translations.
 * The progress line is drawn by hand rather than with clack's spinner: the spinner puts stdin in raw mode and
 * exits on Ctrl+C, while `translate` must catch the first Ctrl+C, save the batch in flight and stop cleanly.
 */
export function createTerminalOut(stream: NodeJS.WriteStream = process.stdout): Out {
  const live = !!stream.isTTY && !p.isCI();
  let active: { print(msg: string): void } | null = null;
  const print = (msg: string) => (active ? active.print(msg) : p.log.message(trim(msg)));

  return {
    log: print,
    ui: {
      intro: (title) => p.intro(styleText("inverse", ` ${title} `)),
      outro: (msg) => p.outro(msg),
      success: (msg) => (active ? active.print(msg) : p.log.success(trim(msg))),
      info: (msg) => (active ? active.print(msg) : p.log.info(trim(msg))),
      warn: (msg) => (active ? active.print(msg) : p.log.warn(trim(msg))),
      error: (msg) => (active ? active.print(msg) : p.log.error(trim(msg))),
      note: (body, title) => p.note(body, title),
      progress(title, total) {
        const bar = live ? liveProgress(stream, title, total, () => (active = null)) : plainProgress(title, total, () => (active = null));
        active = bar;
        return bar;
      },
    },
  };
}

type Bar = Progress & { print(msg: string): void };

function liveProgress(stream: NodeJS.WriteStream, title: string, total: number, onEnd: () => void): Bar {
  let done = 0;
  let detail = "";
  let frame = 0;
  const showCursor = () => stream.write("\x1b[?25h");
  const clear = () => (readline.cursorTo(stream, 0), readline.clearLine(stream, 0));
  const render = () => {
    const filled = total ? Math.min(BAR, Math.round((done / total) * BAR)) : 0;
    const bar = styleText("cyan", "█".repeat(filled)) + styleText("dim", "░".repeat(BAR - filled));
    const head = `${styleText("magenta", FRAMES[frame++ % FRAMES.length]!)}  ${title}  ${bar} ${done}/${total}`;
    const room = (stream.columns || 80) - stripVTControlCharacters(head).length - 3;
    const tail = detail && room > 8 ? styleText("dim", `  ${detail.length > room ? detail.slice(0, room - 1) + "…" : detail}`) : "";
    clear();
    stream.write(head + tail);
  };
  stream.write(`${styleText("gray", "│")}\n\x1b[?25l`);
  process.once("exit", showCursor);
  render();
  const timer = setInterval(render, 80);
  timer.unref();

  const end = (symbol: string, msg: string) => {
    clearInterval(timer);
    clear();
    stream.write(`${symbol}  ${msg}\n`);
    showCursor();
    process.removeListener("exit", showCursor);
    onEnd();
  };
  return {
    advance(n, msg) {
      done = n;
      if (msg !== undefined) detail = msg;
    },
    // Download percentages update the line in place; every other message is printed above it.
    print(msg) {
      const text = trim(msg).trim();
      if (/\d+%/.test(text)) return void (detail = text);
      clear();
      p.log.message(text);
      render();
    },
    stop: (msg) => end(styleText("green", "◇"), msg),
    fail: (msg) => end(styleText("red", "■"), msg),
  };
}

/** Pipes and CI logs: one line per update instead of a redrawn bar. */
function plainProgress(title: string, total: number, onEnd: () => void): Bar {
  p.log.step(`${title}: 0/${total}`);
  let last = 0;
  return {
    advance(n) {
      if (n !== last) p.log.message(`${title}: ${(last = n)}/${total}`);
    },
    print: (msg) => p.log.message(trim(msg)),
    stop: (msg) => (p.log.success(msg), onEnd()),
    fail: (msg) => (p.log.error(msg), onEnd()),
  };
}
