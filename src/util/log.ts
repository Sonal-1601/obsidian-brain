/**
 * Logging that is safe under MCP stdio.
 *
 * The MCP transport owns stdout: any stray byte there corrupts the JSON-RPC
 * stream. Every log therefore goes to stderr, and `setQuiet` lets the MCP
 * entrypoint drop non-error chatter entirely.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold = LEVELS.info;
let quiet = false;
let useColor = process.stderr.isTTY === true && !process.env.NO_COLOR;

const COLORS: Record<LogLevel, string> = {
  debug: "\x1b[90m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

export function setLogLevel(level: LogLevel): void {
  threshold = LEVELS[level];
}

export function setQuiet(value: boolean): void {
  quiet = value;
}

function emit(level: LogLevel, args: unknown[]): void {
  if (LEVELS[level] < threshold) return;
  if (quiet && LEVELS[level] < LEVELS.error) return;
  const tag = useColor ? `${COLORS[level]}${level.padEnd(5)}${RESET}` : level.padEnd(5);
  const prefix = useColor ? `${DIM}sbv${RESET} ${tag}` : `sbv ${tag}`;
  const parts = args.map((a) => (typeof a === "string" ? a : inspect(a)));
  process.stderr.write(`${prefix} ${parts.join(" ")}\n`);
}

function inspect(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const log = {
  debug: (...args: unknown[]) => emit("debug", args),
  info: (...args: unknown[]) => emit("info", args),
  warn: (...args: unknown[]) => emit("warn", args),
  error: (...args: unknown[]) => emit("error", args),
  /** Plain, unprefixed line on stderr — for CLI output that should read as prose. */
  print: (line = "") => {
    if (!quiet) process.stderr.write(`${line}\n`);
  },
};

export function color(text: string, code: keyof typeof COLORS | "bold" | "dim"): string {
  if (!useColor) return text;
  const map: Record<string, string> = { ...COLORS, bold: "\x1b[1m", dim: DIM };
  return `${map[code] ?? ""}${text}${RESET}`;
}

export function disableColor(): void {
  useColor = false;
}
