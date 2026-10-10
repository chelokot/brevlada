import { expect, test } from "bun:test";
import Adw from "gi://Adw?version=1";
import GLib from "gi://GLib?version=2.0";
import Gtk from "gi://Gtk?version=4.0";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../backend/storage";
import { Avatars, PIXEL } from "../components/avatars";
import { descendants, labels, settle, until } from "../components/testing";
import { groups, item, model, selected, selection, visibleRow } from "../components/virtual-list";
import { listHeader, message, type Message } from "../models";
import { fromMessage } from "../models/draft";
import { identity, key } from "../models/senders";
import type { Status } from "../models/sync";
import { MESSAGE_LIMIT, SIDEBAR_WIDTH } from "../theme";
import { folderKey, hasCachedFolder, load, loadMore, newSelection, select, showThread } from "./actions";
import { renderConversation } from "./conversation";
import { draftKey, newComposer } from "./drafts";
import { event } from "./events";
import { activateSender } from "./lists";
import { applyCachedBody } from "./previews";
import { publishSearchGroups, refreshOpenStyles, renderList, updateBody } from "./rendering";
import { beginSearch, cancelSearch, closeSenderPane, searchOpen, senderSearchActive } from "./search";
import { filterSender, loadSenderPage } from "./sender-pane";
import { rememberSorting } from "./sorting";
import type { State } from "./state";
import { account, inbox, next, present, searchBar, senderTicket, testState, useWindows, widget } from "./testing";

useWindows();

const firstUids = (list: Gtk.ListView) => groups(list).map((group) => present(group[0]).uid);

const page = (state: State, messages: Message[], hasMore: boolean, ticket = senderTicket(state)) =>
  event(state, { type: "SenderPage", generation: state.generation, senderGeneration: ticket, messages, hasMore });

const body = (state: State, loaded: Message) => event(state, { type: "Body", generation: state.generation, selection: state.selection, message: loaded });

const cardOf = (state: State, uid: number) => present(state.cards.get(uid));

test("sending preserves failed edits and labels injected drafts", async () => {
  const { state, commands } = testState("DraftSend");
  state.account = account("account@example.com");
  const received = message({ uid: 1, messageId: "incoming", subject: "Topic", sender: "other@example.com", bodyLoaded: true });
  const compose = present(newComposer(state, "", [received, "INBOX", "Reply"]));
  const header = present(present(compose.widget.get_first_child()).get_next_sibling());
  const error = widget(compose.widget.get_first_child(), Gtk.Label);
  expect(error.has_css_class("error")).toBe(true);
  expect(error.get_visible()).toBe(false);
  const subject = widget(header.get_next_sibling(), Gtk.Entry);
  compose.loadDraft({ ...fromMessage(received), to: "other@example.com", subject: "", text: "Reply body", inReplyTo: "incoming", references: ["incoming"] });
  const send = widget(present(header.get_last_child()).get_prev_sibling(), Gtk.Button);
  expect(send.is_sensitive()).toBe(false);
  expect(send.get_tooltip_text()).toBe("Send");
  expect(next(commands)).toBeNull();
  subject.set_text("Re: Topic");
  send.emit("clicked");
  send.emit("clicked");
  expect(compose.widget.is_sensitive()).toBe(false);
  await settle();
  const sent = next(commands);
  if (sent?.type !== "Compose") throw new Error("Expected message send");
  expect(sent.account.email).toBe("account@example.com");
  expect(sent.draft.to).toBe("other@example.com");
  expect(sent.draft.subject).toBe("Re: Topic");
  expect(sent.draft.inReplyTo).toBe("incoming");
  expect(sent.draft.references).toContain("incoming");
  expect(next(commands)).toBeNull();
  event(state, { type: "Composed", request: sent.request, result: { ok: false, error: "Offline" } });
  expect(compose.widget.is_sensitive()).toBe(true);
  expect(compose.widget.get_visible()).toBe(true);
  expect(error.get_visible()).toBe(true);
  expect(error.get_text()).toBe("Could not send message: Offline");
  expect(widget(header.get_first_child(), Gtk.Entry).get_text()).toBe("other@example.com");
  subject.set_text("Updated topic");
  send.emit("clicked");
  send.emit("clicked");
  expect(error.get_visible()).toBe(false);
  await settle();
  const retried = next(commands);
  if (retried?.type !== "Compose") throw new Error("Expected send");
  expect(retried.draft.subject).toBe("Updated topic");
  expect(retried.draft.text).toBe("Reply body");
  expect(retried.draft.inReplyTo).toBe("incoming");
  expect(next(commands)).toBeNull();
  const outcome = message({ messageId: "sent", bodyLoaded: true, isRead: true, subject: "Re: Topic", recipients: "other@example.com" });
  event(state, { type: "Composed", request: retried.request, result: { ok: true, value: { cleanupError: null, message: outcome } } });
  expect(compose.widget.get_visible()).toBe(false);
  expect(error.get_visible()).toBe(false);
  expect(subject.get_text()).toBe("");
  state.messages = [received];
  showThread(state, [received]);
  const draft = message({ uid: 2, messageId: "draft", isDraft: true, isRead: true, recipients: "other@example.com", bodyLoaded: true });
  event(state, { type: "RelatedSent", generation: state.generation, selection: state.selection, messages: [{ folder: "Drafts", message: draft }] });
  expect(state.sentCards.has("draft")).toBe(false);
  expect(state.sentCards.has("sent")).toBe(true);
  const editor = present(state.draftEditors.get(draftKey(state, "Drafts", "draft")));
  expect(editor.widget.get_parent()).toBe(state.viewer);
  expect(editor.compose.widget.is_sensitive()).toBe(true);
});

test("conversation updates keep existing cards parented", () => {
  const { state } = inbox("CardLifecycle");
  const first = message({ uid: 1, messageId: "first", timestamp: 3, sender: "sender@example.com" });
  const older = { ...first, uid: 2, messageId: "older", timestamp: 1 };
  state.messages = [first, older];
  showThread(state, [first, older]);
  const card = cardOf(state, 1).widget;
  let parentChanges = 0;
  card.connect("notify::parent", () => parentChanges++);
  const sent = message({ uid: 3, messageId: "sent", timestamp: 2, sender: "account@example.com" });
  event(state, { type: "RelatedSent", generation: state.generation, selection: state.selection, messages: [{ folder: "Sent", message: sent }] });
  expect(cardOf(state, 1).widget).toBe(card);
  expect(parentChanges).toBe(0);
  expect(card.get_parent()).toBe(state.viewer);
  expect(state.sentCards.size).toBe(1);
});

