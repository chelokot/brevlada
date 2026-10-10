import { expect, test } from "bun:test";
import { groups } from "../components/virtual-list";
import { type Message, message } from "../models";
import { showThread } from "./actions";
import { event } from "./events";
import { renderList } from "./rendering";
import { senderAction } from "./sender-actions";
import { filterSender } from "./sender-pane";
import { inbox, present, useWindows } from "./testing";

useWindows();

test("deleting mail keeps the next message read despite late snapshots", () => {
  const { state, window } = inbox("ReadState", "account");
  const conversation = (uid: number) =>
    message({
      uid,
      uidValidity: 7,
      timestamp: uid,
      sender: "sender@example.com",
      messageId: String(uid),
      subject: `Conversation ${uid}`,
      bodyLoaded: true,
      isRead: false,
      readRevision: 1,
    });
  const [newest, initial, oldest] = [conversation(3), conversation(2), conversation(1)];
  const messages = [newest, initial, oldest];
  const copies = (...sources: Message[]) => sources.map((source) => ({ ...source }));
  const body = (loaded: Message) => event(state, { type: "Body", generation: state.generation, selection: state.selection, message: { ...loaded } });
  const unread = (found: Message | undefined) => !present(found).isRead;
  const second = (source: Message[]) => source.find((message) => message.uid === 2);
  state.messages = copies(...messages);
  renderList(state);
  filterSender(state, newest);
  event(state, { type: "SenderPage", generation: state.generation, senderGeneration: state.senderPane.ticket(), messages: copies(...messages), hasMore: false });
  showThread(state, [newest]);
  senderAction(state, { kind: "Messages", messages: [[3, "3"]] }, { kind: "Delete" });
  expect(state.selected).toEqual([2]);
  expect(state.pending.has(2)).toBe(true);
  body(initial);
  expect(state.pending.has(2)).toBe(true);
  const read = { ...initial, isRead: true, readRevision: 3 };
  body(read);
  expect(state.pending.has(2)).toBe(false);
  const stale = { ...initial, readRevision: 2 };
  event(state, {
    type: "SenderActionFinished",
    account: "account",
    folder: "INBOX",
    sender: { kind: "Messages", messages: [[3, "3"]] },
    messages: copies(stale, oldest),
    removed: copies(newest),
    error: null,
  });
  event(state, { type: "CacheList", account: "account", folder: "INBOX", messages: copies(stale, oldest) });
  body(stale);
  expect(state.pending.has(2)).toBe(false);
  expect(unread(second(state.messages))).toBe(false);
  expect(unread(second(state.senderPane.messages()))).toBe(false);
  expect(present(state.openGroup[0]).isRead).toBe(true);
  expect(unread(second(groups(state.threadList).flat()))).toBe(false);
  event(state, { type: "CacheList", account: "account", folder: "INBOX", messages: copies({ ...initial, readRevision: 4 }, oldest) });
  expect(unread(second(state.messages))).toBe(true);
  expect(state.pending.has(2)).toBe(true);
  body(read);
  expect(present(state.openGroup[0]).isRead).toBe(false);
  expect(state.pending.has(2)).toBe(true);
  event(state, { type: "BodyError", generation: state.generation, selection: state.selection, uid: 2, error: "Read update failed" });
  expect(state.pending.has(2)).toBe(false);
  expect(present(state.openGroup[0]).isRead).toBe(false);
  window.close();
});
