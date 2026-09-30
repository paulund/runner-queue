import test from "node:test";
import assert from "node:assert/strict";
import { duration, makeStyler, pad, table, visibleWidth } from "../src/format.js";

const ANSI = /\x1b\[[0-9;]*m/g;

test("durations read the way a person says them", () => {
  assert.equal(duration(0), "0s");
  assert.equal(duration(45), "45s");
  assert.equal(duration(60), "1m 0s");
  assert.equal(duration(754), "12m 34s");
  assert.equal(duration(3600), "1h 00m");
  assert.equal(duration(3 * 3600 + 4 * 60), "3h 04m");
  assert.equal(duration(2 * 86400 + 3 * 3600), "2d 3h");
});

test("a nonsense duration is zero, not NaN in the output", () => {
  assert.equal(duration(undefined), "0s");
  assert.equal(duration(-5), "0s");
  assert.equal(duration("nonsense"), "0s");
});


test("table aligns columns to their widest cell", () => {
  const lines = table(["a", "bb"], [
    ["one", "two"],
    ["a-much-longer-value", "x"],
  ]);
  assert.deepEqual(lines, [
    "a                    bb",
    "one                  two",
    "a-much-longer-value  x",
  ]);
});

test("table measures styled cells by what is displayed", () => {
  // Escape codes take up no columns, so measuring the raw string would push
  // every cell after a coloured one out of line. The proof is that a styled row
  // lines up exactly like the same row without colour.
  const style = makeStyler({ force: true });
  const headers = ["state", "name", "os"];
  const styled = table(headers, [[style.red("offline"), "r1", "macos"]]);
  const plain = table(headers, [["offline", "r1", "macos"]]);

  // "offline" is the widest first cell, "name" the widest second cell.
  assert.equal(styled[1], `${style.red("offline")}  r1    macos`);
  assert.equal(styled[1].replace(ANSI, ""), plain[1]);
});

test("table can align rows without printing a header", () => {
  assert.deepEqual(table(null, [["a", "bb"], ["cccc", "d"]]), [
    "a     bb",
    "cccc  d",
  ]);
  assert.deepEqual(table(null, []), []);
});

test("table does not leave trailing spaces on the last column", () => {
  assert.equal(table(["a"], [["x"]])[1], "x");
});

test("pad right-aligns, which is what numbers want", () => {
  assert.equal(pad(7, 3), "  7");
  assert.equal(pad("7", 3), "  7");
});

test("colour is off when the output is not a terminal", () => {
  const style = makeStyler({ stream: { isTTY: false }, env: {} });
  assert.equal(style.on, false);
  assert.equal(style.red("boom"), "boom");
});

test("colour is off when NO_COLOR is set, even on a terminal", () => {
  const style = makeStyler({ stream: { isTTY: true }, env: { NO_COLOR: "1" } });
  assert.equal(style.on, false);
});

test("colour can be forced on and off regardless of the environment", () => {
  assert.equal(makeStyler({ force: true, env: { NO_COLOR: "1" } }).on, true);
  assert.equal(
    makeStyler({ force: false, stream: { isTTY: true }, env: {} }).on,
    false,
  );
  assert.equal(makeStyler({ stream: { isTTY: true }, env: {} }).red("x"), "\x1b[31mx\x1b[39m");
});

test("every style has a closing code, so colour does not run on", () => {
  const style = makeStyler({ force: true });
  for (const name of ["bold", "dim", "red", "green", "yellow", "blue", "magenta", "cyan"]) {
    const painted = style[name]("x");
    assert.match(painted, /\x1b\[\d+m/, name);
    assert.match(painted, /\x1b\[\d+m$/, `${name} must reset`);
  }
});
