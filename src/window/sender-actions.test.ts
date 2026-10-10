import { expect, test } from "bun:test";
import Gdk from "gi://Gdk?version=4.0";
import Gtk from "gi://Gtk?version=4.0";
import { descendants, settle } from "../components/testing";
import { groups, position, selected, selection } from "../components/virtual-list";
import { listHeader, message, type Message } from "../models";
import type { ActionTarget } from "../models/action-target";
import { PendingActions } from "../models/pending-actions";
import { key } from "../models/senders";
import { showThread } from "./actions";
import { event } from "./events";
import { renderList, updateBody } from "./rendering";
import { menuActions, menuActionsForMessages, moveDialog, senderAction, visibleMessages } from "./sender-actions";
import { filterSender } from "./sender-pane";
import type { State } from "./state";
import { account, inbox, next, present, useWindows, widget } from "./testing";

useWindows();

const page = (state: State, messages: Message[], hasMore: boolean) =>
  event(state, { type: "SenderPage", generation: state.generation, senderGeneration: state.senderPane.ticket(), messages: structuredClone(messages), hasMore });

const finished = (state: State, sender: ActionTarget, messages: Message[] | null, removed: Message[], error: string | null) =>
  event(state, { type: "SenderActionFinished", account: "account", folder: "INBOX", sender, messages: structuredClone(messages), removed: structuredClone(removed), error });

const snapshot = (state: State, messages: Message[]) => event(state, { type: "Messages", generation: state.generation, messages: structuredClone(messages), cached: false });

const top = (list: Gtk.ListView) => present(present(groups(list)[0])[0]);

const styled = (widget: Gtk.Widget, cssClass: string) => present(descendants(widget).find((child) => child.has_css_class(cssClass)));

const card = (state: State, uid: number) => present(state.cards.get(uid));

const messagesTarget = (...messages: Message[]): ActionTarget => ({ kind: "Messages", messages: messages.map(({ uid, messageId }) => [uid, messageId]) });

test("menu actions follow the folder leaf and targeted flags", () => {
  const flagged = message({ isFlagged: true });
  const plain = message();
  const kinds = (folder: string, targeted: Message[]) => menuActionsForMessages(folder, targeted).map(({ kind }) => kind);
  expect(kinds("INBOX", [plain])).toEqual(["MarkRead", "MarkUnread", "Star", "MoveTo", "Spam", "Archive", "Delete"]);
  expect(kinds("INBOX", [flagged, plain])).toEqual(["MarkRead", "MarkUnread", "Star", "Unstar", "MoveTo", "Spam", "Archive", "Delete"]);
  expect(kinds("[Gmail]/Trash", [flagged])).toEqual(["MarkRead", "MarkUnread", "Unstar", "MoveTo", "Restore", "Unspam", "Archive", "Delete"]);
  expect(kinds("INBOX.Deleted Messages", [])).toEqual(["MarkRead", "MarkUnread", "MoveTo", "Restore", "Unspam", "Archive", "Delete"]);
  expect(kinds("Junk E-mail", [plain])).toEqual(["MarkRead", "MarkUnread", "Star", "MoveTo", "Unspam", "Archive", "Delete"]);
  expect(kinds("Spam/Archive", [message({ isSpam: true })])).toEqual(["MarkRead", "MarkUnread", "Star", "MoveTo", "Unspam", "Archive", "Delete"]);
  expect(kinds("Bins", [plain])).toContain("Spam");
});

