import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import Adw from "gi://Adw?version=1";
import GLib from "gi://GLib?version=2.0";
import Gtk from "gi://Gtk?version=4.0";
import type { Engine } from "../application";
import { failure } from "../backend/protocol";
import { type Location, Search } from "../backend/search";
import type { MailWorker } from "../backend/worker";
import { ActiveRow } from "../components/active-row";
import { Avatars } from "../components/avatars";
import { Expansion } from "../components/expansion";
import { attachOpenMessage } from "../components/mail-shortcuts";
import { preserveOffset } from "../components/scroll-position";
import { attachView } from "../components/sender-menu";
import { createShell, type Shell } from "../components/shell";
import { Selection } from "../components/sidebar";
import { item } from "../components/virtual-list";
import type { Message } from "../models";
import type { ActionTarget } from "../models/action-target";
import { PendingActions } from "../models/pending-actions";
import { SenderPane } from "../models/sender-pane";
import { address, key } from "../models/senders";
import { MESSAGE_LIMIT, SMALL_SPACING, SPACING, SYNC_SECONDS } from "../theme";
import { load, maybeLoadMore } from "./actions";
import { renderConversation } from "./conversation";
import { newComposer } from "./drafts";
import { event } from "./events";
import { flushBeforeClose } from "./lifecycle";
import { connectLists } from "./lists";
import { renderList } from "./rendering";
import { closeSenderPane, connectSearch, refreshAccountTitle, searchResponse, selectSearchLocation } from "./search";
import { menuActions, menuActionsForMessages, senderAction } from "./sender-actions";
import { loadSenderPage, maybeLoadSenderPage } from "./sender-pane";
import { connectSettings } from "./settings";
import { rememberSorting } from "./sorting";
import type { Flag, State } from "./state";

type MenuTarget = [target: ActionTarget, location: Location | null, messages: Message[]];

const configPath = (file: string) => join(GLib.get_user_config_dir(), "brevlada", file);

