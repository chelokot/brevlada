import { join } from "node:path";
import GLib from "gi://GLib?version=2.0";
import { type Location, locationKey, request as searchRequest } from "../backend/search";
import { preserve, preserveOffset } from "../components/scroll-position";
import { listState, noSendersFound } from "../components/states";
import { item, model, replace, replaceItem, type Row, selected, updateOwned, withItem } from "../components/virtual-list";
import { listHeader, type Message, prepareDisplay, searchDocument, threads as conversations } from "../models";
import { isReply } from "../models/calendar";
import { key, preview, groups as senderGroups } from "../models/senders";
import { hasCachedFolder } from "./actions";
import { renderConversation } from "./conversation";
import { mergeReadStates } from "./read-state";
import { beginSearch, cancelSearch, renderOrQueueSearch, searchOpen, senderSearchActive } from "./search";
import { matchedSenderMessages, refreshSearchSender } from "./search-sender";
import { searchDocuments, visibleListGroup, visibleMessage } from "./sender-actions";
import { maybeLoadSenderPage } from "./sender-pane";
import { messageKey, type State } from "./state";

type Located = Row & { location: Location | null };

const lane = (threads: boolean) => (threads ? 1 : 0);

const senderKey = (group: Message[], location: Location | null) => {
  const sender = key(group[0]!);
  return location ? locationKey(location, sender) : sender;
};

export function refreshOpenStyles(state: State) {
  const sender = state.senderPane.sender();
  const located = sender !== null && state.account ? locationKey({ account: state.account.email, folder: state.folder }, sender) : null;
  state.activeSenderRow.setKey(located !== null && state.searchLocations.has(located) ? located : sender);
  const identities = new Set(state.openGroup.map(messageKey));
  const count = model(state.threadList).get_n_items();
  let active: string | null = null;
  for (let position = 0; position < count && active === null; position++)
    active = withItem(state.threadList, position, (row) => (row.messages.some((message) => identities.has(messageKey(message))) ? row.key : null));
  state.activeThreadRow.setKey(active);
}

export function renderSenderPane(state: State) {
  state.searchSnapshots[1] = null;
  if (state.searchSender && senderSearchActive(state)) {
    state.searchSnapshots[0] = null;
    renderOrQueueSearch(state, false);
  }
  state.rendering = true;
  renderOrQueueSearch(state, true);
  state.rendering = false;
  maybeLoadSenderPage(state);
}

export function renderList(state: State) {
  state.searchSnapshots = [null, null];
  state.rendering = true;
  renderOrQueueSearch(state, false);
  if (state.senderPane.sender() !== null) renderOrQueueSearch(state, true);
  state.rendering = false;
}

export const renderPane = (state: State, threads: boolean) => renderPaneWithProgress(state, threads, true);

function searchSnapshot(state: State) {
  const documents = new Map(searchDocuments(state, state.messages).map((message) => [messageKey(message), message]));
  if (state.searchSender) for (const message of searchDocuments(state, state.senderPane.messages())) documents.set(messageKey(message), message);
  return [...documents.values()];
}

