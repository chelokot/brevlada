import { expect, test } from "bun:test";
import { message as create } from ".";
import { merge } from "./read-state";

const message = (isRead: boolean, readRevision: number) => create({ uid: 1, uidValidity: 7, messageId: "id", isRead, readRevision });

test("preserves newest read state from all snapshots", () => {
  const snapshots = [message(false, 1), message(true, 3), message(false, 2)];
  const incoming = [message(false, 2)];
  merge(incoming, snapshots);
  expect(incoming[0]).toMatchObject({ isRead: true, readRevision: 3 });
  incoming[0] = message(false, 4);
  merge(incoming, snapshots);
  expect(incoming[0]).toMatchObject({ isRead: false, readRevision: 4 });
});

test("does not merge reused uids or changed mailboxes", () => {
  const incoming = [{ ...message(false, 1), uid: 2 }, { ...message(false, 1), messageId: "replacement" }, { ...message(false, 1), uidValidity: 8 }];
  merge(incoming, [message(true, 3)]);
  expect(incoming.every((item) => !item.isRead)).toBe(true);
});

test("merges read and star revisions independently", () => {
  const incoming = [message(false, 1)];
  merge(incoming, [message(true, 4), { ...message(false, 2), isFlagged: true, flagRevision: 5 }]);
  expect(incoming[0]).toMatchObject({ isRead: true, isFlagged: true, readRevision: 4, flagRevision: 5 });
  merge(incoming, [{ ...message(false, 1), flagRevision: 6 }]);
  expect(incoming[0]).toMatchObject({ isRead: true, isFlagged: false });
});

test("matches messages cached before the mailbox validity was known", () => {
  const incoming = [message(false, 1)];
  merge(incoming, [{ ...message(true, 2), uidValidity: null }]);
  expect(incoming[0]?.isRead).toBe(true);
});
