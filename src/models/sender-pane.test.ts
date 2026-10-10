import { expect, test } from "bun:test";
import { message } from ".";
import { SenderPane } from "./sender-pane";

test("switched and closed sessions reject late pages and errors", () => {
  const pane = new SenderPane();
  pane.select("a@example.com");
  const a = pane.request();
  pane.select("b@example.com");
  const b = pane.request();
  if (!a || !b) throw new Error("requests expected");
  expect(pane.finish(a.ticket, [message()], true)).toBe(false);
  expect(pane.fail(a.ticket)).toBe(false);
  expect(pane.sender()).toBe("b@example.com");
  expect(pane.loading()).toBe(true);
  pane.select(null);
  expect(pane.finish(b.ticket, [message()], true)).toBe(false);
  expect(pane.loading()).toBe(false);
  expect(pane.canLoad()).toBe(false);
  expect(pane.messages()).toEqual([]);
});

test("reopening active sender keeps the session and each page is consumed once", () => {
  const pane = new SenderPane();
  pane.select("a@example.com");
  const first = pane.request();
  if (!first) throw new Error("request expected");
  expect(pane.select(first.sender)).toBe(false);
  expect(pane.request()).toBeNull();
  const item = message({ uid: 10, timestamp: 10 });
  expect(pane.finish(first.ticket, [item], true)).toBe(true);
  const second = pane.request();
  if (!second) throw new Error("request expected");
  expect(second.before).toEqual([10, 10]);
  expect(pane.finish(first.ticket, [item], false)).toBe(false);
  expect(pane.loading()).toBe(true);
  expect(pane.fail(second.ticket)).toBe(true);
  const retry = pane.request();
  if (!retry) throw new Error("request expected");
  expect(retry.before).toEqual(second.before);
  expect(pane.finish(retry.ticket, [], true)).toBe(true);
  expect(pane.canLoad()).toBe(false);
});
