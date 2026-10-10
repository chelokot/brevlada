import Adw from "gi://Adw?version=1";
import GLib from "gi://GLib?version=2.0";
import Gtk from "gi://Gtk?version=4.0";
import type { Location, Response } from "../backend/search";
import { listState } from "../components/states";
import { groups, model, replace, reveal, withItem } from "../components/virtual-list";
import { mergeInto } from "../models/read-state";
import { selectMailbox } from "./actions";
import { publishSearchGroups, renderPane, renderPaneWithProgress } from "./rendering";
import { filterSender, loadSenderPage, maybeLoadSenderPage } from "./sender-pane";
import type { State } from "./state";

const lane = (threads: boolean) => (threads ? 1 : 0);

const entry = (state: State, threads: boolean) => (threads ? state.threadSearch : state.search);

function searchBar(input: Gtk.SearchEntry) {
  const bar = input.get_ancestor(Gtk.SearchBar.$gtype);
  if (!(bar instanceof Gtk.SearchBar)) throw new Error("Search entries belong to a search bar");
  return bar;
}

const listKeys = (list: Gtk.ListView) =>
  Array.from({ length: model(list).get_n_items() }, (_, position) => withItem(list, position, (row) => row.key)).filter((key) => key !== null);

export function closeSenderPane(state: State) {
  searchBar(state.threadSearch).set_search_mode(false);
  searchBar(state.search).set_search_mode(false);
  filterSender(state, null);
}

export function revealSearchMessage(state: State) {
  if (!state.searchMessage) return;
  const [uid, id] = state.searchMessage;
  const position = groups(state.threadList).findIndex((group) => group.some((message) => message.uid === uid && message.messageId === id));
  if (position >= 0) {
    reveal(state.threadList, position);
    state.searchMessage = null;
  } else if (!state.senderPane.loading()) {
    if (state.senderPane.canLoad()) loadSenderPage(state);
    else state.searchMessage = null;
  }
}

export function cancelSearch(state: State, threads: boolean) {
  state.searchWorker.cancel(threads);
  searchBusy(state, threads, false);
  state.searchRefreshAgain[lane(threads)] = false;
}

function searchBusy(state: State, threads: boolean, busy: boolean) {
  const index = lane(threads);
  state.searchRunning[index] = busy;
  const stack = threads ? state.threadStack : state.listStack;
  state.searchProgress[index].set_visible(busy && state.searchShowProgress[index] && stack.get_visible_child_name() === "list");
}

export function beginSearch(state: State, threads: boolean, showProgress: boolean) {
  const index = lane(threads);
  state.searchShowProgress[index] = showProgress;
  const [list, stack] = threads ? [state.threadList, state.threadStack] : [state.list, state.listStack];
  const retain = model(list).get_n_items() > 0;
  if (!retain && showProgress) {
    replace(list, 0, null);
    listState(stack, "Searching…", true, false);
  }
  state.searchPreserveResults[index] = retain && state.searchPublishedQueries[index] === entry(state, threads).get_text().trim().toLowerCase();
  searchBusy(state, threads, true);
}

export function refreshSearchCache(state: State, email: string, folder: string) {
  const selected = state.searchFilters.folder();
  if (senderSearchActive(state) && (selected === null || selected === folder) && state.searchFilters.selectedAccounts().has(email)) {
    state.searchCacheRevision++;
    renderOrQueueSearch(state, false);
  }
}

export const searchOpen = (state: State, threads: boolean) => searchBar(entry(state, threads)).get_search_mode();

export function refreshAccountTitle(state: State) {
  const title = senderSearchActive(state) ? state.searchFilters.accountLabel() : state.account ? state.account.email : "";
  state.accountTitle.set_label(title);
  state.accountTitle.set_tooltip_text(title || null);
  state.accountTitle.set_visible(!state.accountSidebar.getVisible() && title !== "");
}

export const senderSearchActive = (state: State) => searchOpen(state, false);