test("search result activation uses its owning account and folder", () => {
  const { state } = inbox("SearchAccount");
  const other = account("other@example.com");
  const found = message({ uid: 1, sender: "sender@example.com", searchMatch: true });
  state.folderBoxes.set(other.email, [other, Gtk.Box.new(Gtk.Orientation.VERTICAL, 0)]);
  state.folderCache.set(folderKey(other.email, "Archive"), [found]);
  publishSearchGroups(state, false, "", [[found]], [{ account: other.email, folder: "Archive" }]);
  state.list.emit("activate", 0);
  expect(present(state.account).email).toBe(other.email);
  expect(state.folder).toBe("Archive");
  expect(state.senderPane.sender()).toBe("sender@example.com");
  expect(present(state.searchSender).messages).toHaveLength(1);
  expect(firstUids(state.threadList)[0]).toBe(1);
});

test("back restores accounts after search results switch mailboxes", () => {
  const { state } = inbox("SearchBack");
  const first = present(state.account);
  const second = { ...first, email: "second@example.com" };
  for (const owner of [first, second]) state.folderBoxes.set(owner.email, [owner, Gtk.Box.new(Gtk.Orientation.VERTICAL, 0)]);
  searchBar(state.search).set_search_mode(true);
  state.search.set_text("sender");
  cancelSearch(state, false);
  publishSearchGroups(
    state,
    false,
    "sender",
    [1, 2, 3].map((uid) => [message({ uid, sender: `sender${uid}@example.com`, searchMatch: true })]),
    [
      { account: first.email, folder: "INBOX" },
      { account: second.email, folder: "INBOX" },
      { account: second.email, folder: "Archive" },
    ],
  );
  state.accountSidebar.setVisible(true);
  for (const position of [0, 0, 1, 2]) {
    activateSender(state, position);
    expect(state.accountSidebar.getVisible()).toBe(false);
    expect(state.threadSidebar.getVisible()).toBe(true);
    expect(state.restoreAccountsOnBack).toBe(true);
  }
  filterSender(state, null);
  expect(state.accountSidebar.getVisible()).toBe(true);
  expect(state.threadSidebar.getVisible()).toBe(false);
  expect(state.back.get_visible()).toBe(false);
  expect(senderSearchActive(state)).toBe(true);
  expect(model(state.list).get_n_items()).toBe(3);
  state.accountSidebar.setVisible(false);
  for (const position of [0, 1]) activateSender(state, position);
  filterSender(state, null);
  expect(state.accountSidebar.getVisible()).toBe(false);
  state.accountSidebar.setVisible(true);
  activateSender(state, 0);
  state.accountSidebar.setVisible(true);
  state.accountSidebar.setVisible(false);
  activateSender(state, 1);
  filterSender(state, null);
  expect(state.accountSidebar.getVisible()).toBe(false);
  state.accountSidebar.setVisible(true);
  activateSender(state, 0);
  searchBar(state.threadSearch).set_search_mode(true);
  state.threadSearch.set_text("sender");
  closeSenderPane(state);
  expect(state.accountSidebar.getVisible()).toBe(true);
  expect(state.threadSidebar.getVisible()).toBe(false);
  expect(state.back.get_visible()).toBe(false);
  expect(senderSearchActive(state)).toBe(false);
  expect(searchOpen(state, true)).toBe(false);
  expect(state.search.get_text()).toBe("");
  expect(state.threadSearch.get_text()).toBe("");
  expect(state.searchRunning).toEqual([false, false]);
  expect(state.searchSender).toBeNull();
  expect(state.searchLocations.size).toBe(0);
});

test.skipIf(!process.env["BREVLADA_SEARCH_TEST_DATA"])("account search without current appends results and closing restores normal loading", async () => {
  expect(GLib.get_user_data_dir()).toBe(present(process.env["BREVLADA_SEARCH_TEST_DATA"]));
  const { state, window } = testState("SearchLifecycle");
  window.present();
  const first = account("account@example.com");
  const second = account("second@example.com");
  const alpha = message({ uid: 1, timestamp: 1, sender: "alpha@example.com" });
  const beta = message({ uid: 1, timestamp: 2, sender: "beta@example.com" });
  const storage = Storage.open(join(GLib.get_user_data_dir(), "brevlada", "emails.db"));
  storage.store(first.email, "INBOX", alpha);
  storage.store(second.email, "INBOX", beta);
  event(state, { type: "Accounts", accounts: [first, second] });
  state.accountTitle.set_label(first.email);
  state.accountSidebar.setVisible(false);
  expect(state.accountTitle.get_text()).toBe("");
  const bar = searchBar(state.search);
  bar.set_search_mode(true);
  expect(state.accountTitle.get_text()).toBe("All accounts");
  expect(state.accountTitle.get_visible()).toBe(true);
  expect(model(state.list).get_n_items()).toBe(0);
  expect(state.searchRunning[0]).toBe(false);
  state.search.set_text("example.com");
  expect(state.searchRunning[0]).toBe(true);
  expect(state.listStack.get_visible_child_name()).toBe("state");
  const filterButton = (pick: (row: Gtk.Widget) => Gtk.Widget | null) =>
    present(widget(pick(present(state.searchFilters.widget.get_first_child())), Gtk.MenuButton).get_popover()).get_child();
  const accounts = widget(
    filterButton((row) => row.get_first_child()),
    Gtk.Box,
  );
  expect(state.searchFilters.selectedAccounts().size).toBe(2);
  const searched = (count: number) => () => !state.searchRunning[0] && model(state.list).get_n_items() === count;
  await until(searched(2));
  await until(() => labels(state.list).includes(`${first.email} · INBOX`));
  expect(labels(state.list)).toContain(`${second.email} · INBOX`);
  expect(state.account).toBeNull();
  expect(state.accountTitle.get_text()).toBe("All accounts");
  const secondCheck = widget(present(accounts.get_last_child()).get_prev_sibling(), Gtk.CheckButton);
  secondCheck.set_active(false);
  await until(searched(1));
  await until(() => labels(state.list).includes("INBOX"));
  expect(labels(state.list)).not.toContain(`${first.email} · INBOX`);
  const retained = present(item(state.list, 0)).key;
  secondCheck.set_active(true);
  await until(searched(2));
  expect(present(item(state.list, 0)).key).toBe(retained);
  expect(groups(state.list).map((group) => present(group[0]).sender)).toEqual([alpha.sender, beta.sender]);
  const row = model(state.list).get_item(0);
  let loaderShows = 0;
  const observer = state.searchProgress[0].connect("notify::visible", (spinner) => {
    if (spinner.is_visible()) loaderShows++;
  });
  state.list.emit("activate", 1);
  expect(state.searchRunning[0]).toBe(false);
  expect(present(state.account).email).toBe(second.email);
  expect(state.searchFilters.selectedAccounts().size).toBe(2);
  expect(model(state.list).get_n_items()).toBe(2);
  await until(() => !state.searchRunning[0]);
  expect(model(state.list).get_n_items()).toBe(2);
  expect(model(state.list).get_item(0)).toBe(row);
  event(state, { type: "Messages", generation: state.generation, messages: [beta], cached: false });
  showThread(state, [beta]);
  await settle(350);
  expect(loaderShows).toBe(0);
  expect(model(state.list).get_item(0)).toBe(row);
  state.searchProgress[0].disconnect(observer);
  state.search.set_text(alpha.sender);
  filterSender(state, alpha);
  renderList(state);
  bar.set_search_mode(false);
  expect(state.search.get_text()).toBe("");
  expect(state.senderPane.sender()).toBeNull();
  expect(senderSearchActive(state)).toBe(false);
  select(state, first, "INBOX");
  event(state, { type: "Messages", generation: state.generation, messages: [alpha], cached: false });
  event(state, { type: "CacheList", account: second.email, folder: "INBOX", messages: [beta] });
  await settle(250);
  expect(senderSearchActive(state)).toBe(false);
  expect(state.searchLocations.size).toBe(0);
  expect(model(state.list).get_n_items()).toBe(1);
  expect(present(groups(state.list)[0])[0]?.sender).toBe(alpha.sender);
  expect(state.listStack.get_visible_child_name()).toBe("list");
  const archived = message({ uid: 1, timestamp: 3, sender: "archived@example.com" });
  storage.store(second.email, "Archive", archived);
  bar.set_search_mode(true);
  expect(state.searchFilters.selectedAccounts()).toEqual(new Set([first.email]));
  expect(state.searchFilters.folder()).toBe("INBOX");
  const folderChoices = present(filterButton((row) => row.get_last_child()));
  widget(accounts.get_last_child(), Gtk.Button).emit("clicked");
  widget(folderChoices.get_first_child(), Gtk.CheckButton).set_active(true);
  state.search.set_text("archived@example.com");
  await until(searched(1));
  expect([...state.searchLocations.values()][0]?.folder).toBe("Archive");
  const currentFolder = widget(folderChoices.get_last_child(), Gtk.CheckButton);
  expect(currentFolder.is_sensitive()).toBe(true);
  currentFolder.set_active(true);
  await until(searched(0));
  expect(state.searchFilters.folder()).toBe("INBOX");
  state.search.set_text("example.com");
  await until(searched(2));
  select(state, second, "Archive");
  await until(searched(1));
  expect(state.searchFilters.folder()).toBe("Archive");
  expect(present(groups(state.list)[0])[0]?.sender).toBe(archived.sender);
  storage.close();
  window.close();
});