export function renderPaneWithProgress(state: State, threads: boolean, showProgress: boolean) {
  const sender = threads ? state.senderPane.sender() : null;
  const query = searchOpen(state, threads) ? (threads ? state.threadSearch : state.search).get_text().trim().toLowerCase() : "";
  const filtered = !threads && senderSearchActive(state);
  if (filtered && !query) {
    cancelSearch(state, false);
    state.hasMoreSenders = false;
    state.searchLocations.clear();
    replace(state.list, 0, null);
    listState(state.listStack, "Enter a search query", false, false);
    if (state.searchSender) {
      state.searchSender.messages = [];
      cancelSearch(state, true);
      renderOrQueueSearch(state, true);
    }
    return;
  }
  const filters = state.searchFilters.filters();
  if (filtered && !filters.ok) {
    cancelSearch(state, false);
    state.hasMoreSenders = false;
    return listState(state.listStack, filters.error, false, false);
  }
  if ((filtered || query) && (!threads || sender !== null)) {
    const messages = (state.searchSnapshots[0] ??= searchSnapshot(state));
    const { account } = state;
    const request = searchRequest(threads, query, sender, account && account.email.toLowerCase(), messages);
    if (!threads && filters.ok) {
      request.filters = filters.value;
      request.scope = {
        current: account && (!state.loading || hasCachedFolder(state)) ? { account: account.email, folder: state.folder } : null,
        folder: state.searchFilters.folder(),
        accounts: [...state.searchFilters.accountsFor(account && account.email)].sort(),
        cachePath: join(GLib.get_user_data_dir(), "brevlada", "emails.db"),
        revision: state.searchCacheRevision,
      };
    }
    request.unreadFirst = (threads ? state.threadUnreadFirst : state.senderUnreadFirst).unreadFirst();
    request.deferredRead = new Set(state.deferredReadSort);
    if (threads) {
      const senderMessages = (state.searchSnapshots[1] ??= searchDocuments(state, matchedSenderMessages(state) ?? state.senderPane.messages()));
      if (state.searchSender) request.messages = senderMessages;
      else request.senderMessages = senderMessages;
    }
    beginSearch(state, threads, showProgress);
    return state.searchWorker.submit(request);
  }
  cancelSearch(state, threads);
  const messages = threads
    ? visibleListGroup(state, matchedSenderMessages(state) ?? state.senderPane.messages(), true)
    : visibleListGroup(state, state.messages, false);
  const own = state.account && state.account.email.toLowerCase();
  const related = (message: Message) => [sender, own].includes(key(message));
  const groups =
    sender === null
      ? senderGroups(messages, "")
      : conversations(messages.filter(related), "").filter((group) => group.some((message) => key(message) === sender));
  publishSearchGroups(state, threads, query, groups, []);
}

