import { listState, loadingThread, refreshing, selectMessage } from "../components/states";
import { card as messageCard } from "../components/viewer";
import { replace } from "../components/virtual-list";
import { type Account, listHeader, type Message } from "../models";
import { address, key } from "../models/senders";
import { MESSAGE_LIMIT } from "../theme";
import { renderConversation } from "./conversation";
import { newComposer } from "./drafts";
import { isTrusted, markMediaDownloaded, mediaKey } from "./index";
import { refreshOpenStyles, renderList } from "./rendering";
import { cancelSearch, refreshAccountTitle, searchOpen, senderSearchActive } from "./search";
import { retainedSpam } from "./sender-actions";
import { resetThreads } from "./sender-pane";
import type { State } from "./state";

export const folderKey = (account: string, folder: string) => JSON.stringify([account, folder]);

export function load(state: State) {
  const { account } = state;
  if (!account) return;
  state.loading = true;
  state.refresh.set_sensitive(false);
  refreshing(state.refresh, true);
  if (!searchOpen(state, false) && state.messages.length === 0 && !hasCachedFolder(state)) listState(state.listStack, "Loading messages...", true, false);
  state.sender.send({ type: "Load", account, folder: state.folder, generation: state.generation });
  loadExpanded(state);
}

export function loadMore(state: State) {
  if (!state.hasMoreSenders) return;
  state.visibleLimit += MESSAGE_LIMIT;
  renderList(state);
}

export function maybeLoadMore(state: State) {
  if (state.rendering || senderSearchActive(state)) return;
  const adjustment = state.listScroll.get_vadjustment();
  const pageSize = adjustment.get_page_size();
  if (pageSize > 0 && adjustment.get_upper() - adjustment.get_value() - pageSize < 400) loadMore(state);
}

export const select = (state: State, account: Account, folder: string) => selectMailbox(state, account, folder, false);

export function selectMailbox(state: State, account: Account, folder: string, preserveSearch: boolean) {
  if (!preserveSearch) cancelSearch(state, false);
  if (state.account && state.messages.length > 0) state.folderCache.set(folderKey(state.account.email, state.folder), state.messages);
  const cached = [...(state.folderCache.get(folderKey(account.email, folder)) ?? [])];
  state.visibleLimit = MESSAGE_LIMIT;
  state.hasMoreSenders = false;
  state.sender.focus(account.email, folder);
  state.generation = state.sender.nextRequest();
  newSelection(state);
  state.calendarHistory.clear();
  state.searchFilters.setCurrent(account.email);
  state.searchFilters.setCurrentFolder(folder, preserveSearch);
  if (!preserveSearch) {
    state.searchAccountOrder = null;
    resetList(state);
  }
  state.account = account;
  refreshAccountTitle(state);
  state.nextMessage = null;
  state.searchMessage = null;
  state.searchSender = null;
  state.senderPane.select(null);
  state.back.set_visible(false);
  state.threadSidebar.setVisible(false);
  if (!preserveSearch) state.restoreAccountsOnBack = false;
  resetThreads(state);
  state.threadSearch.set_text("");
  state.folder = folder;
  state.selected = [];
  state.deferredReadSort.clear();
  state.cards.clear();
  state.sentCards.clear();
  state.relatedSent = [];
  state.sentPending.clear();
  state.openGroup = [];
  state.messages = cached;
  state.loading = true;
  if (preserveSearch) state.searchSnapshots = [null, null];
  else renderList(state);
  selectMessage(state.viewer);
  load(state);
}

export const hasCachedFolder = (state: State) => state.account !== null && state.folderCache.has(folderKey(state.account.email, state.folder));

function resetList(state: State) {
  state.rendering = true;
  replace(state.list, 0, null);
  state.rendering = false;
}

export function showThread(state: State, group: Message[]) {
  state.searchMessage = null;
  state.nextMessage = null;
  newSelection(state);
  const selected = group.map((message) => message.uid);
  if (!Bun.deepEquals(state.selected, selected)) state.deferredReadSort = new Set(group.filter((message) => !message.isRead).map((message) => message.uid));
  state.selected = selected;
  state.conversationLimit = 25;
  state.openGroup = group;
  state.relatedSent = [];
  state.sentPending.clear();
  state.cards.clear();
  state.sentCards.clear();
  loadingThread(state.viewer);
  state.viewerScroll.get_vadjustment().set_value(0);
  requestRelatedSent(state);
  renderConversation(state);
  refreshOpenStyles(state);
  state.viewerReveal.play();
}

export function requestRelatedSent(state: State) {
  const { account, openGroup } = state;
  if (openGroup.length === 0 || !account) return;
  const messages = openGroup.map((message) => listHeader(message, false));
  state.sender.send({ type: "RelatedSent", account, folder: state.folder, messages, generation: state.generation, selection: state.selection });
}

export function card(state: State, message: Message, expanded: boolean, sentFolder: string | null, threaded: boolean, hideQuotes: boolean) {
  const { uid, messageId } = message;
  const media = mediaKey(state, message, sentFolder ?? state.folder);
  const sender = key(message);
  const trusted = (state.account !== null && sender === address(state.account.email)) || isTrusted(state, sender);
  return messageCard(
    message,
    expanded,
    threaded,
    sentFolder !== null,
    hideQuotes,
    state.avatars,
    state.downloadedMedia.has(media),
    trusted,
    state.account,
    sentFolder ?? state.folder,
    () => (sentFolder === null ? open(state, uid) : openSent(state, sentFolder, uid, messageId)),
    (message, action) => newComposer(state, "", [message, sentFolder ?? state.folder, action]),
    () => {
      markMediaDownloaded(state, media);
      open(state, uid);
    },
    (message) => {
      if (state.account) state.sender.send({ type: "Unsubscribe", account: state.account, folder: sentFolder ?? state.folder, uid: message.uid, messageId: message.messageId });
    },
  );
}

export function openSent(state: State, folder: string, uid: number, id: string) {
  const item = state.relatedSent.find((item) => item.message.messageId === id);
  if (!item || item.message.bodyLoaded || !folder || state.sentPending.has(id)) return;
  state.sentPending.add(id);
  if (state.account) state.sender.send({ type: "SentBody", account: state.account, folder, uid, generation: state.generation, selection: state.selection });
}

export function newSelection(state: State) {
  state.selection = state.sender.nextRequest();
  state.sender.select(state.selection);
  state.pending.clear();
  state.previewPending.clear();
  state.sentPending.clear();
  state.parcelHistory.clear();
}

export function loadExpanded(state: State) {
  for (const [uid, view] of state.cards) if (view.isExpanded()) open(state, uid);
}

export function open(state: State, uid: number) {
  const find = (messages: Message[]) => messages.find((message) => message.uid === uid);
  const message = find(state.messages) ?? find(state.senderPane.messages()) ?? find(state.openGroup);
  if (!message || retainedSpam(state, message)) return;
  if (message.bodyLoaded && message.isRead && (!message.bodyHtml.includes("cid:") || message.inlineMediaLoaded)) return;
  if (state.previewPending.has(uid) || state.pending.has(uid)) return;
  state.pending.add(uid);
  const view = state.cards.get(uid);
  if (view) view.loading();
  if (state.account) state.sender.body({ account: state.account, folder: state.folder, uid, generation: state.generation, selection: state.selection, markRead: true });
}