test("reopening a sender after spam keeps the sender scroll position", async () => {
  const { state, window } = inbox("SpamScroll", "account");
  const fixture = (uid: number) => message({ uid, messageId: `message-${uid}`, sender: `sender${uid}@example.com`, subject: `Message ${uid}`, timestamp: uid, isRead: true });
  const activate = async (activated: Message) => {
    const row = present(position(state.list, key(activated)));
    selection(state.list).set_selected(row);
    state.list.grab_focus();
    state.list.scroll_to(row, Gtk.ListScrollFlags.FOCUS, null);
    await settle(200);
    state.list.emit("activate", row);
  };
  for (const hasOlder of [false, true]) {
    filterSender(state, null);
    state.senderActions = new PendingActions();
    const [marked, other] = [fixture(58), fixture(57)];
    const older = { ...marked, uid: 101, timestamp: 0, messageId: "older" };
    state.messages = Array.from({ length: 100 }, (_, index) => fixture(index + 1)).concat(hasOlder ? [older] : []);
    state.visibleLimit = 100;
    renderList(state);
    window.present();
    await settle(200);
    await activate(marked);
    await settle(200);
    const target = messagesTarget(marked);
    senderAction(state, target, { kind: "Spam" });
    finished(state, target, state.messages.filter((message) => message.uid !== marked.uid), [marked], null);
    await settle(200);
    await activate(other);
    await settle(200);
    const row = present(position(state.list, key(marked)));
    selection(state.list).set_selected(row);
    state.list.grab_focus();
    state.list.scroll_to(row, Gtk.ListScrollFlags.FOCUS, null);
    await settle(200);
    const focused = present(window.get_focus());
    expect(focused === state.list || focused.is_ancestor(state.list)).toBe(true);
    const before = state.listScroll.get_vadjustment().get_value();
    expect(before).toBeGreaterThan(0);
    state.list.emit("activate", row);
    await settle(200);
    expect(Math.abs(state.listScroll.get_vadjustment().get_value() - before)).toBeLessThan(1);
    expect(visibleMessages(state).some((message) => message.uid === marked.uid)).toBe(false);
    expect(visibleMessages(state).some((message) => message.uid === older.uid)).toBe(hasOlder);
  }
}, 20_000);

test("spam rows stay open, can be undone and disappear when the sender reopens", () => {
  const { state, commands } = inbox("Spam", "account");
  const first = message({
    uid: 1,
    uidValidity: 7,
    messageId: "one",
    sender: "sender@example.com",
    subject: "Keep this conversation open",
    bodyLoaded: true,
    bodyText: "Cached message body",
    isRead: true,
    isFlagged: true,
    timestamp: 3,
  });
  const second = { ...first, uid: 2, messageId: "two", subject: "Another conversation", timestamp: 2 };
  const other = { ...first, uid: 3, messageId: "other", sender: "other@example.com", timestamp: 1 };
  state.messages = [first, second, other];
  renderList(state);
  filterSender(state, first);
  page(state, [first, second], false);
  showThread(state, [first]);
  const target = messagesTarget(first);
  const icon = styled(card(state, 1).widget, "message-row-spam-icon");
  expect(icon.get_visible()).toBe(false);
  senderAction(state, target, { kind: "Spam" });
  expect(icon.get_visible()).toBe(true);
  expect(state.selected).toEqual([1]);
  expect(visibleMessages(state).length).toBe(3);
  expect(groups(state.threadList).length).toBe(2);
  expect(menuActions(state, target)).toEqual([{ kind: "Unspam" }]);
  commands.length = 0;
  senderAction(state, target, { kind: "Unspam" });
  expect(icon.get_visible()).toBe(false);
  expect(next(commands)).toMatchObject({ type: "UndoSpam", folder: "INBOX", originals: [{ uid: 1 }] });
  finished(state, target, [second, other], [first], null);
  event(state, { type: "CacheList", account: "account", folder: "INBOX", messages: structuredClone([second, other]) });
  expect(visibleMessages(state).length).toBe(3);
  expect(state.selected).toEqual([1]);
  expect(icon.get_visible()).toBe(false);
  event(state, { type: "SpamUndoFinished", account: "account", folder: "INBOX", originals: [{ ...first }], restored: [], messages: null, error: "Retry" });
  expect(icon.get_visible()).toBe(true);
  senderAction(state, target, { kind: "Unspam" });
  const restored = { ...first, uid: 44, bodyLoaded: false, bodyText: "" };
  event(state, {
    type: "SpamUndoFinished",
    account: "account",
    folder: "INBOX",
    originals: [{ ...first }],
    restored: [{ ...first }],
    messages: structuredClone([restored, second, other]),
    error: null,
  });
  const visible = visibleMessages(state);
  expect(visible.length).toBe(3);
  expect(visible.every((message) => !message.isSpam && message.uid !== 1)).toBe(true);
  expect(state.selected).toEqual([44]);
  expect(present(state.openGroup[0]).bodyText).toBe(first.bodyText);
  expect(state.cards.has(44)).toBe(true);
  expect(groups(state.threadList).length).toBe(2);
  expect(selected(state.threadList)).not.toBeNull();
  event(state, { type: "CacheList", account: "account", folder: "INBOX", messages: structuredClone([second, other]) });
  expect(visibleMessages(state).length).toBe(3);
  expect(visibleMessages(state).some((message) => message.uid === 44 && !message.isSpam)).toBe(true);

  const restoredTarget = messagesTarget({ ...first, uid: 44 });
  senderAction(state, restoredTarget, { kind: "Spam" });
  finished(state, restoredTarget, [second, other], [restored], null);
  expect(visibleMessages(state).length).toBe(3);
  filterSender(state, null);
  expect(visibleMessages(state).length).toBe(3);
  filterSender(state, second);
  expect(visibleMessages(state).length).toBe(2);
  page(state, [second], false);
  expect(groups(state.threadList).length).toBe(1);
  const secondTarget = messagesTarget(second);
  senderAction(state, secondTarget, { kind: "Spam" });
  filterSender(state, null);
  filterSender(state, second);
  finished(state, secondTarget, [other], [second], null);
  expect(visibleMessages(state).length).toBe(1);
  expect(visibleMessages(state).every((message) => !message.isSpam)).toBe(true);
});

