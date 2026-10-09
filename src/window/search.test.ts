import { expect, test } from "bun:test";
import Gtk from "gi://Gtk?version=4.0";
import { type Location, locationKey } from "../backend/search";
import { descendants, settle } from "../components/testing";
import { groups, update, visibleRow } from "../components/virtual-list";
import { message, type Message } from "../models";
import type { ActionTarget } from "../models/action-target";
import { open, showThread } from "./actions";
import { event } from "./events";
import { publishSearchGroups } from "./rendering";
import { senderAction } from "./sender-actions";
import { filterSender, loadSenderPage } from "./sender-pane";
import type { State } from "./state";
import { inbox, present, searchBar, until, useWindows, widget } from "./testing";

useWindows();

const page = (state: State, messages: Message[], hasMore: boolean) =>
  event(state, { type: "SenderPage", generation: state.generation, senderGeneration: state.senderPane.ticket(), messages: structuredClone(messages), hasMore });

const loaded = (state: State, type: "Body" | "Preview", body: Message) => event(state, { type, generation: state.generation, selection: state.selection, message: body });

const unread = (list: Gtk.ListView) => descendants(present(visibleRow(list, 0))).some((child) => child.has_css_class("message-row-sender-unread"));

test("opening unloaded search results requests read updates and preserves them", async () => {
  const { state, window } = inbox("SearchRead");
  const matched = message({ uid: 1, messageId: "search-match", sender: "sender@example.com", bodyLoaded: true, searchMatch: true });
  window.set_default_size(1400, 450);
  window.present();
  update(state.list, [{ key: "sender@example.com", messages: [matched] }], [], null);
  state.list.emit("activate", 0);
  expect(state.messages).toEqual([]);
  expect(state.senderPane.messages()).toEqual([]);
  expect(state.pending.has(matched.uid)).toBe(true);
  await settle(120);
  expect(unread(state.list)).toBe(true);
  loaded(state, "Body", { ...matched, isRead: true, readRevision: 1 });
  expect(present(state.openGroup[0]).isRead).toBe(true);
  expect(state.pending.has(matched.uid)).toBe(false);
  await settle(120);
  expect(unread(state.list)).toBe(false);
  page(state, [matched], false);
  expect(present(state.senderPane.messages()[0]).isRead).toBe(true);

  const older = message({ uid: 2, messageId: "older-match", sender: "sender@example.com" });
  update(state.threadList, [{ key: "older-search-match", messages: [older] }], [], null);
  state.threadList.emit("activate", 0);
  expect(state.selected).toEqual([older.uid]);
  expect(state.pending.has(older.uid)).toBe(true);
  state.pending.delete(older.uid);
  state.previewPending.add(older.uid);
  open(state, older.uid);
  expect(state.pending.has(older.uid)).toBe(false);
  loaded(state, "Preview", { ...older, bodyLoaded: true, bodyText: "Loaded search match" });
  expect(present(state.openGroup[0]).bodyLoaded).toBe(true);
  expect(state.pending.has(older.uid)).toBe(true);
  await settle(120);
  expect(unread(state.threadList)).toBe(true);
  loaded(state, "Body", { ...older, bodyLoaded: true, isRead: true, readRevision: 1 });
  await settle(120);
  expect(unread(state.threadList)).toBe(false);
});

test("search activation keeps only matches as pages and search results arrive", async () => {
  const { state, window } = inbox("SearchNavigation");
  const current = present(state.account);
  state.searchFilters.setAccounts([current]);
  state.searchFilters.setCurrent(current.email);
  state.searchFilters.setCurrentFolder("INBOX", false);
  const location: Location = { account: current.email, folder: "INBOX" };
  window.set_default_size(1400, 450);
  window.present();
  const messages = Array.from({ length: 60 }, (_, index) =>
    message({ uid: 60 - index, timestamp: 60 - index, messageId: `id-${60 - index}`, sender: "sender@example.com", subject: `Message ${60 - index}`, bodyLoaded: true, isRead: true }),
  );
  const match = (index: number) => ({ ...present(messages[index]), searchMatch: true });
  const [matched, older] = [match(49), match(59)];
  update(state.list, [{ key: locationKey(location, "sender@example.com"), messages: [matched, older] }], [], null);
  state.list.emit("activate", 0);
  expect(state.selected).toEqual([matched.uid]);
  expect(present(state.cards.get(matched.uid)).isExpanded()).toBe(true);
  expect(state.searchMessage).toBeNull();
  const visible = () =>
    groups(state.threadList)
      .flat()
      .map((message) => message.uid)
      .sort((left, right) => left - right);
  expect(visible()).toEqual([older.uid, matched.uid]);
  await settle(120);
  const content = present(present(present(visibleRow(state.list, 0)).get_first_child()).get_next_sibling());
  const badge = present(present(content.get_first_child()).get_first_child());
  expect(badge.has_css_class("thread-count-container")).toBe(true);
  expect(widget(badge.get_first_child(), Gtk.Label).get_text()).toBe("2");
  page(state, messages.slice(0, 25), true);
  expect(visible()).toEqual([older.uid, matched.uid]);
  loadSenderPage(state);
  page(state, messages.slice(25, 50), true);
  expect(visible()).toEqual([older.uid, matched.uid]);
  expect(state.selected).toEqual([matched.uid]);
  showThread(state, [older]);
  loadSenderPage(state);
  page(state, messages.slice(50), false);
  expect(visible()).toEqual([older.uid, matched.uid]);
  expect(state.selected).toEqual([older.uid]);

  const laterMatch = match(35);
  searchBar(state.search).set_search_mode(true);
  publishSearchGroups(state, false, "message", [[laterMatch, matched, older]], [location]);
  expect(visible()).toEqual([older.uid, matched.uid, laterMatch.uid]);
  expect(state.selected).toEqual([older.uid]);
  publishSearchGroups(state, false, "message", [[laterMatch]], [location]);
  expect(visible()).toEqual([laterMatch.uid]);
  state.messages = structuredClone(messages);
  state.search.set_text("message 11");
  state.search.emit("search-changed");
  await until(() => !state.searchRunning[0] && Bun.deepEquals(visible(), [matched.uid]));
  const extra = { ...present(messages[0]), uid: 61, timestamp: 0, messageId: "late-match", subject: "Message 11 arrived later" };
  state.senderPane.select(null);
  state.senderPane.select("sender@example.com");
  loadSenderPage(state);
  page(state, [extra], false);
  await until(() => !state.searchRunning[0] && Bun.deepEquals(visible(), [matched.uid, 61]));
  expect(present(groups(state.list)[0]).length).toBe(2);
  searchBar(state.threadSearch).set_search_mode(true);
  state.threadSearch.set_text("arrived");
  state.threadSearch.emit("search-changed");
  await until(() => !state.searchRunning[1] && Bun.deepEquals(visible(), [61]));
  state.threadSearch.set_text("");
  state.threadSearch.emit("search-changed");
  expect(visible()).toEqual([matched.uid, 61]);
  const target: ActionTarget = { kind: "Messages", messages: [[extra.uid, extra.messageId]] };
  showThread(state, [extra]);
  senderAction(state, target, { kind: "Delete" });
  event(state, { type: "SenderActionFinished", account: current.email, folder: "INBOX", sender: target, messages: structuredClone(messages), removed: [extra], error: null });
  await until(() => !state.searchRunning[0] && Bun.deepEquals(visible(), [matched.uid]) && present(groups(state.list)[0]).length === 1);
  filterSender(state, present(messages[0]));
  expect(state.searchSender).toBeNull();
  expect(visible()).toEqual([]);
}, 20_000);
