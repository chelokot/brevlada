import { expect, test } from "bun:test";
import { groups } from "../components/virtual-list";
import { type Message, message } from "../models";
import type { ActionTarget } from "../models/action-target";
import { showThread } from "./actions";
import { event } from "./events";
import { renderList } from "./rendering";
import { senderAction, visibleMessages } from "./sender-actions";
import { filterSender, loadSenderPage } from "./sender-pane";
import { inbox, present, useWindows } from "./testing";

useWindows();

const target = ({ uid, messageId }: Message): ActionTarget => ({ kind: "Messages", messages: [[uid, messageId]] });

test("removing older mail advances in order and waits for the next sender page", () => {
  const { state, window } = inbox("MessageNavigation", "account");
  const conversation = (uid: number) =>
    message({ uid, timestamp: uid, sender: "a@example.com", subject: `Conversation ${uid}`, messageId: String(uid), bodyLoaded: true, isRead: true });
  const [latest, middle, oldest] = [conversation(3), conversation(2), conversation(1)];
  const elsewhere = message({ uid: 4, timestamp: 4, sender: "b@example.com", subject: "Elsewhere", messageId: "elsewhere", bodyLoaded: true, isRead: true });
  const page = (messages: Message[], hasMore: boolean, ticket = state.senderPane.ticket()) =>
    event(state, { type: "SenderPage", generation: state.generation, senderGeneration: ticket, messages: messages.map((source) => ({ ...source })), hasMore });
  const finished = (removed: Message) =>
    event(state, {
      type: "SenderActionFinished",
      account: "account",
      folder: "INBOX",
      sender: target(removed),
      messages: [{ ...latest }, { ...elsewhere }],
      removed: [{ ...removed }],
      error: null,
    });
  state.messages = [{ ...latest }, { ...elsewhere }];
  renderList(state);
  filterSender(state, latest);
  page([latest, middle, oldest], true);
  loadSenderPage(state);
  const lateTicket = state.senderPane.ticket();
  showThread(state, [middle]);
  senderAction(state, target(middle), { kind: "Archive" });
  expect(state.selected).toEqual([oldest.uid]);
  finished(middle);
  page([middle, oldest], false, lateTicket);
  expect(state.selected).toEqual([oldest.uid]);
  expect(groups(state.threadList).flat().every((message) => message.uid !== middle.uid)).toBe(true);
  senderAction(state, target(latest), { kind: "Delete" });
  senderAction(state, target(oldest), { kind: "Delete" });
  expect(state.selected).toHaveLength(0);
  expect(state.senderPane.sender()).toBe("b@example.com");
  expect(state.senderPane.loading()).toBe(true);
  page([elsewhere], false);
  expect(state.selected).toEqual([elsewhere.uid]);
  expect(present(state.cards.get(elsewhere.uid)).isExpanded()).toBe(true);
  event(state, { type: "CacheList", account: "account", folder: "INBOX", messages: [latest, middle, elsewhere].map((source) => ({ ...source })) });
  expect(visibleMessages(state).every((message) => message.uid !== middle.uid)).toBe(true);
  senderAction(state, target(elsewhere), { kind: "Delete" });
  expect(state.selected).toHaveLength(0);
  expect(state.cards.size).toBe(0);
  expect(state.senderPane.sender()).toBeNull();
  window.close();
});
