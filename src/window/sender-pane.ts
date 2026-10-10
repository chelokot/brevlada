import Gtk from "gi://Gtk?version=4.0";
import { selectMessage } from "../components/states";
import { replace, selection } from "../components/virtual-list";
import type { Message } from "../models";
import { key } from "../models/senders";
import { newSelection } from "./actions";
import { refreshOpenStyles, renderList, renderSenderPane } from "./rendering";
import { cancelSearch } from "./search";
import type { State } from "./state";

export function resetThreads(state: State) {
  cancelSearch(state, true);
  state.searchSnapshots[1] = null;
  state.rendering = true;
  replace(state.threadList, 0, null);
  state.rendering = false;
}

export function filterSender(state: State, message: Message | null) {
  state.searchMessage = null;
  const wasSearch = state.searchSender !== null;
  state.searchSender = null;
  state.nextMessage = null;
  const sender = message && key(message);
  const opening = sender !== null && state.senderPane.sender() === null;
  if (sender !== null && state.account && state.senderActions.dismissSpam(state.account.email, state.folder, sender)) {
    state.senderPane.select(null);
    newSelection(state);
    state.selected = [];
    state.openGroup = [];
    state.cards.clear();
    state.sentCards.clear();
    state.relatedSent = [];
    selectMessage(state.viewer);
    selection(state.list).set_selected(Gtk.INVALID_LIST_POSITION);
    renderList(state);
  }
  if (!state.senderPane.select(sender)) {
    if (wasSearch) {
      resetThreads(state);
      renderSenderPane(state);
    }
    return;
  }
  resetThreads(state);
  state.threadSearch.set_text("");
  state.threadLoadMore.set_visible(false);
  if (opening && state.accountSidebar.getVisible()) {
    state.accountSidebar.setVisible(false);
    state.restoreAccountsOnBack = true;
  } else if (!message && state.restoreAccountsOnBack) {
    state.restoreAccountsOnBack = false;
    state.accountSidebar.setVisible(true);
  }
  state.threadSidebar.setVisible(message !== null);
  state.back.set_visible(message !== null);
  if (message) {
    loadSenderPage(state);
    renderSenderPane(state);
  }
  refreshOpenStyles(state);
  selection(state.list).set_selected(Gtk.INVALID_LIST_POSITION);
  state.threadScroll.get_vadjustment().set_value(0);
}

export function loadSenderPage(state: State) {
  const { account } = state;
  const page = account && state.senderPane.request();
  if (!account || !page) return;
  state.threadLoadMore.set_sensitive(false);
  state.threadLoadMore.set_visible(false);
  state.sender.send({
    type: "LoadSenderPage",
    account,
    folder: state.folder,
    sender: page.sender,
    generation: state.generation,
    senderGeneration: page.ticket,
    before: page.before,
    limit: 25,
  });
}

export function maybeLoadSenderPage(state: State) {
  if (state.rendering || state.threadSearch.get_text().trim() || state.senderPane.loading() || !state.senderPane.canLoad()) return;
  const adjustment = state.threadScroll.get_vadjustment();
  if (adjustment.get_page_size() > 0 && adjustment.get_upper() - adjustment.get_value() - adjustment.get_page_size() < 400) loadSenderPage(state);
}
