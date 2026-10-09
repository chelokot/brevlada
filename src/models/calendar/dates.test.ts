import { expect, test } from "bun:test";
import { event } from "../calendar";
import { local, toRfc3339 } from "../time";
import { label } from "./dates";

const at = (...parts: [number, number, number, number, number]) => toRfc3339(local(new Date(...parts).getTime() / 1000));

test("same day ranges show the date once and keep the timezone", () => {
  expect(label(event({ start: "2026-10-02T17:15:00", end: "2026-10-02T18:00:00", timezone: "Europe/Berlin" }))).toBe(
    "Fri,  2 Oct 2026 · 17:15–18:00 (Europe/Berlin)",
  );
  const start = at(2026, 9, 2, 17, 15);
  expect(label(event({ start, end: at(2026, 9, 2, 18, 0) }))).toBe("Fri,  2 Oct 2026 · 17:15–18:00");
  expect(label(event({ start, end: at(2026, 9, 3, 1, 0) }))).toBe("Fri,  2 Oct 2026 · 17:15 – Sat,  3 Oct 2026 · 01:00");
});

test("calendar all-day end is exclusive but schema end is inclusive", () => {
  expect(label(event({ start: "2026-10-02", end: "2026-10-03", calendar: "" }))).toBe("Fri,  2 Oct 2026 · All day");
  expect(label(event({ start: "2026-10-02", end: "2026-10-03" }))).toBe("Fri,  2 Oct 2026 – Sat,  3 Oct 2026 · All day");
});