export function selectSearchLocation(state: State, location: Location | null) {
  if (!location) return true;
  if (state.account && state.account.email === location.account && state.folder === location.folder) return true;
  const known = state.folderBoxes.get(location.account);
  if (!known) return false;
  const preserve = senderSearchActive(state);
  if (preserve) {
    state.searchFilters.keepSelection();
    state.searchAccountOrder = listKeys(state.list);
  }
  selectMailbox(state, known[0], location.folder, preserve);
  return true;
}

export function renderOrQueueSearch(state: State, threads: boolean) {
  const input = entry(state, threads);
  if (!searchOpen(state, threads) || input.get_text().trim() === "") return renderPane(state, threads);
  const index = lane(threads);
  if (state.searchRunning[index]) {
    state.searchRefreshAgain[index] = true;
    return;
  }
  const pending = state.searchRefreshPending[index];
  if (pending.value) return;
  pending.value = true;
  const bar = new WeakRef(searchBar(input));
  const search = new WeakRef(input);
  const background = state.searchBackgroundRefresh[index];
  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 40, () => {
    pending.value = false;
    const [field, open] = [search.deref(), bar.deref()];
    if (field && open && open.get_search_mode()) {
      background.value = true;
      field.emit("search-changed");
    }
    return GLib.SOURCE_REMOVE;
  });
}

export function connectSearch(state: State) {
  state.searchFilters.connectChanged((change) => {
    if (!senderSearchActive(state)) return;
    refreshAccountTitle(state);
    state.searchAccountOrder = change === "Accounts" ? listKeys(state.list) : null;
    cancelSearch(state, false);
    state.rendering = true;
    renderPane(state, false);
    state.rendering = false;
  });
  for (const threads of [false, true]) {
    const input = entry(state, threads);
    const index = lane(threads);
    searchBar(input).connect("notify::search-mode-enabled", (bar) => {
      cancelSearch(state, threads);
      if (!threads) {
        if (bar.get_search_mode() && state.account) state.searchFilters.resetScope();
        refreshAccountTitle(state);
      }
      if (!bar.get_search_mode()) {
        input.set_text("");
        if (!threads) {
          state.searchAccountOrder = null;
          filterSender(state, null);
        }
      }
      state.rendering = true;
      renderPane(state, threads);
      state.rendering = false;
    });
    input.connect("changed", () => {
      cancelSearch(state, threads);
      if (!threads) state.searchAccountOrder = null;
      if (searchOpen(state, threads) && input.get_text().trim() !== "") beginSearch(state, threads, true);
      else {
        searchBusy(state, threads, false);
        renderPane(state, threads);
      }
    });
    input.connect("search-changed", () => {
      state.rendering = true;
      const background = state.searchBackgroundRefresh[index];
      const showProgress = !background.value || (state.searchRunning[index] && state.searchShowProgress[index]);
      background.value = false;
      renderPaneWithProgress(state, threads, showProgress);
      state.rendering = false;
      if (threads) maybeLoadSenderPage(state);
    });
  }
}

export function searchResponse(state: State, response: Response) {
  if (!state.searchWorker.accepts(response)) return;
  const { threads, complete, error, query, locations } = response;
  const { account, folder } = state;
  const scoped = response.groups.filter((_group, index) => {
    const location = locations[index];
    return threads || (location && account ? location.account === account.email && location.folder === folder : false);
  });
  mergeInto(scoped.flat(), [...state.messages, ...state.senderPane.messages(), ...state.openGroup]);
  state.rendering = true;
  searchBusy(state, threads, !complete);
  if (error === null) publishSearchGroups(state, threads, query, response.groups, locations);
  else {
    listState(state.listStack, "Could not search selected accounts", false, false);
    state.toast.add_toast(Adw.Toast.new(`Search: ${error}`));
  }
  searchBusy(state, threads, !complete);
  state.rendering = false;
  if (!complete || !state.searchRefreshAgain[lane(threads)]) return;
  state.searchRefreshAgain[lane(threads)] = false;
  renderOrQueueSearch(state, threads);
}
