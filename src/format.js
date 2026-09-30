/**
 * Terminal output helpers: durations, column alignment and colour.
 *
 * Colour is created per run rather than read from a global, so the decision is
 * made once, in one place, and tests can force it either way.
 */

const ANSI = /\x1b\[[0-9;]*m/g;

const CODES = {
  bold: [1, 22],
  dim: [2, 22],
  red: [31, 39],
  green: [32, 39],
  yellow: [33, 39],
  blue: [34, 39],
  magenta: [35, 39],
  cyan: [36, 39],
};

/** Strips escape codes so styled text can still be measured and aligned. */
export function visibleWidth(text) {
  return String(text ?? "").replace(ANSI, "").length;
}

/**
 * Builds the styler used by a command. Colour is off when the output is not a
 * terminal, when `NO_COLOR` is set, or when the caller forces it -- which is
 * what `--json` and `--no-colour` do.
 *
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   stream?: { isTTY?: boolean },
 *   force?: boolean,
 * }} [options]
 */
export function makeStyler({ env = process.env, stream = process.stdout, force } = {}) {
  const on =
    force ??
    (Boolean(stream?.isTTY) && !env.NO_COLOR && env.TERM !== "dumb" && !env.CI);

  const style = (name, text) => {
    if (!on) return String(text ?? "");
    const [open, close] = CODES[name] ?? [];
    if (!open) return String(text ?? "");
    return `\x1b[${open}m${text}\x1b[${close}m`;
  };

  return {
    on,
    style,
    bold: (t) => style("bold", t),
    dim: (t) => style("dim", t),
    red: (t) => style("red", t),
    green: (t) => style("green", t),
    yellow: (t) => style("yellow", t),
    blue: (t) => style("blue", t),
    magenta: (t) => style("magenta", t),
    cyan: (t) => style("cyan", t),
  };
}

/** The styler used when no terminal is in play, and by the tests. */
export const PLAIN = makeStyler({ force: false });

/**
 * A duration a person can read at a glance: `45s`, `12m 30s`, `3h 04m`,
 * `2d 3h`. Sub-minute precision is dropped past an hour, where it is noise.
 */
export function duration(seconds) {
  const t = Math.max(0, Math.round(Number(seconds) || 0));
  if (t < 60) return `${t}s`;
  const minutes = Math.floor(t / 60);
  if (minutes < 60) return `${minutes}m ${t % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * Aligns rows into columns, measuring the text as it is displayed rather than
 * as it is stored, so styled cells do not push a row out of line.
 *
 * The padding has to be computed the same way. `String.padEnd` counts escape
 * codes as visible characters, so a coloured cell would come out with no
 * padding at all and the row after it would start in the wrong place.
 *
 * Passing `null` for the headers aligns the rows without printing one.
 */
export function table(headers, rows, { gap = 2 } = {}) {
  const columns = headers?.length ?? Math.max(0, ...rows.map((r) => r.length));
  const all = headers ? [headers, ...rows] : rows;

  const widths = Array.from({ length: columns }, (_, i) =>
    Math.max(0, ...all.map((r) => visibleWidth(r[i]))),
  );
  const padTo = (text, width) =>
    text + " ".repeat(Math.max(0, width - visibleWidth(text)));
  const line = (row) =>
    row
      .map((cell, i) => (i === row.length - 1 ? String(cell ?? "") : padTo(String(cell ?? ""), widths[i] + gap)))
      .join("")
      .replace(/\s+$/, "");

  return all.map(line);
}

/**
 * Right-aligns to a fixed width, which is what numbers want. Measured by
 * visible width, so a styled cell is not pushed out by its own escape codes.
 */
export function pad(text, width) {
  const cell = String(text ?? "");
  return " ".repeat(Math.max(0, width - visibleWidth(cell))) + cell;
}
