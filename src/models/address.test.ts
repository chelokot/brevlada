import { expect, test } from "bun:test";
import { format, parse } from "./address";

test("parses addresses like mailparse", () => {
  expect(parse("foo bar <foo@bar.com>")).toEqual([{ name: "foo bar", addr: "foo@bar.com" }]);
  expect(parse('"foo \\"nick\\" " <bar@baz.com>, x@y (comment), Team: a@b, "B" <c@d>;')).toEqual([
    { name: 'foo "nick" ', addr: "bar@baz.com" },
    { name: null, addr: "x@y" },
    [
      { name: null, addr: "a@b" },
      { name: "B", addr: "c@d" },
    ],
  ]);
  expect(parse("")).toEqual([]);
  expect(parse("Team:")).toEqual([[]]);
  expect(parse("a@b;")).toEqual([{ name: null, addr: "a@b" }]);
  for (const invalid of ["invalid <", "no-at-sign", "Team: a@b", "\"open"])
    expect(parse(invalid)).toBeNull();
  expect(format({ name: 'A "B"', addr: "a@b" })).toBe('"A \\"B\\"" <a@b>');
});