export function publishSearchGroups(state: State, threads: boolean, query: string, groups: Message[][], locations: (Location | null)[]) {
  const index = lane(threads);
  const [list, listScroll, listStack] = threads ? [state.threadList, state.threadScroll, state.threadStack] : [state.list, state.listScroll, state.listStack];
  let entries = groups.map((group, position) => ({ group, location: locations[position] ?? null }));
  if (state.searchRunning[index] && state.searchPreserveResults[index]) {
    const present = new Set(entries.map(({ group, location }) => (threads ? threadKey(group) : senderKey(group, location))));
    const accounts = state.searchFilters.selectedAccounts();
    const folder = state.searchFilters.folder();
    const count = model(list).get_n_items();
    for (let position = 0; position < count; position++)
      withItem(list, position, (row) => {
        const location = state.searchLocations.get(row.key) ?? null;
        const kept = threads || (location !== null && accounts.has(location.account) && (folder === null || location.folder === folder));
        if (!present.has(row.key) && kept) entries.push({ group: row.messages, location });
      });
  }
  state.searchPublishedQueries[index] = query;
  const selectedPosition = selected(list);
  const previous =
    selectedPosition === null
      ? null
      : withItem(list, selectedPosition, (row) => ({ key: row.key, identities: new Set(threads ? row.messages.map(messageKey) : []) }));
  const sender = threads ? state.senderPane.sender() : null;
  const unreadFirst = (threads ? state.threadUnreadFirst : state.senderUnreadFirst).unreadFirst();
  const searching = threads ? query !== "" || state.searchSender !== null : senderSearchActive(state);
  if (!searching || (threads && !query)) {
    const unread = (group: Message[]) => Number(unreadFirst && group.some((message) => !message.isRead || state.deferredReadSort.has(message.uid)));
    entries = entries
      .map((entry) => ({ entry, unread: unread(entry.group), head: entry.group[0]! }))
      .sort((a, b) => b.unread - a.unread || b.head.timestamp - a.head.timestamp || b.head.uid - a.head.uid)
      .map(({ entry }) => entry);
  }
  if (!threads) {
    state.hasMoreSenders = !searching && entries.length > state.visibleLimit;
    if (!searching) entries = entries.slice(0, state.visibleLimit);
  }
  const order = state.searchAccountOrder;
  if (!threads && searching && order) {
    const positions = new Map(order.map((key, position) => [key, position]));
    const rank = ({ group, location }: (typeof entries)[number]) => positions.get(senderKey(group, location)) ?? Infinity;
    entries = entries.toSorted((a, b) => rank(a) - rank(b));
  }
  const rowKey = ({ group, location }: (typeof entries)[number]) => (sender !== null ? threadKey(group) : senderKey(group, location));
  const rows: Located[] = entries.map((entry) => ({ key: rowKey(entry), messages: entry.group, location: entry.location }));
  if (!threads) {
    if (order) {
      const known = new Set(order);
      order.push(...rows.map((row) => row.key).filter((key) => !known.has(key)));
    }
    state.searchLocations = new Map(rows.flatMap(({ key, location }) => (location ? [[key, location]] : [])));
  }
  const selectedIndex = previous
    ? rows.findIndex((row) => (threads ? row.messages.some((message) => previous.identities.has(messageKey(message))) : row.key === previous.key))
    : -1;
  const multiaccount = state.searchFilters.selectedAccounts().size > 1;
  const captionChanged = !threads && state.searchMultiaccount !== multiaccount;
  if (!threads) state.searchMultiaccount = multiaccount;
  const positions = new Map<string, number>();
  const count = model(list).get_n_items();
  for (let position = 0; position < count; position++) withItem(list, position, (row) => positions.set(row.key, position));
  const changed = rows.flatMap((row, index) => {
    const position = positions.get(row.key);
    const differs = position !== undefined && withItem(list, position, (old) => captionChanged || !sameRow(old.messages, row.messages, threads));
    return differs ? [index] : [];
  });
  preserveOffset(listScroll, () => updateOwned(list, rows, changed, selectedIndex < 0 ? null : selectedIndex));
  if (!threads && searching) refreshSearchSender(state);
  refreshOpenStyles(state);
  if (rows.length > 0) return listStack.set_visible_child_name("list");
  const progress = state.searchRunning[index] && state.searchShowProgress[index];
  const loading = searching ? progress : threads ? state.senderPane.loading() : state.loading && !hasCachedFolder(state);
  if (!threads && !loading && searching) return noSendersFound(listStack);
  const text = progress
    ? "Searching…"
    : loading
      ? "Loading messages..."
      : searching
        ? "No matching messages"
        : sender !== null
          ? "No messages from this sender"
          : "No messages in this folder";
  listState(listStack, text, loading, false);
}

function refreshMessageRows(state: State, message: Message) {
  for (const threads of [false, true]) {
    const list = threads ? state.threadList : state.list;
    const replacement = visibleMessage(state, listHeader(message, threads));
    const count = model(list).get_n_items();
    for (let position = 0; position < count; position++) {
      const row = item(list, position);
      if (!row) continue;
      const location = threads ? undefined : state.searchLocations.get(row.key);
      if (location && (!state.account || state.account.email !== location.account || state.folder !== location.folder)) continue;
      const index = row.messages.findIndex((old) => old.uid === message.uid && old.messageId === message.messageId);
      const previous = row.messages[index];
      if (!previous || !replacement) continue;
      const old = listHeader(previous, threads);
      row.messages[index] = { ...replacement, searchMatch: old.searchMatch };
      if (!sameRow([old], [replacement], threads)) replaceItem(list, position, { ...row, messages: [...row.messages] });
    }
  }
}

