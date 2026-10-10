import { expect, test } from "bun:test";
import { brandOf, isConsumer } from "./sender-domains";

test("redirects bulk mail domains to the brand they send for", () => {
  expect(["redditmail.com", "REDDITMAIL.COM.", "github.com", ""].map(brandOf)).toEqual(["reddit.com", "reddit.com", "github.com", ""]);
});

test("suppresses icons for mailbox providers but not for brands", () => {
  for (const host of ["gmail.com", "GMAIL.COM", "seznam.cz", "proton.me", "gmail.com."]) expect(isConsumer(host)).toBeTrue();
  for (const host of ["github.com", "alza.cz", "offers.proton.me", "mail.zed.dev", "notgmail.com", "gmail.com.evil.example", ""])
    expect(isConsumer(host)).toBeFalse();
});
