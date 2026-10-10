import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Expansion } from "./expansion";

test("restores accounts and nested folders independently", async () => {
  const directory = join(tmpdir(), `brevlada-expansion-${crypto.randomUUID()}`);
  const path = join(directory, "expansion.json");
  const state = Expansion.loadFrom(path);
  const first = state.forAccount("first");
  first.set("", true);
  first.set("Work", true);
  first.set("Work/Projects", true);
  state.forAccount("second").set("Work", true);
  first.set("", false);
  first.set("Work", false);
  const restored = Expansion.loadFrom(path);
  expect(restored.forAccount("first").isExpanded("")).toBe(false);
  expect(restored.forAccount("first").isExpanded("Work")).toBe(false);
  expect(restored.forAccount("first").isExpanded("Work/Projects")).toBe(true);
  expect(restored.forAccount("second").isExpanded("Work")).toBe(true);
  expect(restored.forAccount("second").isExpanded("Work/Projects")).toBe(false);
  expect(await Bun.file(path).text()).toBe('{"first":["Work/Projects"],"second":["Work"]}');
  rmSync(directory, { recursive: true });
});