export function updateBody(state: State, source: Message) {
  const message = { ...source };
  mergeReadStates(state, [message]);
  prepareDisplay(message);
  const same = (old: Message) => old.uid === message.uid && old.messageId === message.messageId;
  const old = state.messages.find(same) ?? state.senderPane.messages().find(same);
  const searchChanged =
    !old ||
    old.subject !== message.subject ||
    old.sender !== message.sender ||
    old.replyTo !== message.replyTo ||
    old.recipients !== message.recipients ||
    old.cc !== message.cc ||
    old.bodyText !== message.bodyText ||
    old.bodyHtml !== message.bodyHtml;
  const calendarChanged = !!old && !Bun.deepEquals(old.calendarEvents, message.calendarEvents);
  const ticketsChanged = !old || !Bun.deepEquals(old.tickets, message.tickets);
  const hasNewParcel = message.parcels.length > 0 && !!old && old.parcels.length === 0;
  for (const messages of [state.messages, state.senderPane.messages(), state.openGroup]) {
    const index = messages.findIndex(same);
    if (index >= 0) messages[index] = { ...message };
  }
  if (state.searchSender) {
    const matches = state.searchSender.messages;
    const index = matches.findIndex(same);
    if (index >= 0) matches[index] = { ...searchDocument(message), searchMatch: true };
  }
  const visible = visibleMessage(state, message);
  if (!visible) return;
  refreshMessageRows(state, visible);
  state.searchSnapshots = [null, null];
  if (searchChanged)
    for (const threads of [false, true])
      if (searchOpen(state, threads) && (threads ? state.threadSearch : state.search).get_text().trim()) renderOrQueueSearch(state, threads);
  const card = state.cards.get(visible.uid);
  if (card) preserve(state.viewerScroll, state.viewer, () => card.update(visible));
  if (hasNewParcel || calendarChanged || ticketsChanged || visible.calendarEvents.some((event) => event.method === "REPLY"))
    preserve(state.viewerScroll, state.viewer, () => renderConversation(state));
}

function threadKey(group: Message[]) {
  const first = group.reduce((min, message) => (message.uid < min.uid ? message : min));
  return `thread:${first.uid}:${first.messageId}`;
}

const latest = (group: Message[]) => group.reduce<number | null>((max, { timestamp }) => (max === null || timestamp > max ? timestamp : max), null);

const body = (group: Message[]) => {
  const message = group.find((message) => !isReply(message));
  return message ? [message.bodyText, message.bodyHtml] : null;
};

export function sameRow(left: Message[], right: Message[], threads: boolean) {
  const unread = (message: Message) => !message.isRead;
  const spam = (message: Message) => message.isSpam;
  const flagged = (message: Message) => message.isFlagged;
  if (left.some(unread) !== right.some(unread) || (threads && left.some(spam) !== right.some(spam)) || left.some(flagged) !== right.some(flagged)) return false;
  if (threads) {
    const [a, b] = [left[0], right[0]];
    const sameMessage =
      a && b
        ? a.uid === b.uid &&
          a.uidValidity === b.uidValidity &&
          a.messageId === b.messageId &&
          a.subject === b.subject &&
          a.bodyText === b.bodyText &&
          a.bodyHtml === b.bodyHtml &&
          Bun.deepEquals(a.calendarEvents, b.calendarEvents) &&
          a.timestamp === b.timestamp
        : !a && !b;
    return left.length === right.length && sameMessage && Bun.deepEquals(body(left), body(right)) && latest(left) === latest(right);
  }
  const matches = (group: Message[]) => group.filter((message) => message.searchMatch).length;
  if (matches(left) !== matches(right)) return false;
  const [a, b] = [preview(left), preview(right)];
  return a && b ? a.uid === b.uid && a.sender === b.sender && a.subject === b.subject && a.timestamp === b.timestamp && a.date === b.date : !a && !b;
}

export const overlaps = (left: Message[], right: Message[]) => left.some((a) => right.some((b) => a.uid === b.uid && a.messageId === b.messageId));