test("stars, unread and the move picker target the clicked mail", () => {
  const { state, commands } = inbox("MessageActions", "account");
  state.folderNames.set("account", ["INBOX", "Work", "Archive"]);
  const mail = message({ uid: 1, uidValidity: 7, sender: "sender@example.com", messageId: "one", subject: "Message actions", isRead: true, bodyLoaded: true });
  const target = messagesTarget(mail);
  state.messages = [mail];
  renderList(state);
  filterSender(state, mail);
  page(state, [mail], false);
  showThread(state, [mail]);
  const flag = styled(card(state, 1).widget, "message-row-flag-icon");
  expect(flag.get_visible()).toBe(false);
  expect(menuActions(state, target)).toContainEqual({ kind: "Star" });
  senderAction(state, target, { kind: "Star" });
  expect(flag.get_visible()).toBe(true);
  expect(state.selected).not.toEqual([]);
  expect(menuActions(state, target)).toContainEqual({ kind: "Unstar" });
  expect(menuActions(state, target)).not.toContainEqual({ kind: "Star" });
  finished(state, target, [{ ...mail, isFlagged: true, flagRevision: 10 }], [], null);
  expect(flag.get_visible()).toBe(true);
  senderAction(state, target, { kind: "Unstar" });
  expect(flag.get_visible()).toBe(false);
  finished(state, target, [{ ...mail, flagRevision: 11 }], [], null);
  senderAction(state, target, { kind: "MarkUnread" });
  expect(state.selected).toEqual([]);
  expect(present(visibleMessages(state)[0]).isRead).toBe(false);
  finished(state, target, [{ ...mail, isRead: false, readRevision: 12, flagRevision: 11 }], [], null);
  expect(present(state.messages[0]).isRead).toBe(false);
  expect(state.cards.size).toBe(0);

  state.folder = "[Gmail]/Trash";
  expect(menuActions(state, target)).toContainEqual({ kind: "Restore" });
  expect(menuActions(state, target)).toContainEqual({ kind: "Unspam" });
  state.folder = "Junk";
  expect(menuActions(state, target)).toContainEqual({ kind: "Unspam" });
  expect(menuActions(state, target)).not.toContainEqual({ kind: "Spam" });
  state.folder = "INBOX";
  commands.length = 0;
  const dialog = present(moveDialog(state, target));
  const dropdown = widget(dialog.get_extra_child(), Gtk.DropDown);
  expect(present(dropdown.get_model()).get_n_items()).toBe(2);
  dropdown.set_selected(1);
  dialog.response("move");
  expect(next(commands)).toEqual({ type: "SenderAction", account: account("account"), folder: "INBOX", sender: target, action: { kind: "MoveTo", folder: "Work" } });
  expect(visibleMessages(state)).toEqual([]);
});

