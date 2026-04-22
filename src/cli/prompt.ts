/**
 * Minimal interactive-prompt primitives for the `barrieretest` CLI.
 *
 * No dependencies — just Node's `readline` and raw ANSI escape codes. Just
 * enough surface area to drive the `init` wizard: arrow-key single- and
 * multi-select, free-text input, yes/no. Each primitive owns its own
 * raw-mode lifecycle and restores the terminal on exit, error, or Ctrl+C.
 *
 * Not a general-purpose prompt library.
 */

import readline from "node:readline";
import readlinePromises from "node:readline/promises";

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const GRAY = "\x1b[90m";

const SYMBOL_QUESTION = "?";
const SYMBOL_OK = "✓";
const SYMBOL_FAIL = "✗";
const SYMBOL_BULLET = "●";
const SYMBOL_RING = "○";
const SYMBOL_CHECKED = "◼";
const SYMBOL_UNCHECKED = "◻";

export interface SelectOption<T> {
  value: T;
  label: string;
  hint?: string;
}

interface RawKey {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  sequence?: string;
}

/** True when both stdin and stdout are TTYs. Primitives require this. */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** Move cursor up `lines` rows, reset to column 1, and erase to end of screen. */
function clearLines(stdout: NodeJS.WriteStream, lines: number): void {
  if (lines > 0) stdout.write(`\x1b[${lines}A`);
  stdout.write("\x1b[1G\x1b[0J");
}

function countLines(s: string): number {
  if (!s) return 0;
  return s.split("\n").length;
}

function dim(s: string): string {
  return `${GRAY}${s}${RESET}`;
}

export function intro(title: string): void {
  process.stdout.write(`\n${CYAN}${BOLD}${title}${RESET}\n\n`);
}

export function outro(message: string): void {
  process.stdout.write(`\n${GREEN}${SYMBOL_OK}${RESET} ${message}\n\n`);
}

export function note(message: string): void {
  process.stdout.write(`${dim(message)}\n`);
}

export function warn(message: string): void {
  process.stdout.write(`${YELLOW}!${RESET} ${message}\n`);
}

/**
 * Single-select: arrow keys (or j/k) to move, Enter to submit, Ctrl+C to
 * abort (exits the process with code 130).
 */
export async function select<T>(opts: {
  message: string;
  options: SelectOption<T>[];
  initialIndex?: number;
}): Promise<T> {
  if (!isInteractive()) {
    throw new Error("select() requires an interactive TTY");
  }
  if (opts.options.length === 0) {
    throw new Error("select() requires at least one option");
  }

  const stdin = process.stdin;
  const stdout = process.stdout;
  let index = clampIndex(opts.initialIndex ?? 0, opts.options.length);
  let printed = 0;

  const renderFrame = (submitted: boolean): string => {
    const lines: string[] = [];
    if (submitted) {
      const sel = opts.options[index];
      lines.push(
        `${GREEN}${SYMBOL_OK}${RESET} ${BOLD}${opts.message}${RESET} ${CYAN}${sel.label}${RESET}`
      );
    } else {
      lines.push(`${CYAN}${SYMBOL_QUESTION}${RESET} ${BOLD}${opts.message}${RESET}`);
      for (let i = 0; i < opts.options.length; i++) {
        const opt = opts.options[i];
        if (i === index) {
          const hint = opt.hint ? ` ${GRAY}— ${opt.hint}${RESET}` : "";
          lines.push(`  ${CYAN}${SYMBOL_BULLET}${RESET} ${opt.label}${hint}`);
        } else {
          lines.push(`  ${GRAY}${SYMBOL_RING} ${opt.label}${RESET}`);
        }
      }
      lines.push(dim("  ↑/↓ to move · enter to select"));
    }
    return lines.join("\n");
  };

  const draw = (submitted: boolean) => {
    clearLines(stdout, printed);
    const frame = renderFrame(submitted);
    stdout.write(`${frame}\n`);
    printed = countLines(frame);
  };

  return new Promise<T>((resolve) => {
    const rl = readline.createInterface({ input: stdin });
    readline.emitKeypressEvents(stdin, rl);
    const wasRaw = stdin.isRaw ?? false;
    stdin.setRawMode(true);
    stdout.write(HIDE_CURSOR);
    draw(false);

    const onKey = (_str: string, key: RawKey) => {
      if (key.ctrl && key.name === "c") return abort();
      if (key.name === "up" || key.name === "k") {
        index = (index - 1 + opts.options.length) % opts.options.length;
        draw(false);
      } else if (key.name === "down" || key.name === "j") {
        index = (index + 1) % opts.options.length;
        draw(false);
      } else if (key.name === "return") {
        finish();
      }
    };

    const teardown = () => {
      stdin.off("keypress", onKey);
      stdin.setRawMode(wasRaw);
      stdout.write(SHOW_CURSOR);
      rl.close();
    };

    const finish = () => {
      teardown();
      draw(true);
      resolve(opts.options[index].value);
    };

    const abort = () => {
      teardown();
      clearLines(stdout, printed);
      stdout.write(`${RED}${SYMBOL_FAIL}${RESET} ${opts.message} ${dim("(cancelled)")}\n`);
      process.exit(130);
    };

    stdin.on("keypress", onKey);
  });
}

