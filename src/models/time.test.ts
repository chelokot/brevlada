import { expect, test } from "bun:test";
import { addDays, compare, format, local, parse, rfc3339, timestamp, toRfc3339 } from "./time";

test("formats every chrono specifier used by the app", () => {
  const date = rfc3339("2026-10-02T07:05:09+02:00");
  expect(date).not.toBeNull();
  if (!date) return;
  expect(format(date, "%A, %-d %B %Y at %H:%M")).toBe("Friday, 2 October 2026 at 07:05");
  expect(format(date, "%a, %e %b %Y · %H:%M:%S (UTC%:z)")).toBe("Fri,  2 Oct 2026 · 07:05:09 (UTC+02:00)");
  expect(format(date, "%m/%d/%y %Y%m%dT%H%M%S")).toBe("10/02/26 20261002T070509");
  expect(format(addDays(date, 30), "%b %d, %Y")).toBe("Nov 01, 2026");
  expect(timestamp(date)).toBe(Date.UTC(2026, 9, 2, 5, 5, 9) / 1000);
});

test("parses like chrono", () => {
  expect(parse("2026-10-2", "%Y-%m-%d")).not.toBeNull();
  expect(parse("2026-02-30", "%Y-%m-%d")).toBeNull();
  expect(parse("2026-10-02T12:00", "%Y-%m-%dT%H:%M:%S")).toBeNull();
  expect(parse("2026-10-02T12:00:00", "%Y-%m-%d")).toBeNull();
  expect(parse("20261002T120000", "%Y%m%dT%H%M%S")).toEqual({ days: 20728, seconds: 43200, nano: 0, offset: 0 });
  expect(parse("2026-10-02 12:00:00.25", "%Y-%m-%d %H:%M:%S%.f")).toEqual({ days: 20728, seconds: 43200, nano: 250_000_000, offset: 0 });
  expect(parse("2026-10-02 12:00:00", "%Y-%m-%d %H:%M:%S%.f")).not.toBeNull();
  expect(parse("2025-11-27T13:00:00+0100", "%Y-%m-%dT%H:%M:%S%z")).toEqual({ days: 20419, seconds: 46800, nano: 0, offset: 3600 });
  expect(rfc3339("2026-10-02T12:00:00.5Z")).toEqual({ days: 20728, seconds: 43200, nano: 500_000_000, offset: 0 });
  expect(rfc3339("2026-10-02T12:00:00+24:00")).toBeNull();
  expect(rfc3339("2026-10-02")).toBeNull();
});

test("writes rfc3339 with chrono precision and compares instants", () => {
  const [left, right] = [rfc3339("2026-10-02T12:00:00.123456+02:00"), rfc3339("2026-10-02T10:00:00.123456Z")];
  expect(left && toRfc3339(left)).toBe("2026-10-02T12:00:00.123456+02:00");
  expect(left && right && compare(left, right)).toBe(0);
  expect(toRfc3339(local(0, 0)).length).toBe(25);
});
