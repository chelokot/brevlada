import { expect, test } from "bun:test";
import { message } from ".";
import type { ActionTarget } from "./action-target";
import { PendingActions } from "./pending-actions";
import type { SenderAction } from "./sender-action";

const one: ActionTarget = { kind: "Messages", messages: [[1, "one"]] };
const spam: SenderAction = { kind: "Spam" };

test("spam stays visible through confirmation and refresh until sender reopens", () => {
  const item = message({ uid: 1, uidValidity: 7, messageId: "one", sender: "sender@example.com", isFlagged: true });
  const pending = new PendingActions();
  pending.retainSpam("a", "INBOX", [item]);
  pending.begin("a", "INBOX", one, spam);
  expect(pending.project("a", "INBOX", item)?.isSpam).toBe(true);
  expect(pending.project("b", "INBOX", item)?.isSpam).toBe(false);
  expect(pending.project("a", "Work", item)?.isSpam).toBe(false);
  pending.finish("a", "INBOX", one);
  pending.finishSpam("a", "INBOX", one, [item]);
  pending.confirmRemoved("a", "INBOX", [item]);
  const retained = pending.visible("a", "INBOX", []);
  expect(retained.length).toBe(1);
  expect(retained[0]).toMatchObject({ isSpam: true, isFlagged: true });
  expect(pending.project("a", "INBOX", { ...item, uidValidity: 8 })?.isSpam).toBe(false);
  expect(pending.dismissSpam("a", "INBOX", "other@example.com")).toBe(false);
  expect(pending.dismissSpam("a", "INBOX", "sender@example.com")).toBe(true);
  expect(pending.visible("a", "INBOX", [])).toEqual([]);
  expect(pending.project("a", "INBOX", item)).toBeNull();
});

test("spam can be undone while pending and retries after a failed undo", () => {
  const item = message({ uid: 1, messageId: "one", sender: "sender@example.com" });
  const pending = new PendingActions();
  pending.retainSpam("a", "INBOX", [item]);
  pending.begin("a", "INBOX", one, spam);
  const undo = pending.undoSpam("a", "INBOX", one);
  expect(undo).toEqual([item]);
  expect(pending.project("a", "INBOX", item)?.isSpam).toBe(false);
  expect(pending.undoSpam("a", "INBOX", one)).toEqual([]);
  pending.finish("a", "INBOX", one);
  pending.finishSpam("a", "INBOX", one, undo);
  pending.confirmRemoved("a", "INBOX", undo);
  pending.finishUndoSpam("a", "INBOX", undo, []);
  expect(pending.visible("a", "INBOX", [])[0]?.isSpam).toBe(true);
  const retry = pending.undoSpam("a", "INBOX", one);
  pending.finishUndoSpam("a", "INBOX", retry, retry);
  expect(pending.visible("a", "INBOX", [])).toEqual([]);

  pending.retainSpam("a", "INBOX", [item]);
  pending.begin("a", "INBOX", one, spam);
  pending.dismissSpam("a", "INBOX", "sender@example.com");
  pending.finish("a", "INBOX", one);
  pending.finishSpam("a", "INBOX", one, [item]);
  expect(pending.visible("a", "INBOX", [])).toEqual([]);
});

test("unread and star projections are reversible and keep messages visible", () => {
  const item = message({ uid: 1, isRead: true, sender: "sender@example.com" });
  const pending = new PendingActions();
  for (const kind of ["MarkUnread", "Star", "Unstar"] as const) {
    pending.begin("a", "INBOX", "sender@example.com", { kind });
    expect(pending.project("a", "INBOX", item)).toMatchObject({ isRead: kind !== "MarkUnread", isFlagged: kind === "Star" });
    expect(pending.project("b", "INBOX", item)).toEqual(item);
    pending.finish("a", "INBOX", "sender@example.com");
    expect(pending.project("a", "INBOX", item)).toEqual(item);
  }
});

test("completed removals reject late snapshots without hiding new mail", () => {
  const old = message({ uid: 1, uidValidity: 7, messageId: "one" });
  const pending = new PendingActions();
  pending.confirmRemoved("a", "INBOX", [old]);
  expect(pending.project("a", "INBOX", old)).toBeNull();
  expect(pending.project("a", "INBOX", { ...old, uidValidity: null })).toBeNull();
  for (const replacement of [{ ...old, uidValidity: 8 }, { ...old, messageId: "new" }, { ...old, uid: 2 }]) expect(pending.project("a", "INBOX", replacement)).not.toBeNull();
  expect(pending.project("b", "INBOX", old)).not.toBeNull();
  expect(pending.project("a", "Archive", old)).not.toBeNull();
});

test("message targets do not affect other conversations or reused uids", () => {
  const first = message({ uid: 1, messageId: "first", sender: "same@example.com" });
  const other = { ...first, uid: 2, messageId: "other" };
  const replaced = { ...first, messageId: "replacement" };
  const target: ActionTarget = { kind: "Messages", messages: [[1, "first"]] };
  const pending = new PendingActions();
  pending.begin("a", "INBOX", target, { kind: "Delete" });
  expect(pending.project("a", "INBOX", first)).toBeNull();
  expect(pending.project("a", "INBOX", other)).toEqual(other);
  expect(pending.project("a", "INBOX", replaced)).toEqual(replaced);
  pending.finish("a", "INBOX", target);
  expect(pending.project("a", "INBOX", first)).toEqual(first);
});

test("pending changes survive stale refreshes and are scoped and reversible", () => {
  const item = message({ sender: "Sender <sender@example.com>" });
  const pending = new PendingActions();
  expect(pending.begin("a", "INBOX", "sender@example.com", { kind: "MarkRead" })).toBe(true);
  expect(pending.begin("a", "INBOX", "sender@example.com", { kind: "Delete" })).toBe(false);
  expect(pending.project("a", "INBOX", item)?.isRead).toBe(true);
  expect(pending.project("b", "INBOX", item)?.isRead).toBe(false);
  expect(pending.project("a", "Archive", item)?.isRead).toBe(false);
  expect(pending.finish("a", "INBOX", "sender@example.com")).toEqual({ kind: "MarkRead" });
  expect(pending.project("a", "INBOX", item)?.isRead).toBe(false);
  for (const kind of ["Delete", "Archive", "Spam"] as const) {
    expect(pending.begin("a", "INBOX", "sender@example.com", { kind })).toBe(true);
    expect(pending.project("a", "INBOX", item)).toBeNull();
    expect(pending.project("b", "INBOX", item)).not.toBeNull();
    pending.finish("a", "INBOX", "sender@example.com");
    expect(pending.project("a", "INBOX", item)).not.toBeNull();
  }
});
