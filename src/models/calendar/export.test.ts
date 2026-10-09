import { expect, test } from "bun:test";
import { event, parseIcal } from "../calendar";
import { serialize } from "./export";

test("rejects reversed and mixed date ranges", () => {
  for (const [start, end] of [
    ["2026-10-03", "2026-10-02"],
    ["2026-10-02T19:00:00", "2026-10-02T18:00:00"],
    ["2026-10-02T19:00:00Z", "2026-10-02T18:00:00Z"],
    ["2026-10-02", "2026-10-02T18:00:00Z"],
    ["2026-10-02T18:00:00", "2026-10-02T19:00:00Z"],
  ])
    expect(serialize(event({ name: "Invalid", start, end }))).toBeNull();
});

test("exports dates, escaping, folding and a stable uid", () => {
  const source = event({ name: "å".repeat(100), start: "2026-10-02T19:00:00+02:00", description: "Hello, world;\r\nBEGIN:VALARM" });
  const calendar = serialize(source) ?? "";
  expect(calendar).toContain("DTSTART:20261002T170000Z\r\n");
  expect(calendar).toContain("DESCRIPTION:Hello\\, world\;\\nBEGIN:VALARM");
  expect(calendar.split("\r\n").every((line) => Buffer.byteLength(line) <= 75)).toBe(true);
  const [parsed] = parseIcal(calendar);
  expect(parsed?.name).toBe(source.name);
  expect(parsed?.uid).toBe(parseIcal(serialize(source) ?? "")[0]?.uid ?? "");
  expect(parsed?.uid).toMatch(/^[0-9a-f]{64}@brevlada$/);
  const festival = event({ name: "Festival", start: "2026-10-02", end: "2026-10-03" });
  expect(serialize(festival)).toContain("DTEND;VALUE=DATE:20261004");
  expect(serialize({ ...festival, start: "invalid" })).toBeNull();
});
