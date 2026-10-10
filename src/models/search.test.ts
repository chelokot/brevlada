import { expect, test } from "bun:test";
import { matches, message } from ".";
import { dates, fields, filters, htmlText, includesDate, matchesFields } from "./search";

test("sources control headers and both body formats", () => {
  const values = fields(message({ subject: "Subject needle", bodyText: "Plain needle", bodyHtml: "<p>HTML needle</p>" })).map((field) => field.toLowerCase());
  const selected = filters({ sources: [false, false, false, false, false, false] });
  expect(matchesFields(selected, values, "needle")).toBe(false);
  selected.sources[0] = true;
  expect(matchesFields(selected, values, "subject needle")).toBe(true);
  expect(matchesFields(selected, values, "html needle")).toBe(false);
  selected.sources[5] = true;
  expect(matchesFields(selected, values, "plain needle")).toBe(true);
  expect(matchesFields(selected, values, "html needle")).toBe(true);
});

test("date ranges are optional, inclusive and validated", () => {
  const timestamp = new Date(2026, 9, 2, 23, 59, 59).getTime() / 1000;
  expect(includesDate(filters(), timestamp)).toBe(true);
  expect(includesDate(filters({ from: "2026-10-02", to: "2026-10-02" }), timestamp)).toBe(true);
  expect(includesDate(filters({ to: "2026-10-02" }), timestamp)).toBe(true);
  expect(includesDate(filters({ to: "2026-10-01" }), timestamp)).toBe(false);
  expect(includesDate(filters({ from: "2026-10-03" }), timestamp)).toBe(false);
  expect(dates("", "")).toEqual({ ok: true, value: [null, null] });
  expect(dates(" 2026-10-02 ", "2026-10-03")).toEqual({ ok: true, value: ["2026-10-02", "2026-10-03"] });
  for (const [from, to, error] of [
    ["2026-02-30", "", "Use dates in YYYY-MM-DD format"],
    ["2026-10-03", "2026-10-02", "From must be on or before To"],
    ["2026-10-2", "", "Use dates in YYYY-MM-DD format"],
  ] as const)
    expect(dates(from, to)).toEqual({ ok: false, error });
});

test("searches all fields and visible html with unicode and literal substrings", () => {
  const item = message({
    sender: "Alice <alice@example.com>",
    recipients: "BÖB <bob@example.com>",
    cc: "Carol <carol@example.com>",
    subject: "Résumé 100%",
    bodyText: "Plain message",
    bodyHtml: "<style>hidden-style</style><p>HTML &amp; delivery</p>",
  });
  for (const query of ["alice", "böb", "carol", "résumé", "100%", "plain", "html & delivery"]) expect(matches(item, query)).toBe(true);
  expect(matches(item, "hidden-style")).toBe(false);
  expect(matches(item, "<p>")).toBe(false);
  expect(htmlText("<p>De<span>liv</span>ery</p><p>tomorrow</p>")).toBe("Delivery tomorrow");
});