test("sender search streams with spinner and cancels on folder change", async () => {
  const { state, window } = inbox("Stream");
  const owner = present(state.account);
  state.searchFilters.setAccounts([owner]);
  state.searchFilters.setCurrent(owner.email);
  state.messages = Array.from({ length: 1500 }, (_, index) =>
    message({
      uid: index + 1,
      timestamp: index + 1,
      sender: `sender${index + 1}@example.com`,
      subject: index + 1 === 1500 ? "Needle" : "Unrelated",
      bodyHtml: "<p>Other cached HTML text</p>".repeat(128),
    }),
  );
  window.present();
  const bar = searchBar(state.search);
  bar.set_search_mode(true);
  expect(model(state.list).get_n_items()).toBe(0);
  expect(labels(state.listStack)).toContain("Enter a search query");
  state.search.set_text("needle");
  expect(state.searchRunning[0]).toBe(true);
  expect(state.searchProgress[0].is_visible()).toBe(false);
  expect(state.listStack.get_visible_child_name()).toBe("state");
  await until(() => model(state.list).get_n_items() === 1, 5000);
  expect(state.searchRunning[0]).toBe(true);
  expect(state.searchProgress[0].is_visible()).toBe(true);
  expect(state.listStack.get_visible_child_name()).toBe("list");
  await until(() => labels(state.list).includes("INBOX"), 5000);
  expect(labels(state.list)).not.toContain(`${owner.email} · INBOX`);
  renderList(state);
  expect(state.searchRunning[0]).toBe(true);
  expect(state.searchProgress[0].is_visible()).toBe(true);
  expect(state.searchRefreshAgain[0]).toBe(true);
  const archived = message({ uid: 1, sender: "archive@example.com", subject: "Needle" });
  state.folderCache.set(folderKey(owner.email, "Archive"), [archived]);
  select(state, owner, "Archive");
  await until(() => !state.searchRunning[0] && groups(state.list)[0]?.[0]?.sender === "archive@example.com", 5000);
  expect(state.searchProgress[0].is_visible()).toBe(false);
  await until(() => labels(state.list).includes("Archive"), 5000);
  state.search.set_text("no matches");
  await until(() => !state.searchRunning[0], 5000);
  expect(model(state.list).get_n_items()).toBe(0);
  expect(labels(state.listStack)).toContain("No senders found");
  bar.set_search_mode(false);
  expect(state.searchRunning[0]).toBe(false);
  expect(state.searchProgress[0].is_visible()).toBe(false);
  window.close();
});

test("large histories keep rows light and search refreshes visible", () => {
  const { state } = inbox("LargeHistory");
  const owner = present(state.account);
  state.searchFilters.setAccounts([owner]);
  state.searchFilters.setCurrent(owner.email);
  state.messages = Array.from({ length: 5000 }, (_, index) =>
    message({
      uid: index + 1,
      timestamp: index + 1,
      messageId: `message-${index + 1}`,
      sender: "busy@example.com",
      subject: `Message ${index + 1}`,
      isRead: true,
      bodyText: "Cached text ".repeat(1024),
      bodyHtml: "<p>Cached HTML</p>".repeat(1024),
      listPreview: "Cached text",
      displayPrepared: true,
      remoteMedia: false,
    }),
  );
  let started = performance.now();
  renderList(state);
  console.error(`5,000 cached messages, sender render: ${(performance.now() - started).toFixed(1)}ms`);
  const senderRow = model(state.list).get_item(0);
  expect(groups(state.list).flat().every((message) => !message.bodyText && !message.bodyHtml && message.inlineMedia.length === 0)).toBe(true);
  const latest = present(state.messages.at(-1));
  filterSender(state, latest);
  started = performance.now();
  page(state, state.messages.toReversed().slice(0, 25), true);
  console.error(`First sender page: ${(performance.now() - started).toFixed(1)}ms`);
  expect(model(state.threadList).get_n_items()).toBe(25);
  expect(groups(state.threadList).flat().every((message) => !message.bodyHtml && message.bodyText.length < 200)).toBe(true);
  const untouched = model(state.threadList).get_item(1);
  const changed = { ...latest, bodyLoaded: true, displayPrepared: true, bodyHtml: `${latest.bodyHtml}<p>New body</p>` };
  started = performance.now();
  updateBody(state, changed);
  console.error(`Opening one cached body in 5,000 messages: ${(performance.now() - started).toFixed(1)}ms`);
  expect(model(state.list).get_item(0)).toBe(senderRow);
  expect(model(state.threadList).get_item(1)).toBe(untouched);
  const results = [[message({ uid: 10, sender: "a@example.com" })], [message({ uid: 20, sender: "b@example.com" })]];
  const location = { account: owner.email, folder: "INBOX" };
  const bar = searchBar(state.search);
  bar.set_search_mode(true);
  state.search.set_text("example.com");
  cancelSearch(state, false);
  publishSearchGroups(state, false, "example.com", [...results], [location, location]);
  const retained = model(state.list).get_item(1);
  beginSearch(state, false, true);
  expect(model(state.list).get_n_items()).toBe(2);
  expect(state.listStack.get_visible_child_name()).toBe("list");
  publishSearchGroups(state, false, "example.com", results.slice(0, 1), [location]);
  expect(model(state.list).get_n_items()).toBe(2);
  expect(model(state.list).get_item(1)).toBe(retained);
  cancelSearch(state, false);
  bar.set_search_mode(false);
});