function restore<T>(file: string, name: string, parse: (data: unknown) => T, empty: T) {
  const path = configPath(file);
  if (!existsSync(path)) return empty;
  try {
    return parse(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    console.error(`Could not restore ${name}: ${failure(error)}`);
    return empty;
  }
}

function persist(file: string, json: string) {
  const path = configPath(file);
  mkdirSync(dirname(path), { recursive: true });
  GLib.file_set_contents(path, json);
}

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

const mediaEntry = (value: unknown) =>
  Array.isArray(value) && value.length === 4 && strings([value[0], value[1], value[3]]) && Number.isInteger(value[2]);

export const loadTrustedSenders = () =>
  restore(
    "trusted-senders.json",
    "trusted senders",
    (data) => {
      if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error("invalid type: expected a map");
      return new Map(
        Object.entries(data).map(([account, senders]) => {
          if (!strings(senders)) throw new Error("invalid type: expected a sequence of strings");
          return [account, new Set(senders)];
        }),
      );
    },
    new Map<string, Set<string>>(),
  );

export const loadDownloadedMedia = () =>
  restore(
    "downloaded-media.json",
    "downloaded media",
    (data) => {
      if (!Array.isArray(data) || !data.every(mediaEntry)) throw new Error("invalid type: expected a sequence of media keys");
      return new Set(data.map((entry) => JSON.stringify(entry)));
    },
    new Set<string>(),
  );

export function create(app: Adw.Application, engine: Engine) {
  const shell = createShell(app);
  const { window, settings } = shell;
  const sender = engine.worker;
  const state = createState(shell, sender, Expansion.load(), new Avatars((email) => sender.avatars(email)));
  void connectSettings(state, window, settings, configPath("settings.json"));
  rememberSorting(state, configPath("sorting.json"));
  for (const threads of [false, true]) {
    const list = threads ? state.threadList : state.list;
    attachView<MenuTarget>(
      list,
      threads ? state.threadScroll : state.listScroll,
      (index) => {
        const row = item(list, index);
        if (!row) return null;
        const [first] = row.messages;
        const target: ActionTarget | null = threads
          ? { kind: "Messages", messages: row.messages.map(({ uid, messageId }) => [uid, messageId]) }
          : first
            ? { kind: "Sender", sender: key(first) }
            : null;
        return target && [[target, threads ? null : (state.searchLocations.get(row.key) ?? null), row.messages], !threads];
      },
      ([target, location], action) => {
        if (selectSearchLocation(state, location)) senderAction(state, target, action);
      },
      ([target, location]) =>
        target.kind === "Sender" && (location ? state.trustedSenders.get(location.account)?.has(target.sender) === true : isSenderTrusted(state, target.sender)),
      ([target, location]) => {
        if (target.kind === "Sender" && selectSearchLocation(state, location)) toggleTrust(state, target.sender);
      },
      ([target, location, messages]) =>
        location && !(state.account && state.account.email === location.account && state.folder === location.folder)
          ? menuActionsForMessages(location.folder, messages)
          : menuActions(state, target),
    );
  }
  state.back.connect("clicked", () => closeSenderPane(state));
  state.refresh.connect("clicked", () => load(state));
  state.sync.connect("clicked", (button) => {
    button.set_sensitive(false);
    state.sender.sync();
  });
  state.threadLoadMore.connect("clicked", () => loadSenderPage(state));
  state.listScroll.get_vadjustment().connect("value-changed", () => maybeLoadMore(state));
  state.listScroll.get_vadjustment().connect("changed", () => maybeLoadMore(state));
  state.threadScroll.get_vadjustment().connect("value-changed", () => maybeLoadSenderPage(state));
  const weak = new WeakRef(state);
  const timers = [
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, SYNC_SECONDS * 1000, () => {
      const state = weak.deref();
      if (!state) return GLib.SOURCE_REMOVE;
      if (!state.loading) load(state);
      return GLib.SOURCE_CONTINUE;
    }),
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
      const state = weak.deref();
      if (!state) return GLib.SOURCE_REMOVE;
      const status = state.sender.syncStatus();
      if (status) {
        state.sync.set_sensitive(status.active === 0 && status.queued === 0 && state.folderBoxes.size > 0);
        state.syncStatus.update(status);
      }
      return GLib.SOURCE_CONTINUE;
    }),
  ];
  const closing: Flag = { value: false };
  const closeReady: Flag = { value: false };
  window.connect("close-request", (window) => {
    if (closing.value) return true;
    if (!closeReady.value && flushBeforeClose(state, window, closing, closeReady)) return true;
    engine.detach();
    state.searchWorker.stop();
    for (const timer of timers.splice(0)) GLib.source_remove(timer);
    return false;
  });
  engine.attach((delivered) => {
    const state = weak.deref();
    if (state) event(state, delivered);
  });
  state.sender.send({ type: "Discover" });
  window.present();
}

export function markMediaDownloaded(state: State, media: string) {
  if (state.downloadedMedia.has(media)) return;
  state.downloadedMedia.add(media);
  try {
    persist("downloaded-media.json", `[${[...state.downloadedMedia].join(",")}]`);
  } catch (error) {
    state.toast.add_toast(Adw.Toast.new(`Could not save downloaded media: ${failure(error)}`));
  }
}

export const mediaKey = (state: State, { uid, messageId }: Message, folder: string) =>
  JSON.stringify([state.account ? state.account.email : "", folder, uid, messageId]);

export const isTrusted = (state: State, sender: string) => state.settings.trustAllSenders || isSenderTrusted(state, sender);

export const isSenderTrusted = (state: State, sender: string) => state.account !== null && state.trustedSenders.get(state.account.email)?.has(sender) === true;