test("sender action feedback is immediate and failure restores server state", () => {
  const { state, commands, window } = inbox("Sender", "account");
  const mail = message({ uid: 1, sender: "sender@example.com" });
  const sender: ActionTarget = { kind: "Sender", sender: "sender@example.com" };
  state.messages = [mail];
  renderList(state);
  for (const kind of ["MarkRead", "Archive", "Delete", "Spam"] as const) {
    senderAction(state, sender, { kind });
    expect(next(commands)).toMatchObject({ type: "SenderAction", action: { kind } });
    const optimistic = () => {
      if (kind === "MarkRead") expect(top(state.list).isRead).toBe(true);
      else if (kind === "Spam") expect(top(state.list).isSpam).toBe(true);
      else expect(groups(state.list)).toEqual([]);
    };
    optimistic();
    snapshot(state, [mail]);
    optimistic();
    finished(state, sender, null, [], "Server refused action");
    expect(top(state.list)).toEqual(listHeader(mail, false));
  }
  senderAction(state, sender, { kind: "Delete" });
  finished(state, sender, [], [mail], null);
  expect(state.messages).toEqual([]);
  expect(groups(state.list)).toEqual([]);

  const other = { ...mail, uid: 2, subject: "Other conversation", messageId: "other" };
  state.senderActions = new PendingActions();
  state.messages = [mail, other];
  filterSender(state, mail);
  const target = messagesTarget(mail);
  for (const kind of ["MarkRead", "Archive", "Delete", "Spam"] as const) {
    senderAction(state, target, { kind });
    const visible = visibleMessages(state);
    const opened = visible.find((message) => message.uid === 1);
    expect(visible.find((message) => message.uid === 2)).toEqual(other);
    if (kind === "Spam") expect(present(opened).isSpam).toBe(true);
    else if (kind === "MarkRead") expect(present(opened).isRead).toBe(true);
    else expect(opened).toBeUndefined();
    snapshot(state, [mail, other]);
    expect(visibleMessages(state)).toEqual(visible);
    finished(state, target, null, [], "Server refused action");
    expect(visibleMessages(state)).toEqual([mail, other]);
  }

  const unread = { ...mail, uid: 10, timestamp: 1, subject: "Unread", bodyLoaded: true };
  const newer = { ...unread, uid: 11, timestamp: 2, subject: "Newer read", isRead: true };
  const elsewhere = { ...newer, uid: 12, timestamp: 3, sender: "elsewhere@example.com" };
  state.messages = [unread, newer, elsewhere];
  filterSender(state, unread);
  page(state, [unread, newer], false);
  selection(state.threadList).set_selected(0);
  showThread(state, [unread]);
  const read = { ...unread, isRead: true };
  updateBody(state, read);
  expect(selected(state.threadList)).toBeNull();
  expect(top(state.threadList).isRead).toBe(true);
  expect(top(state.list).sender).toBe(unread.sender);
  snapshot(state, state.messages);
  showThread(state, [read]);
  expect(selected(state.threadList)).toBeNull();
  showThread(state, [newer]);
  expect(selected(state.threadList)).toBeNull();
  expect(top(state.list).uid).toBe(newer.uid);

  const controllers = window.observe_controllers();
  const keys = present(
    Array.from({ length: controllers.get_n_items() }, (_, index) => controllers.get_item(index)).find(
      (controller): controller is Gtk.EventControllerKey => controller instanceof Gtk.EventControllerKey && controller.get_name() === "open-message-shortcuts",
    ),
  );
  for (const [removed, kind, expected] of [
    [newer, "Archive", read],
    [read, "Delete", elsewhere],
    [elsewhere, "Delete", null],
  ] as const) {
    expect(state.selected).toEqual([removed.uid]);
    state.composeButton.grab_focus();
    const handled: unknown = keys.emit("key-pressed", kind === "Archive" ? Gdk.KEY_BackSpace : Gdk.KEY_Delete, 0, 0);
    expect(handled).toBe(true);
    if (expected) {
      if (state.senderPane.loading()) page(state, [expected], false);
      expect(state.selected).toEqual([expected.uid]);
      expect(card(state, expected.uid).isExpanded()).toBe(true);
      expect(selected(state.threadList)).toBe(0);
      expect(top(state.threadList).uid).toBe(expected.uid);
    } else {
      expect(state.selected).toEqual([]);
      expect(state.cards.size).toBe(0);
      expect(groups(state.list)).toEqual([]);
    }
  }
});
