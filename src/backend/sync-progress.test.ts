import { expect, test } from "bun:test";
import { Tracker } from "./sync-progress";

const unknown = { accounts: null, folders: null, messages: null };

test("aggregates accounts and hides totals until every account is known", () => {
  const tracker = new Tracker();
  tracker.discovered("a", ["INBOX"]);
  tracker.inventory("a", "INBOX", { validity: 1, live: [], needed: [], headersCached: true });
  let progress = tracker.overall(["a", "b"]);
  expect(progress.accounts).toEqual({ cached: 1, total: 2 });
  expect([progress.folders, progress.messages]).toEqual([null, null]);
  tracker.discovered("b", ["Work"]);
  tracker.inventory("b", "Work", { validity: 2, live: [1, 2], needed: [1, 2], headersCached: true });
  progress = tracker.overall(["a", "b"]);
  expect(progress.folders).toEqual({ cached: 1, total: 2 });
  expect(progress.messages).toEqual({ cached: 0, total: 2 });
  tracker.bodyCached("b", "Work", 2, 1);
  tracker.bodyCached("b", "Work", 2, 2);
  expect(tracker.overall(["a", "b"])).toEqual({ accounts: { cached: 2, total: 2 }, folders: { cached: 2, total: 2 }, messages: { cached: 2, total: 2 } });
  expect(tracker.overall([])).toEqual(unknown);
});

test("hides unknown totals and counts only cached content per account", () => {
  const tracker = new Tracker();
  expect(tracker.progress("a")).toEqual(unknown);
  tracker.inventory("a", "INBOX", { validity: 1, live: [1, 2], needed: [1, 2], headersCached: true });
  tracker.discovered("a", ["Inbox", "Work"]);
  expect(tracker.progress("a").folders).toEqual({ cached: 0, total: 2 });
  expect(tracker.progress("a").messages).toBeNull();
  tracker.inventory("a", "Work", { validity: 2, live: [1], needed: [1], headersCached: false });
  expect(tracker.progress("a").messages).toEqual({ cached: 0, total: 3 });
  tracker.bodyCached("a", "INBOX", 1, 1);
  tracker.bodyCached("a", "INBOX", 1, 1);
  tracker.bodyCached("a", "Work", 1, 1);
  expect(tracker.progress("a").messages).toEqual({ cached: 1, total: 3 });
  tracker.bodyCached("a", "INBOX", 1, 2);
  tracker.bodyCached("a", "Work", 2, 1);
  expect(tracker.progress("a").folders).toEqual({ cached: 1, total: 2 });
  tracker.headersCached("a", "Work", 2);
  expect(tracker.progress("a").folders).toEqual({ cached: 2, total: 2 });
  expect(tracker.progress("a").messages).toEqual({ cached: 3, total: 3 });
  expect(tracker.progress("b")).toEqual(unknown);
  tracker.inventory("a", "INBOX", { validity: 1, live: [1, 2, 3], needed: [3], headersCached: false });
  expect(tracker.progress("a").messages).toEqual({ cached: 3, total: 4 });
  tracker.inventory("a", "INBOX", { validity: 9, live: [1], needed: [1], headersCached: false });
  expect(tracker.progress("a").messages).toEqual({ cached: 1, total: 2 });
});