export function toggleTrust(state: State, sender: string) {
  if (!state.account) return;
  const account = state.account.email;
  const own = address(account) === sender;
  const senders = state.trustedSenders.get(account) ?? new Set<string>();
  state.trustedSenders.set(account, senders);
  const trusted = !senders.delete(sender);
  if (trusted) senders.add(sender);
  try {
    persist("trusted-senders.json", JSON.stringify(Object.fromEntries([...state.trustedSenders].map(([account, senders]) => [account, [...senders]]))));
  } catch (error) {
    state.toast.add_toast(Adw.Toast.new(`Could not save trusted senders: ${failure(error)}`));
  }
  for (const message of state.messages) {
    const card = key(message) === sender && state.cards.get(message.uid);
    if (card) card.setTrusted(trusted || own || state.settings.trustAllSenders);
  }
}

export function createState({ window, settings: _, ...shell }: Shell, sender: MailWorker, expansion: Expansion, avatars: Avatars) {
  const conversationMore = new Gtk.Button({ label: "Load older messages", halign: Gtk.Align.CENTER, marginTop: SMALL_SPACING, marginBottom: SPACING });
  const state: State = {
    ...shell,
    sender,
    senderActions: new PendingActions(),
    account: null,
    folder: "",
    generation: 0,
    selection: 0,
    pending: new Set(),
    previewPending: new Set(),
    loading: false,
    rendering: false,
    messages: [],
    visibleLimit: MESSAGE_LIMIT,
    hasMoreSenders: false,
    folderCache: new Map(),
    activeSenderRow: new ActiveRow(),
    activeThreadRow: new ActiveRow(),
    senderPane: new SenderPane(),
    selected: [],
    nextMessage: null,
    searchMessage: null,
    searchSender: null,
    deferredReadSort: new Set(),
    cards: new Map(),
    sentCards: new Map(),
    relatedSent: [],
    parcelHistory: new Map(),
    calendarHistory: new Map(),
    calendarPending: new Set(),
    draftEditors: new Map(),
    draftRemoved: new Set(),
    draftLocal: new Map(),
    composerPending: new Map(),
    sentPending: new Set(),
    openGroup: [],
    trustedSenders: loadTrustedSenders(),
    settings: { trustAllSenders: false, backgroundService: false },
    downloadedMedia: loadDownloadedMedia(),
    restoreAccountsOnBack: false,
    folderBoxes: new Map(),
    folderNames: new Map(),
    unread: new Map(),
    conversationLimit: 25,
    conversationMore,
    navigationSelection: new Selection(),
    expansion,
    avatars,
    openComposers: [],
    searchLocations: new Map(),
    searchCacheRevision: 0,
    searchRunning: [false, false],
    searchShowProgress: [false, false],
    searchBackgroundRefresh: [{ value: false }, { value: false }],
    searchRefreshAgain: [false, false],
    searchMultiaccount: false,
    searchPreserveResults: [false, false],
    searchPublishedQueries: ["", ""],
    searchAccountOrder: null,
    searchWorker: Search.start((response) => searchResponse(state, response)),
    searchSnapshots: [null, null],
    searchRefreshPending: [{ value: false }, { value: false }],
  };
  conversationMore.connect("clicked", () => {
    state.conversationLimit += 25;
    preserveOffset(state.viewerScroll, () => renderConversation(state));
  });
  connectSearch(state);
  for (const toggle of [state.senderUnreadFirst, state.threadUnreadFirst])
    toggle.connectChanged(() => {
      state.searchAccountOrder = null;
      renderList(state);
    });
  connectLists(state);
  attachOpenMessage(window, state.threadList, state.composers, (action) => {
    if (state.openGroup.length === 0) return false;
    senderAction(state, { kind: "Messages", messages: state.openGroup.map(({ uid, messageId }) => [uid, messageId]) }, action);
    return true;
  });
  state.accountSidebar.connectVisibleNotify(() => {
    state.restoreAccountsOnBack = false;
    refreshAccountTitle(state);
  });
  state.composeButton.connect("clicked", () => newComposer(state, state.senderPane.sender() ?? "", null));
  return state;
}
