import { expect, test } from "bun:test";
import { dateLabel, dayLabel, normalize, timeLabel } from "./dates";

test("journey times keep the offset at each stop", () => {
  expect(dateLabel("2026-10-08T13:50:00+02:00")).toBe("Thu, 8 Oct 2026 · 13:50 (UTC+02:00)");
  expect(dateLabel("2026-10-08T15:00:00+01:00")).toBe("Thu, 8 Oct 2026 · 15:00 (UTC+01:00)");
  expect(dateLabel("2026-10-08T15:00")).toBe("Thu, 8 Oct 2026 · 15:00");
  expect(dateLabel("2026-10-08")).toBe("Thu, 8 Oct 2026");
  expect(dateLabel("soon")).toBe("soon");
});

test("invoice offsets match confirmation offsets", () => {
  expect(normalize("2025-11-27T13:00:00+0100")).toBe("2025-11-27T13:00:00+01:00");
  expect(normalize("2025-11-27T12:00:00Z")).toBe("2025-11-27T12:00:00+00:00");
});

test("compact timeline dates keep stop time", () => {
  expect(timeLabel("2026-10-08T13:50:00+02:00")).toBe("13:50");
  expect(timeLabel("2026-10-08T15:00:00+01:00")).toBe("15:00");
  expect(dayLabel("2026-10-08T13:50:00+02:00")).toBe("8 Oct 2026");
  expect(dayLabel("2026-10-08")).toBe("8 Oct 2026");
  expect(timeLabel("2026-10-08")).toBeNull();
});