test("long conversations render in batches and keep existing cards", () => {
  const { state } = inbox("LongConversation");
  state.messages = Array.from({ length: 2000 }, (_, index) =>
    message({
      uid: index + 1,
      messageId: `message-${index + 1}`,
      timestamp: index + 1,
      sender: "busy@example.com",
      subject: "Same conversation",
      isRead: true,
      bodyLoaded: true,
      bodyText: "Cached body".repeat(1024),
      displayPrepared: true,
      listPreview: "Cached body",
      remoteMedia: false,
    }),
  );
  const started = performance.now();
  showThread(
    state,
    state.messages.map((message) => listHeader(message, true)),
  );
  console.error(`Open 2,000-message conversation: ${(performance.now() - started).toFixed(1)}ms`);
  expect(state.cards.size).toBe(25);
  expect(state.conversationMore.get_parent()).not.toBeNull();
  const first = cardOf(state, 2000).widget;
  state.conversationMore.emit("clicked");
  expect(state.cards.size).toBe(50);
  expect(cardOf(state, 2000).widget).toBe(first);
  expect(first.get_parent()).toBe(state.viewer);
  newSelection(state);
});

test("independent searches include cached history and cancel on navigation", async () => {
  const { state } = inbox("IndependentSearch");
  const old = message({
    uid: 1,
    timestamp: 1,
    sender: "Alice <alice@example.com>",
    recipients: "Receiver <receiver@example.com>",
    cc: "Copy <copy@example.com>",
    subject: "Older subject",
    bodyText: "A needle in cached history",
  });
  const latest = { ...old, uid: 80, timestamp: 80, subject: "Latest subject", bodyText: "New message" };
  const other = message({ uid: 90, timestamp: 90, sender: "Bob <bob@example.com>", bodyText: "A needle from another sender" });
  state.messages = [old, latest, other];
  renderList(state);
  searchBar(state.search).set_search_mode(true);
  state.search.set_text("latest");
  await until(() => model(state.list).get_n_items() === 1);
  filterSender(state, latest);
  page(state, [latest], true);
  expect(model(state.threadList).get_n_items()).toBe(1);
  searchBar(state.threadSearch).set_search_mode(true);
  const searchThreads = (query: string) => {
    state.threadSearch.set_text(query);
    state.threadSearch.emit("search-changed");
  };
  const finds = (uid: number) => () => groups(state.threadList).flat().some((message) => message.uid === uid);
  for (const query of ["needle", "older", "receiver", "copy", "alice"]) {
    searchThreads(query);
    await until(() => finds(1)() && groups(state.threadList).flat().every((message) => message.uid !== 90));
    expect(state.search.get_text()).toBe("latest");
    expect(model(state.list).get_n_items()).toBe(1);
    searchThreads("missing");
    await until(() => model(state.threadList).get_n_items() === 0);
  }
  state.search.set_text("");
  state.search.emit("search-changed");
  searchThreads("");
  const cached = { ...present(state.messages[0]), bodyText: "", bodyHtml: "<p>HTML cache arrival</p>", cc: "New copy recipient" };
  applyCachedBody(state, cached);
  searchThreads("arrival");
  await until(finds(1));
  searchThreads("new copy");
  await until(finds(1));
  searchThreads("needle");
  filterSender(state, other);
  expect(state.threadSearch.get_text()).toBe("");
  await settle(50);
  expect(state.senderPane.sender()).toBe("bob@example.com");
  expect(model(state.threadList).get_n_items()).toBe(0);
  state.search.set_text("missing");
  state.search.emit("search-changed");
  searchBar(state.search).set_search_mode(false);
  expect(model(state.list).get_n_items()).toBe(2);
  await settle(50);
  expect(model(state.list).get_n_items()).toBe(2);
});

test("repeated search, sort and open keep one sender and reject old pages", async () => {
  const { state, window } = inbox("Navigation");
  state.messages = Array.from({ length: 80 }, (_, index) =>
    message({
      uid: index + 1,
      timestamp: index + 1,
      sender: `Sender ${index + 1} <sender${index + 1}@example.com>`,
      subject: `Subject ${(index + 1) % 2 === 0 ? "even" : "odd"}`,
    }),
  );
  renderList(state);
  window.present();
  for (let cycle = 0; cycle < 30; cycle++) {
    state.search.set_text(cycle % 2 === 0 ? "even" : "odd");
    state.senderUnreadFirst.setUnreadFirst(cycle % 3 === 0);
    renderList(state);
    await settle(50);
    const first = present(present(item(state.list, 0)).messages[0]);
    state.list.emit("activate", 0);
    const oldTicket = senderTicket(state);
    state.list.emit("activate", 1);
    const second = present(present(item(state.list, 1)).messages[0]);
    const ticket = senderTicket(state);
    expect(oldTicket).not.toBe(ticket);
    page(state, [first], false, oldTicket);
    expect(state.senderPane.messages()).toHaveLength(0);
    page(state, [second], false, ticket);
    expect(state.senderPane.sender()).toBe(key(second));
    state.threadList.emit("activate", 0);
    expect(present(state.openGroup[0]).uid).toBe(second.uid);
    body(state, { ...second, isRead: true });
    for (const message of state.messages) message.timestamp = -message.timestamp;
    renderList(state);
    await settle(50);
    let opened = 0;
    for (let position = 0; position < model(state.list).get_n_items(); position++) {
      const row = visibleRow(state.list, position);
      if (!row) continue;
      const data = present(item(state.list, position));
      expect(labels(row)).toContain(identity(present(data.messages[0]))[0]);
      const active = row.has_css_class("message-row-open");
      expect(active).toBe(data.key === key(second));
      opened += Number(active);
    }
    expect(opened).toBeLessThanOrEqual(1);
    filterSender(state, null);
    await settle(50);
    for (let position = 0; position < model(state.list).get_n_items(); position++) {
      const row = visibleRow(state.list, position);
      if (row) expect(row.has_css_class("message-row-open")).toBe(false);
    }
  }
  window.close();
}, 30_000);

