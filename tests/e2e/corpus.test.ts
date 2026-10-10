import { expect, test } from "bun:test";
import { generated, messages } from "./corpus";

test("corpora are byte-identical across generations", () => {
  for (const large of [0, 400]) expect([...messages(large)].map(({ raw }) => raw)).toEqual([...messages(large)].map(({ raw }) => raw));
});

test("every message has a unique Message-ID and a header/body separator", () => {
  const list = [...messages(0), ...generated(400)];
  expect(new Set(list.map(({ id }) => id)).size).toBe(list.length);
  expect(list.filter(({ raw }) => !raw.includes("\r\n\r\n"))).toEqual([]);
});

test("replies reference messages generated earlier", () => {
  const seen = new Set<string>();
  for (const { id, references } of generated(400)) {
    expect(references.filter((reference) => !seen.has(reference))).toEqual([]);
    seen.add(id);
  }
});
