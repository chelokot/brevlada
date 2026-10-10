import { expect, test } from "bun:test";
import type { Rsvp } from "../calendar";
import { actions } from "./rsvp";

test("legacy handlers use get and reject unsupported targets", () => {
  const result: Rsvp[] = [];
  for (const [method, url] of [
    ["GET", "https://example.com/yes"],
    ["POST", "https://example.com/no"],
    ["GET", "file:///tmp/event"],
    ["GET", "https://example.com/{response}"],
  ] as const)
    actions({ "@type": "RsvpAction", attendance: "https://schema.org/RsvpAttendance/Yes", handler: { method, url } }, result);
  expect(result).toEqual([{ label: "Yes", url: "https://example.com/yes" }]);
});