test("unread sort toggles are independent and apply to older pages", () => {
  const { state } = inbox("UnreadSort");
  const mail = (uid: number, sender: string, isRead: boolean) => message({ uid, timestamp: uid, sender, subject: `Subject ${uid}`, bodyLoaded: true, isRead });
  const older = mail(10, "a@example.com", false);
  const latest = mail(40, "a@example.com", true);
  state.messages = [mail(50, "b@example.com", true), latest, mail(30, "c@example.com", false), older];
  for (const toggle of [state.senderUnreadFirst, state.threadUnreadFirst]) {
    expect(toggle.unreadFirst()).toBe(true);
    expect(toggle.widget.get_icon_name()).toBe("open-menu-symbolic");
    expect(toggle.widget.get_ancestor(Adw.HeaderBar.$gtype)).not.toBeNull();
  }
  renderList(state);
  expect(firstUids(state.list)).toEqual([40, 30, 50]);
  selection(state.list).set_selected(0);
  state.senderUnreadFirst.setUnreadFirst(false);
  expect(firstUids(state.list)).toEqual([50, 40, 30]);
  expect(selected(state.list)).toBe(1);
  expect(state.threadUnreadFirst.unreadFirst()).toBe(true);
  filterSender(state, latest);
  page(state, [latest], true);
  page(state, [older], false);
  expect(firstUids(state.threadList)).toEqual([10, 40]);
  selection(state.threadList).set_selected(0);
  state.threadUnreadFirst.setUnreadFirst(false);
  expect(firstUids(state.threadList)).toEqual([40, 10]);
  expect(selected(state.threadList)).toBe(1);
  expect(firstUids(state.list)).toEqual([50, 40, 30]);
  state.senderUnreadFirst.setUnreadFirst(true);
  event(state, { type: "Messages", generation: state.generation, messages: [...state.messages, mail(5, "d@example.com", false)], cached: false });
  expect(firstUids(state.list)).toEqual([40, 30, 5, 50]);
  expect(firstUids(state.threadList)).toEqual([40, 10]);
  state.senderUnreadFirst.setUnreadFirst(false);
  expect(firstUids(state.list)).toEqual([50, 40, 30, 5]);
  state.threadUnreadFirst.setUnreadFirst(true);
  expect(firstUids(state.threadList)).toEqual([10, 40]);
});

test("sort menus restore independent choices and search follows reload", () => {
  const directory = join(tmpdir(), `brevlada-sort-${GLib.uuid_string_random()}`);
  const path = join(directory, "sorting.json");
  const { state } = inbox("SortMenu");
  rememberSorting(state, path);
  const search = widget(state.refresh.get_next_sibling(), Gtk.ToggleButton);
  expect(search.get_icon_name()).toBe("system-search-symbolic");
  for (const menu of [state.senderUnreadFirst, state.threadUnreadFirst]) {
    expect(menu.unreadFirst()).toBe(true);
    const model = present(menu.widget.get_menu_model());
    expect(model.get_n_items()).toBe(1);
    expect(present(model.get_item_attribute_value(0, "label", null)).get_string()[0]).toBe("Sort unread first");
    expect(menu.widget.activate_action("sort.unread-first", null)).toBe(true);
    expect(menu.unreadFirst()).toBe(false);
  }
  const restored = inbox("RestoredSort").state;
  rememberSorting(restored, path);
  expect(restored.senderUnreadFirst.unreadFirst()).toBe(false);
  expect(restored.threadUnreadFirst.unreadFirst()).toBe(false);
  restored.senderUnreadFirst.widget.activate_action("sort.unread-first", null);
  const restarted = inbox("RestartedSort").state;
  rememberSorting(restarted, path);
  expect(restarted.senderUnreadFirst.unreadFirst()).toBe(true);
  expect(restarted.threadUnreadFirst.unreadFirst()).toBe(false);
  rmSync(directory, { recursive: true });
});

test("opening cached and sender-only messages requests read updates", () => {
  const { state } = inbox("Read");
  const older = message({ uid: 1, timestamp: 1, sender: "sender@example.com", subject: "Older", bodyText: "Cached body", bodyLoaded: true });
  const latest = { ...older, uid: 2, timestamp: 2, subject: "Latest" };
  state.messages = [latest];
  state.senderPane.select(key(older));
  state.senderPane.seed([latest, older]);
  for (const opened of [latest, older]) {
    showThread(state, [opened]);
    expect(state.pending.has(opened.uid)).toBe(true);
    body(state, { ...opened, isRead: true });
    expect(state.pending.has(opened.uid)).toBe(false);
    expect(present(state.openGroup[0]).isRead).toBe(true);
    expect(present(state.senderPane.messages().find((message) => message.uid === opened.uid)).isRead).toBe(true);
    renderConversation(state);
    expect(state.pending.has(opened.uid)).toBe(false);
  }
  const preview = { ...present(state.senderPane.messages()[1]), uid: 3, subject: "Preview" };
  const header = { ...preview, isRead: false, bodyLoaded: false, bodyText: "" };
  state.senderPane.seed([...state.senderPane.messages(), header]);
  showThread(state, [header]);
  state.pending.clear();
  state.previewPending.add(preview.uid);
  event(state, { type: "Preview", generation: state.generation, selection: state.selection, message: preview });
  expect(state.previewPending.has(preview.uid)).toBe(false);
  expect(state.pending.has(preview.uid)).toBe(true);
  expect(present(state.openGroup[0]).isRead).toBe(false);
});

test("opened row style stays on the opened sender when another row is hovered", async () => {
  const { state, window } = inbox("Hover");
  const first = message({ uid: 2, timestamp: 2, sender: "first@example.com" });
  const second = message({ uid: 1, timestamp: 1, sender: "second@example.com" });
  state.messages = [first, second];
  renderList(state);
  expect(state.listScroll.get_kinetic_scrolling()).toBe(true);
  expect(state.threadScroll.get_kinetic_scrolling()).toBe(true);
  window.present();
  await settle(100);
  filterSender(state, first);
  expect(selected(state.list)).toBeNull();
  const opened = present(visibleRow(state.list, 0));
  const hovered = present(visibleRow(state.list, 1));
  expect(opened.has_css_class("message-row-open")).toBe(true);
  expect(hovered.has_css_class("message-row-open")).toBe(false);
  selection(state.list).set_selected(1);
  hovered.set_state_flags(Gtk.StateFlags.PRELIGHT, false);
  expect(opened.has_css_class("message-row-open")).toBe(true);
  expect(hovered.has_css_class("message-row-open")).toBe(false);
  present(state.messages[1]).timestamp = 3;
  renderList(state);
  await settle(50);
  refreshOpenStyles(state);
  expect(present(item(state.list, 0)).key).toBe("second@example.com");
  for (let position = 0; position < model(state.list).get_n_items(); position++)
    expect(present(visibleRow(state.list, position)).has_css_class("message-row-open")).toBe(present(item(state.list, position)).key === "first@example.com");
  const olderMessage = message({ uid: 3, timestamp: 0, sender: first.sender, subject: "Older" });
  page(state, [first, olderMessage], false);
  showThread(state, [first]);
  await settle(50);
  const openedThread = present(visibleRow(state.threadList, 0));
  const hoveredThread = present(visibleRow(state.threadList, 1));
  selection(state.threadList).set_selected(1);
  hoveredThread.set_state_flags(Gtk.StateFlags.PRELIGHT, false);
  expect(openedThread.has_css_class("message-row-open")).toBe(true);
  expect(hoveredThread.has_css_class("message-row-open")).toBe(false);
  filterSender(state, null);
  for (let position = 0; position < model(state.list).get_n_items(); position++)
    expect(present(visibleRow(state.list, position)).has_css_class("message-row-open")).toBe(false);
  window.close();
});

