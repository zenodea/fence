import assert from "node:assert/strict";
import { test } from "node:test";
import { parseToml } from "../src/toml.ts";

test("tables, arrays over several lines, inline tables and comments", () => {
  const t = parseToml(`
description = "a \\"pen\\"" # trailing comment
extends = 'strict'

[files]
write = [
  "{pen}", # the folder
  "~/.cache",
]

[env.set]
FOO = "bar"
N = 1_000
ON = true
inline = { a = "b", c = [1, 2] }
`);
  assert.deepEqual(t, {
    description: 'a "pen"',
    extends: "strict",
    files: { write: ["{pen}", "~/.cache"] },
    env: { set: { FOO: "bar", N: 1000, ON: true, inline: { a: "b", c: [1, 2] } } },
  });
});

test("errors say which line", () => {
  assert.throws(() => parseToml(`a = 1\nb = \n`), /line 2/);
  assert.throws(() => parseToml(`a = 1\na = 2`), /set twice/);
  assert.throws(() => parseToml(`[[x]]`), /arrays of tables/);
});