/**
 * Multi-select: arrow keys (or j/k) to move, Space to toggle, `a` to toggle
 * all, Enter to submit. Ctrl+C aborts with 130.
 */
export async function multiselect<T>(opts: {
  message: string;
  options: SelectOption<T>[];
  initialValues?: T[];
  required?: boolean;
}): Promise<T[]> {
  if (!isInteractive()) {
    throw new Error("multiselect() requires an interactive TTY");
  }
  if (opts.options.length === 0) {
    throw new Error("multiselect() requires at least one option");
  }

  const stdin = process.stdin;
  const stdout = process.stdout;
  const selected = new Set<number>();
  for (let i = 0; i < opts.options.length; i++) {
    if (opts.initialValues?.includes(opts.options[i].value)) {
      selected.add(i);
    }
  }
  let index = 0;
  let printed = 0;
  let error: string | null = null;

  const renderFrame = (submitted: boolean): string => {
    const lines: string[] = [];
    if (submitted) {
      const names = Array.from(selected)
        .map((i) => opts.options[i].label)
        .join(", ");
      const display = names || dim("(none)");
      lines.push(
        `${GREEN}${SYMBOL_OK}${RESET} ${BOLD}${opts.message}${RESET} ${CYAN}${display}${RESET}`
      );
    } else {
      lines.push(`${CYAN}${SYMBOL_QUESTION}${RESET} ${BOLD}${opts.message}${RESET}`);
      for (let i = 0; i < opts.options.length; i++) {
        const opt = opts.options[i];
        const checked = selected.has(i);
        const mark = checked
          ? `${GREEN}${SYMBOL_CHECKED}${RESET}`
          : `${GRAY}${SYMBOL_UNCHECKED}${RESET}`;
        const cursor = i === index ? `${CYAN}›${RESET}` : " ";
        const hint = opt.hint ? ` ${GRAY}— ${opt.hint}${RESET}` : "";
        const label = i === index ? opt.label : `${GRAY}${opt.label}${RESET}`;
        lines.push(` ${cursor} ${mark} ${label}${hint}`);
      }
      lines.push(dim("  ↑/↓ to move · space to toggle · a toggles all · enter to submit"));
      if (error) lines.push(`${RED}${SYMBOL_FAIL}${RESET} ${error}`);
    }
    return lines.join("\n");
  };

  const draw = (submitted: boolean) => {
    clearLines(stdout, printed);
    const frame = renderFrame(submitted);
    stdout.write(`${frame}\n`);
    printed = countLines(frame);
  };

  return new Promise<T[]>((resolve) => {
    const rl = readline.createInterface({ input: stdin });
    readline.emitKeypressEvents(stdin, rl);
    const wasRaw = stdin.isRaw ?? false;
    stdin.setRawMode(true);
    stdout.write(HIDE_CURSOR);
    draw(false);

    const onKey = (_str: string, key: RawKey) => {
      if (key.ctrl && key.name === "c") return abort();
      if (key.name === "up" || key.name === "k") {
        index = (index - 1 + opts.options.length) % opts.options.length;
        error = null;
        draw(false);
      } else if (key.name === "down" || key.name === "j") {
        index = (index + 1) % opts.options.length;
        error = null;
        draw(false);
      } else if (key.name === "space") {
        if (selected.has(index)) selected.delete(index);
        else selected.add(index);
        error = null;
        draw(false);
      } else if (key.name === "a") {
        if (selected.size === opts.options.length) {
          selected.clear();
        } else {
          for (let i = 0; i < opts.options.length; i++) selected.add(i);
        }
        error = null;
        draw(false);
      } else if (key.name === "return") {
        if (opts.required && selected.size === 0) {
          error = "Select at least one option.";
          draw(false);
          return;
        }
        finish();
      }
    };

    const teardown = () => {
      stdin.off("keypress", onKey);
      stdin.setRawMode(wasRaw);
      stdout.write(SHOW_CURSOR);
      rl.close();
    };

    const finish = () => {
      teardown();
      draw(true);
      resolve(Array.from(selected).map((i) => opts.options[i].value));
    };

    const abort = () => {
      teardown();
      clearLines(stdout, printed);
      stdout.write(`${RED}${SYMBOL_FAIL}${RESET} ${opts.message} ${dim("(cancelled)")}\n`);
      process.exit(130);
    };

    stdin.on("keypress", onKey);
  });
}