test("sender open requests bounded pages without grouping the folder", () => {
  const { state, commands } = inbox("SenderPaging");
  const owner = present(state.account);
  const messages = Array.from({ length: 1000 }, (_, index) =>
    message({ uid: 1000 - index, timestamp: 1000 - index, sender: "sender@example.com", subject: `Subject ${1000 - index}` }),
  );
  state.messages = [...messages];
  filterSender(state, present(messages[0]));
  expect(groups(state.threadList)).toHaveLength(0);
  expect(state.senderPane.messages()).toHaveLength(0);
  expect(next(commands)).toMatchObject({ type: "LoadSenderPage", before: null, limit: 25 });
  page(state, messages.slice(0, 25), true);
  expect(state.senderPane.messages()).toHaveLength(25);
  expect(groups(state.threadList)).toHaveLength(25);
  expect(state.threadLoadMore.get_visible()).toBe(false);
  loadSenderPage(state);
  expect(next(commands)).toMatchObject({ type: "LoadSenderPage", before: [976, 976], limit: 25 });
  event(state, { type: "SenderPageError", generation: state.generation, senderGeneration: senderTicket(state), error: "offline" });
  expect(state.threadLoadMore.get_visible()).toBe(true);
  expect(state.threadLoadMore.get_label()).toBe("Retry loading");
  select(state, owner, "Archive");
  expect(state.messages).toHaveLength(0);
  expect(present(state.folderCache.get(folderKey("account@example.com", "INBOX")))).toHaveLength(1000);
  expect(next(commands)).toMatchObject({ type: "Load" });
});

test("a cached page keeps the sender scroll position", async () => {
  const { state, window } = inbox("Paging");
  state.messages = [
    ...Array.from({ length: 150 }, (_, index) => message({ uid: 150 - index, timestamp: 150 - index, sender: `sender${150 - index}@example.com`, isRead: 150 - index > 50 })),
    message({ uid: 0, timestamp: 0, sender: "sender150@example.com" }),
  ];
  renderList(state);
  window.present();
  await settle(300);
  const adjustment = state.listScroll.get_vadjustment();
  adjustment.set_value(1000);
  await settle(100);
  const before = adjustment.get_value();
  const beforeKeys = firstUids(state.list);
  expect(beforeKeys).toHaveLength(MESSAGE_LIMIT);
  expect(beforeKeys.slice(0, 2)).toEqual([150, 50]);
  loadMore(state);
  await settle(100);
  const afterKeys = firstUids(state.list);
  expect(afterKeys.slice(0, beforeKeys.length)).toEqual(beforeKeys);
  expect(afterKeys).toHaveLength(100);
  expect(Math.abs(adjustment.get_value() - before)).toBeLessThan(1);
  loadMore(state);
  expect(model(state.list).get_n_items()).toBe(150);
  expect(state.hasMoreSenders).toBe(false);
  loadMore(state);
  await settle(100);
  expect(Math.abs(adjustment.get_value() - before)).toBeLessThan(1);
  window.close();
});

test("loading and refresh keep selection, rows and cards", async () => {
  const requested: string[] = [];
  const { state, window, commands } = testState("Loading", new Avatars((email) => requested.push(email)));
  const sync: Status = {
    activity: { description: "Syncing previews", folder: "INBOX", progress: { accounts: null, folders: null, messages: null } },
    active: 2,
    queued: 10,
    failed: 0,
    lastStarted: null,
  };
  const activity = present(sync.activity);
  state.syncStatus.update(sync);
  const spinner = widget(state.syncStatus.widget.get_first_child(), Gtk.Spinner);
  expect(spinner.get_spinning() && spinner.get_visible()).toBe(true);
  expect(labels(state.syncStatus.widget)).toContain("Syncing");
  const messagesCounter = present(state.syncStatus.widget.get_last_child());
  const foldersCounter = present(messagesCounter.get_prev_sibling());
  const accountsCounter = present(foldersCounter.get_prev_sibling());
  expect(accountsCounter.get_visible()).toBe(false);
  expect(foldersCounter.get_visible() || messagesCounter.get_visible()).toBe(false);
  activity.progress.accounts = { cached: 1, total: 3 };
  state.syncStatus.update(sync);
  expect(accountsCounter.get_visible()).toBe(true);
  expect(labels(accountsCounter)).toContain("1/3");
  expect(widget(accountsCounter.get_last_child(), Gtk.Image).get_icon_name()).toBe("avatar-default-symbolic");
  activity.progress.folders = { cached: 3, total: 6 };
  state.syncStatus.update(sync);
  expect(foldersCounter.get_visible() && !messagesCounter.get_visible()).toBe(true);
  expect(labels(foldersCounter)).toContain("3/6");
  activity.progress.messages = { cached: 15, total: 892 };
  state.syncStatus.update(sync);
  expect(messagesCounter.get_visible()).toBe(true);
  expect(labels(messagesCounter)).toContain("15/892");
  expect(widget(foldersCounter.get_last_child(), Gtk.Image).get_icon_name()).toBe("folder-symbolic");
  expect(widget(messagesCounter.get_last_child(), Gtk.Image).get_icon_name()).toBe("mail-unread-symbolic");
  expect(state.syncStatus.widget.measure(Gtk.Orientation.HORIZONTAL, -1)[0]).toBeLessThanOrEqual(SIDEBAR_WIDTH);
  state.syncStatus.update({ activity: null, active: 0, queued: 0, failed: 0, lastStarted: Date.now() / 1000 });
  expect(spinner.get_spinning() || spinner.get_visible()).toBe(false);
  expect(accountsCounter.get_visible() || foldersCounter.get_visible() || messagesCounter.get_visible()).toBe(false);
  expect(labels(state.syncStatus.widget)).toContain("Last synced: just now");
  state.account = { ...account("fixture"), oauth2: true };
  event(state, { type: "Accounts", accounts: [state.account] });
  const accountRow = present(state.sidebar.get_first_child());
  const expand = widget(present(accountRow.get_first_child()).get_first_child(), Gtk.Button);
  const folders = present(state.folderBoxes.get("fixture"))[1];
  expand.emit("clicked");
  expect(folders.get_visible()).toBe(true);
  expect(expand.get_icon_name()).toBe("pan-down-symbolic");
  expect(folders.has_css_class("folders-loading")).toBe(true);
  event(state, { type: "Unread", account: "fixture", folders: [["Work/Updates", true]] });
  event(state, { type: "Folders", account: "fixture", folders: ["Work/Updates"] });
  expect(folders.get_visible()).toBe(true);
  expect(folders.has_css_class("folders-loading")).toBe(false);
  const folderRow = present(folders.get_first_child());
  expect(folderRow.get_visible()).toBe(true);
  expect(folderRow.has_css_class("folder-item")).toBe(true);
  widget(folderRow.get_first_child(), Gtk.Button).emit("clicked");
  const nested = present(folderRow.get_last_child());
  expect(nested.get_visible()).toBe(true);
  event(state, { type: "Folders", account: "fixture", folders: ["Work/Updates"] });
  expect(folders.get_first_child()).toBe(folderRow);
  expect(nested.get_visible()).toBe(true);
  expand.emit("clicked");
  expect(folders.get_visible()).toBe(false);
  event(state, { type: "UnreadSnapshot", account: "fixture", folders: [["Work/Updates", false]] });
  expect(folders.get_visible()).toBe(false);
  expand.emit("clicked");
  expect(folders.get_visible()).toBe(true);
  expect(folders.get_first_child()).toBe(folderRow);
  event(state, { type: "Accounts", accounts: [state.account] });
  const restoredFolders = present(state.folderBoxes.get("fixture"))[1];
  expect(restoredFolders.get_visible()).toBe(true);
  expect(restoredFolders.has_css_class("folders-loading")).toBe(true);
  event(state, { type: "Folders", account: "fixture", folders: ["Work/Updates", "Work/Projects"] });
  expect(present(present(restoredFolders.get_first_child()).get_last_child()).get_visible()).toBe(true);
  expect(state.expansion.forAccount("fixture").isExpanded("")).toBe(true);
  expect(state.expansion.forAccount("fixture").isExpanded("Work")).toBe(true);
  const first = message({ uid: 1, subject: "First", sender: "Ada Lovelace <Ada@Example.com>", timestamp: 2 });
  const second = message({ uid: 2, subject: "Second", sender: "Ada Lovelace <ada@example.com>", timestamp: 1, isRead: true });
  state.messages = [first, second];
  renderList(state);
  expect(groups(state.list)).toHaveLength(1);
  expect(labels(present(visibleRow(state.list, 0)))).toContain("First");
  expect(state.back.get_visible()).toBe(false);
  expect(requested).toEqual(["fixture", "ada@example.com"]);
  const senderAvatar = () => widget(present(visibleRow(state.list, 0)).get_first_child(), Adw.Avatar);
  expect(senderAvatar().get_custom_image()).toBeNull();
  event(state, { type: "Avatar", email: "ada@example.com", image: PIXEL });
  expect(senderAvatar().get_custom_image()).not.toBeNull();
  renderList(state);
  expect(senderAvatar().get_custom_image()).not.toBeNull();
  expect(requested).toHaveLength(2);
  const accountButton = present(present(present(state.sidebar.get_first_child()).get_first_child()).get_last_child());
  const accountAvatar = widget(present(accountButton.get_first_child()).get_first_child(), Adw.Avatar);
  expect(accountAvatar.get_custom_image()).toBeNull();
  event(state, { type: "Avatar", email: "fixture", image: PIXEL });
  expect(accountAvatar.get_custom_image()).not.toBeNull();
  const senderRow = present(present(groups(state.list)[0])[0]).sender;
  state.accountSidebar.setVisible(true);
  filterSender(state, first);
  expect(state.threadSidebar.getVisible()).toBe(true);
  expect(state.accountSidebar.getVisible()).toBe(false);
  expect(present(present(groups(state.list)[0])[0]).sender).toBe(senderRow);
  expect(groups(state.list)).toHaveLength(1);
  filterSender(state, null);
  expect(state.accountSidebar.getVisible()).toBe(true);
  state.accountSidebar.setVisible(false);
  filterSender(state, first);
  filterSender(state, null);
  expect(state.accountSidebar.getVisible()).toBe(false);
  state.accountSidebar.setVisible(true);
  filterSender(state, first);
  state.accountSidebar.setVisible(true);
  state.accountSidebar.setVisible(false);
  filterSender(state, null);
  expect(state.accountSidebar.getVisible()).toBe(false);
  state.accountSidebar.setVisible(true);
  filterSender(state, first);
  state.accountSidebar.setVisible(true);
  filterSender(state, second);
  expect(state.accountSidebar.getVisible()).toBe(true);
  filterSender(state, null);
  expect(state.threadSidebar.getVisible()).toBe(false);
  expect(state.accountSidebar.getVisible()).toBe(true);
  filterSender(state, first);
  expect(state.accountSidebar.getVisible()).toBe(false);
  expect(present(state.composeButton.get_ancestor(Adw.HeaderBar.$gtype)).has_css_class("content-header")).toBe(true);
  state.composeButton.emit("clicked");
  const compose = present(state.openComposers.at(-1)).compose;
  expect(compose.widget.get_visible()).toBe(true);
  const header = present(present(compose.widget.get_first_child()).get_next_sibling());
  const receiver = widget(header.get_first_child(), Gtk.Entry);
  expect(receiver.get_text()).toBe("ada@example.com");
  receiver.set_text("edited@example.com");
  state.composeButton.emit("clicked");
  const secondCompose = present(state.openComposers.at(-1)).compose;
  expect(secondCompose).not.toBe(compose);
  expect(state.openComposers).toHaveLength(2);
  expect(receiver.get_text()).toBe("edited@example.com");
  const cancel = widget(header.get_last_child(), Gtk.Button);
  const send = widget(cancel.get_prev_sibling(), Gtk.Button);
  expect(cancel.get_icon_name()).not.toBeNull();
  expect(cancel.get_label()).toBeNull();
  expect(send.is_sensitive()).toBe(false);
  expect(labels(send)).toContain("Send");
  const subject = widget(header.get_next_sibling(), Gtk.Entry);
  const bodyHeader = present(subject.get_next_sibling());
  const modes = present(bodyHeader.get_first_child());
  const formatting = present(modes.get_next_sibling());
  const group = widget(bodyHeader.get_next_sibling(), Adw.PreferencesGroup);
  const editor = widget(
    descendants(group).find((child) => child instanceof Gtk.TextView),
    Gtk.TextView,
  );
  subject.set_text("Subject");
  expect(send.is_sensitive()).toBe(false);
  editor.get_buffer().set_text("  ", -1);
  expect(send.is_sensitive()).toBe(false);
  editor.get_buffer().set_text("Hello", -1);
  expect(send.is_sensitive()).toBe(true);
  widget(modes.get_last_child(), Gtk.ToggleButton).set_active(true);
  expect(formatting.get_visible()).toBe(true);
  expect(editor.get_monospace()).toBe(false);
  editor.get_buffer().set_text("Hello", -1);
  expect(send.is_sensitive()).toBe(true);
  subject.set_text("");
  expect(send.is_sensitive()).toBe(false);
  subject.set_text("Subject");
  expect(send.is_sensitive()).toBe(true);
  send.emit("clicked");
  expect(compose.widget.get_visible()).toBe(true);
  expect(receiver.get_text()).toBe("edited@example.com");
  const sent = (type: "Compose" | "SaveDraft") => commands.find((command) => command.type === type);
  await until(() => sent("Compose") !== undefined, 10_000);
  const sending = present(sent("Compose"));
  if (sending.type !== "Compose") throw new Error("Expected message send");
  event(state, { type: "Composed", request: sending.request, result: { ok: false, error: "Mail service stopped" } });
  cancel.emit("clicked");
  expect(compose.widget.get_visible()).toBe(true);
  await until(() => sent("SaveDraft") !== undefined);
  const saving = present(sent("SaveDraft"));
  if (saving.type !== "SaveDraft") throw new Error("Closing saves the edited draft first");
  const saved = message({ uid: 9, messageId: "closed-draft", isDraft: true, bodyLoaded: true });
  event(state, { type: "DraftSaved", request: saving.request, result: { ok: true, value: { item: { folder: "Drafts", message: saved }, originalParts: [], cleanupError: null } } });
  expect(compose.widget.get_visible()).toBe(false);
  expect(receiver.get_text()).toBe("");
  expect(secondCompose.widget.get_visible()).toBe(true);
  state.composeButton.emit("clicked");
  const thirdCompose = present(state.openComposers.at(-1)).compose;
  const thirdHeader = present(present(thirdCompose.widget.get_first_child()).get_next_sibling());
  expect(widget(thirdHeader.get_first_child(), Gtk.Entry).get_text()).toBe("ada@example.com");
  page(state, [first, second], false);
  expect(groups(state.threadList)).toHaveLength(2);
  expect(state.previewPending.has(first.uid)).toBe(true);
  event(state, { type: "Preview", generation: state.generation, selection: state.selection, message: { ...first, bodyLoaded: true, bodyText: "Unread preview" } });
  expect(present(state.messages.find((message) => message.uid === first.uid)).isRead).toBe(false);
  expect(state.previewPending.has(first.uid)).toBe(false);
  expect(labels(present(visibleRow(state.threadList, 0)))).toContain("Unread preview");
  const refreshed = state.messages.map((message) => ({ ...message, isRead: message.uid === first.uid ? true : message.uid === second.uid ? false : message.isRead }));
  event(state, { type: "Messages", generation: state.generation, messages: refreshed, cached: false });
  expect(firstUids(state.threadList)[0]).toBe(second.uid);
  expect(state.back.get_visible()).toBe(true);
  filterSender(state, null);
  expect(groups(state.list)).toHaveLength(1);
  expect(state.selected).toHaveLength(0);
  expect(state.cards.size).toBe(0);
  filterSender(state, first);
  page(state, [...state.messages], false);
  selection(state.threadList).set_selected(1);
  showThread(state, [second]);
  const card = cardOf(state, 2).widget;
  state.threadScroll.get_vadjustment().configure(200, 0, 1500, 10, 100, 400);
  const { generation, selection: selectionId } = state;
  load(state);
  expect(state.generation).toBe(generation);
  expect(state.selection).toBe(selectionId);
  const loaded = { ...second, bodyLoaded: true, bodyText: "Fetched body" };
  body(state, loaded);
  body(state, { ...loaded, isRead: true });
  expect(cardOf(state, 2).widget).toBe(card);
  const selectedThread = () => present(present(groups(state.threadList)[present(selected(state.threadList))])[0]).uid;
  expect(selectedThread()).toBe(1);
  expect(state.threadScroll.get_vadjustment().get_value()).toBe(200);
  event(state, { type: "Messages", generation, messages: [first, second], cached: false });
  expect(cardOf(state, 2).widget).toBe(card);
  expect(selectedThread()).toBe(1);
  expect(present(state.messages.find((message) => message.uid === 2)).bodyLoaded).toBe(true);
  state.pending.add(2);
  filterSender(state, null);
  expect(state.back.get_visible()).toBe(false);
  expect(groups(state.list)).toHaveLength(1);
  expect(state.selected).toEqual([2]);
  expect(cardOf(state, 2).widget).toBe(card);
  expect(state.viewer.get_first_child()).toBe(card);
  expect(state.selection).toBe(selectionId);
  expect(state.pending.has(2)).toBe(true);
  event(state, { type: "BodyError", generation, selection: selectionId, uid: 2, error: "Timeout" });
  expect(state.pending.has(2)).toBe(false);
  showThread(state, [loaded]);
  const current = cardOf(state, 2).widget;
  event(state, { type: "Body", generation, selection: selectionId, message: message({ uid: 2, bodyLoaded: true, bodyText: "Stale" }) });
  expect(cardOf(state, 2).widget).toBe(current);
  const cached = message({ uid: 2, bodyLoaded: true, bodyText: "Background cache" });
  event(state, { type: "CacheBody", account: "another-account", folder: state.folder, message: cached });
  expect(present(state.messages.find((message) => message.uid === 2)).bodyText).not.toBe("Background cache");
  const wasRead = present(state.messages.find((message) => message.uid === 2)).isRead;
  event(state, { type: "CacheBody", account: "fixture", folder: state.folder, message: cached });
  expect(cardOf(state, 2).widget).toBe(current);
  const updated = present(state.messages.find((message) => message.uid === 2));
  expect(updated.bodyText).toBe("Background cache");
  expect(updated.isRead).toBe(wasRead);
  const owner = present(state.account);
  const folder = state.folder;
  const snapshot = [...state.messages];
  event(state, { type: "Messages", generation: state.generation, messages: [...snapshot], cached: false });
  select(state, owner, "Archive");
  event(state, { type: "Messages", generation: state.generation, messages: [], cached: false });
  select(state, owner, folder);
  expect(state.messages).toEqual(snapshot);
  expect(state.listStack.get_visible_child_name()).toBe("list");
  expect(state.loading).toBe(true);
  expect(state.refresh.is_sensitive()).toBe(false);
  const staleGeneration = state.generation;
  select(state, owner, "Archive");
  expect(state.messages).toHaveLength(0);
  expect(state.loading).toBe(true);
  expect(labels(state.listStack)).toContain("No messages in this folder");
  event(state, { type: "Messages", generation: staleGeneration, messages: [...snapshot], cached: false });
  expect(state.messages).toHaveLength(0);
  event(state, { type: "CacheList", account: owner.email, folder, messages: [] });
  select(state, owner, folder);
  expect(state.messages).toHaveLength(0);
  event(state, { type: "Messages", generation: state.generation, messages: [...snapshot], cached: false });
  expect(state.messages.length).toBeGreaterThan(0);
  select(state, { ...owner, email: "other-fixture" }, folder);
  expect(hasCachedFolder(state)).toBe(false);
  expect(state.messages).toHaveLength(0);
  expect(window.is_visible()).toBe(false);
  window.close();
}, 30_000);