/**
 * Free-text input. Uses readline in cooked mode so the user gets full
 * line-editing (arrow keys, backspace, etc.) for free. Empty input falls
 * back to `opts.default` when provided.
 */
export async function text(opts: {
  message: string;
  default?: string;
  placeholder?: string;
  validate?: (value: string) => string | null;
}): Promise<string> {
  if (!isInteractive()) {
    throw new Error("text() requires an interactive TTY");
  }

  const rl = readlinePromises.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  rl.on("SIGINT", () => {
    rl.close();
    process.stdout.write(`\n${RED}${SYMBOL_FAIL}${RESET} ${opts.message} ${dim("(cancelled)")}\n`);
    process.exit(130);
  });

  try {
    while (true) {
      const hint = opts.default
        ? ` ${GRAY}(${opts.default})${RESET}`
        : opts.placeholder
          ? ` ${GRAY}(${opts.placeholder})${RESET}`
          : "";
      const prompt = `${CYAN}${SYMBOL_QUESTION}${RESET} ${BOLD}${opts.message}${RESET}${hint} `;
      const answer = (await rl.question(prompt)).trim();
      const value = answer || opts.default || "";

      const error = opts.validate?.(value) ?? null;
      if (error) {
        process.stdout.write(`${RED}${SYMBOL_FAIL}${RESET} ${error}\n`);
        continue;
      }

      return value;
    }
  } finally {
    rl.close();
  }
}

/**
 * Yes/no confirmation. Accepts y/yes/n/no case-insensitively; empty input
 * falls back to `opts.default`.
 */
export async function confirm(opts: { message: string; default?: boolean }): Promise<boolean> {
  const defaultValue = opts.default ?? false;
  const suffix = defaultValue ? "Y/n" : "y/N";

  const value = await text({
    message: `${opts.message} ${dim(`(${suffix})`)}`,
    default: defaultValue ? "y" : "n",
    validate: (v) => {
      const lower = v.toLowerCase();
      if (lower === "y" || lower === "yes" || lower === "n" || lower === "no") return null;
      return "Please answer y or n.";
    },
  });

  return value.toLowerCase().startsWith("y");
}

function clampIndex(i: number, length: number): number {
  if (i < 0) return 0;
  if (i >= length) return length - 1;
  return i;
}
