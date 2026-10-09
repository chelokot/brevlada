import Adw from "gi://Adw?version=1";
import type { Delivered } from "../backend/worker";
import { clear, label } from "../components";
import { populate } from "../components/folders";
import { open as openLink } from "../components/links";
import { preserve } from "../components/scroll-position";
import { noAccounts } from "../components/shell";
import { AccountRow, Unread } from "../components/sidebar";
import { listState, refreshing } from "../components/states";
import { groups, model, selection } from "../components/virtual-list";
import type { Message, SentMessage } from "../models";
import { label as targetLabel } from "../models/action-target";
import { merge } from "../models/read-state";
import { key } from "../models/senders";
import { folderKey, loadExpanded, open, requestRelatedSent, select } from "./actions";
import { draftSaved } from "./autosave";
import { calendarCacheChanged, calendarHistoryLoaded } from "./calendar";
import { renderConversation } from "./conversation";
import { composerFinished, draftBodyError, draftDeleted, draftEditor, reconcileDrafts, updateDraftWidgets } from "./drafts";
import { advanceMessage } from "./message-navigation";
import { deliveryCacheChanged, deliveryHistoryLoaded } from "./parcel-history";
import { applyCachedBody, loadedBody, previewLoaded } from "./previews";
import { mergeReadStates } from "./read-state";
import { overlaps, renderList, renderSenderPane, updateBody } from "./rendering";
import { refreshAccountTitle, refreshSearchCache, revealSearchMessage, searchOpen } from "./search";
import { openSearchSender } from "./search-sender";
import { refreshSenderView } from "./sender-actions";
import { messageKey, type State } from "./state";

const restoredMatch = (original: Message, message: Message) =>
  original.messageId === message.messageId && key(original) === key(message) && original.subject === message.subject && original.timestamp === message.timestamp;

export function event(state: State, delivered: Delivered) {
  const toast = (text: string) => state.toast.add_toast(Adw.Toast.new(text));
  const current = (account: string) => state.account !== null && state.account.email === account;
  const fresh = (generation: number) => generation === state.generation;
  const selected = (generation: number, selection: number) => fresh(generation) && selection === state.selection;
  switch (delivered.type) {
    case "NotificationOpened": {
      const { account, result } = delivered;
      if (!result.ok) return toast(result.error);
      if (!result.value) return toast("This message is no longer available");
      const entry = state.folderBoxes.get(account);
      if (!entry) return;
      select(state, entry[0], "INBOX");
      return openSearchSender(state, key(result.value), [result.value]);
    }
    case "CalendarHistory":
      if (fresh(delivered.generation)) calendarHistoryLoaded(state, delivered.uid, delivered.result);
      return;
    case "CalendarReplied": {
      const { account, uid, recurrenceId, result } = delivered;
      state.calendarPending.delete(JSON.stringify([account, uid, recurrenceId]));
      if (result.ok) {
        if (current(account)) {
          calendarCacheChanged(state, result.value);
          requestRelatedSent(state);
        }
        toast("RSVP sent to the organizer");
      } else toast(`Could not send RSVP: ${result.error}`);
      return preserve(state.viewerScroll, state.viewer, () => renderConversation(state));
    }
    case "Unsubscribe": {
      const { account, folder, uid, messageId, result } = delivered;
      const done = result.ok && result.value.kind === "Done";
      if (current(account)) {
        const card = state.folder === folder && state.cards.get(uid);
        if (card && state.openGroup.some((message) => message.uid === uid && message.messageId === messageId)) card.finishUnsubscribe(done);
        const sent = state.sentCards.get(messageId);
        if (sent) sent.finishUnsubscribe(done);
      }
      if (!result.ok) return toast(`Could not unsubscribe: ${result.error}`);
      return result.value.kind === "Open" ? openLink(result.value.url) : toast("Unsubscribed");
    }
    case "DraftSaved":
      return draftSaved(state, delivered.request, delivered.result);
    case "Composed":
      return composerFinished(state, delivered.request, delivered.result);
    case "DraftDeleted":
      return draftDeleted(state, delivered.request, delivered.result);
    case "SentCacheChanged":
      if (current(delivered.account)) requestRelatedSent(state);
      return;
    case "ParcelHistory":
      if (selected(delivered.generation, delivered.selection)) deliveryHistoryLoaded(state, delivered.sender, delivered.identifier, delivered.messages);
      return;
    case "RelatedSent": {
      if (!selected(delivered.generation, delivered.selection)) return;
      const { messages } = delivered;
      reconcileDrafts(state, messages);
      messages.forEach((item, index) => {
        const { folder, message } = item;
        const same = (old: SentMessage) => old.folder === folder && old.message.uid === message.uid && old.message.messageId === message.messageId;
        const loaded = !message.bodyLoaded && state.relatedSent.find((old) => same(old) && old.message.bodyLoaded);
        if (loaded) messages[index] = { ...item, message: loaded.message };
      });
      if (Bun.deepEquals(state.relatedSent, messages) && state.cards.size > 0) return;
      const onlyDraftsChanged = Bun.deepEquals(
        state.relatedSent.filter((item) => !item.message.isDraft),
        messages.filter((item) => !item.message.isDraft),
      );
      state.relatedSent = messages;
      return preserve(state.viewerScroll, state.viewer, () => (onlyDraftsChanged ? updateDraftWidgets(state) : renderConversation(state)));
    }
    case "SentBody": {
      const { folder, uid, result } = delivered;
      const item = selected(delivered.generation, delivered.selection) && state.relatedSent.find((item) => item.folder === folder && item.message.uid === uid);
      if (!item) return;
      const id = item.message.messageId;
      state.sentPending.delete(id);
      const card = state.sentCards.get(id);
      if (!result.ok) {
        if (card) card.error(result.error);
        return draftBodyError(state, folder, id, result.error);
      }
      const message = result.value;
      item.message = message;
      if (card) card.update(message);
      if (message.isDraft) draftEditor(state, folder, message);
      if (message.calendarEvents.length > 0 || message.tickets.length > 0) {
        calendarCacheChanged(state, message);
        renderConversation(state);
      }
      return;
    }
    case "SpamUndoFinished": {
      const { account, folder, originals, restored, messages, error } = delivered;
      if (messages)
        messages.forEach((message, index) => {
          const original = restored.find((original) => restoredMatch(original, message));
          if (!original) return;
          const { uid, uidValidity, isRead, readRevision, isFlagged, flagRevision } = message;
          const restoredMessage = { ...original, uid, uidValidity, isRead, readRevision, isFlagged, flagRevision, isSpam: false };
          messages[index] = restoredMessage;
          state.senderActions.holdRestored(account, folder, restoredMessage);
        });
      state.senderActions.finishUndoSpam(account, folder, originals, restored);
      if (messages) state.folderCache.set(folderKey(account, folder), [...messages]);
      if (current(account) && state.folder === folder) {
        if (messages) {
          for (const original of restored) {
            const message = messages.find((message) => restoredMatch(original, message));
            if (!message) continue;
            state.senderPane.replace(original, message);
            state.openGroup = state.openGroup.map((opened) => (opened.uid === original.uid && opened.messageId === original.messageId ? { ...message } : opened));
            state.selected = state.selected.map((uid) => (uid === original.uid ? message.uid : uid));
            state.cards.delete(original.uid);
          }
          event(state, { type: "Messages", generation: state.generation, messages, cached: state.loading });
        }
        refreshSenderView(state);
        if (restored.length > 0 && state.openGroup.length > 0) {
          renderConversation(state);
          const position = groups(state.threadList).findIndex((group) => overlaps(group, state.openGroup));
          if (position >= 0) selection(state.threadList).set_selected(position);
        }
      }
      if (error !== null) toast(`Could not undo spam: ${error}`);
      return;
    }
    case "SenderActionFinished": {
      const { account, folder, sender, messages, error, removed } = delivered;
      const action = state.senderActions.finish(account, folder, sender);
      if (action && action.kind === "Spam") state.senderActions.finishSpam(account, folder, sender, removed);
      state.senderActions.confirmRemoved(account, folder, removed);
      if (messages) {
        const previous = state.folderCache.get(folderKey(account, folder));
        if (previous) merge(messages, previous);
        state.folderCache.set(folderKey(account, folder), [...messages]);
      }
      if (current(account) && state.folder === folder) {
        state.senderPane.remove(removed.filter((message) => !state.senderActions.isRetainedSpam(account, folder, message)));
        if (messages) event(state, { type: "Messages", generation: state.generation, messages, cached: state.loading });
        else refreshSenderView(state);
        refreshSenderView(state);
        advanceMessage(state);
        loadExpanded(state);
      }
      if (error !== null) toast(`Action for ${targetLabel(sender)}: ${error}`);
      return;
    }
    case "Accounts": {
      const { accounts } = delivered;
      state.searchFilters.setAccounts(accounts);
      refreshAccountTitle(state);
      state.sync.set_sensitive(accounts.length > 0);
      clear(state.sidebar);
      state.folderBoxes.clear();
      state.folderNames.clear();
      state.unread.clear();
      if (accounts.length === 0) noAccounts(state.sidebar);
      for (const account of accounts) {
        const expansion = state.expansion.forAccount(account.email);
        state.sender.expanded(account.email, expansion.isExpanded(""));
        const unread = new Unread();
        const row = new AccountRow(
          account,
          unread,
          expansion,
          state.avatars,
          state.navigationSelection,
          () => select(state, account, "INBOX"),
          () => state.sender.send({ type: "Folders", account }),
        );
        state.sidebar.append(row.widget);
        row.folders.connect("notify::visible", (folders) => state.sender.expanded(account.email, folders.get_visible()));
        state.unread.set(account.email, unread);
        state.folderBoxes.set(account.email, [account, row.folders]);
      }
      return;
    }
    case "SidebarReady":
      return state.sender.sync();
    case "Folders": {
      const { account: email, folders } = delivered;
      if (Bun.deepEquals(state.folderNames.get(email), folders)) return;
      state.folderNames.set(email, folders);
      const entry = state.folderBoxes.get(email);
      const unread = state.unread.get(email);
      if (!entry || !unread) return;
      const [account, container] = entry;
      container.remove_css_class("folders-loading");
      clear(container);
      populate(container, folders, unread, state.expansion.forAccount(email), state.navigationSelection, (folder) => select(state, account, folder));
      if (!container.get_first_child()) container.append(label("No folders", "dim-label"));
      return;
    }
    case "Unread":
    case "UnreadSnapshot": {
      const unread = state.unread.get(delivered.account);
      if (!unread) return;
      return delivered.type === "Unread" ? unread.update(delivered.folders) : unread.replace(delivered.folders);
    }
    case "Messages": {
      const { messages, cached } = delivered;
      if (!fresh(delivered.generation)) return;
      mergeReadStates(state, messages);
      state.loading = cached;
      state.refresh.set_sensitive(!cached);
      refreshing(state.refresh, cached);
      const known = [...state.messages, ...state.senderPane.messages()].filter((message) => message.bodyLoaded);
      const loaded = new Map(known.map((message) => [messageKey(message), message]));
      messages.forEach((message, index) => {
        const existing = !message.bodyLoaded && loaded.get(messageKey(message));
        if (!existing) return;
        messages[index] = { ...message, ...loadedBody(existing), bodyLoaded: true, unsubscribe: message.unsubscribe ?? existing.unsubscribe };
      });
      if ((!cached || messages.length > 0) && state.account) state.folderCache.set(folderKey(state.account.email, state.folder), [...messages]);
      state.messages = messages;
      if (state.senderPane.sender() !== null) {
        const byId = new Map(messages.map((message) => [messageKey(message), message]));
        const pane = state.senderPane.messages();
        pane.forEach((message, index) => {
          const updated = byId.get(messageKey(message));
          if (updated) pane[index] = { ...updated };
        });
      }
      renderList(state);
      return loadExpanded(state);
    }
    case "SenderPage": {
      const { messages, senderGeneration, hasMore } = delivered;
      if (!fresh(delivered.generation) || !state.senderPane.accepts(senderGeneration)) return;
      mergeReadStates(state, messages);
      state.senderPane.finish(senderGeneration, messages, hasMore);
      state.threadLoadMore.set_visible(false);
      state.threadLoadMore.set_sensitive(true);
      renderSenderPane(state);
      revealSearchMessage(state);
      return advanceMessage(state);
    }
    case "SenderPageError": {
      const { senderGeneration, error } = delivered;
      if (!fresh(delivered.generation) || !state.senderPane.accepts(senderGeneration)) return;
      state.senderPane.fail(senderGeneration);
      state.threadLoadMore.set_visible(true);
      state.threadLoadMore.set_sensitive(true);
      if (state.senderPane.messages().length === 0 && model(state.threadList).get_n_items() === 0)
        listState(state.threadStack, "Could not load messages", false, false);
      return toast(`Could not load sender messages: ${error}`);
    }
    case "CacheList": {
      const { account, folder, messages } = delivered;
      refreshSearchCache(state, account, folder);
      if (current(account) && state.folder === folder) {
        if (!state.loading) event(state, { type: "Messages", generation: state.generation, messages, cached: false });
        return;
      }
      const previous = state.folderCache.get(folderKey(account, folder));
      if (previous) merge(messages, previous);
      state.folderCache.set(folderKey(account, folder), messages);
      return;
    }
    case "CacheBody": {
      const { account, folder, message } = delivered;
      refreshSearchCache(state, account, folder);
      if (!current(account)) return;
      if (state.folder === folder) {
        applyCachedBody(state, message);
        deliveryCacheChanged(state, message);
      }
      return calendarCacheChanged(state, message);
    }
    case "Preview":
      if (selected(delivered.generation, delivered.selection)) previewLoaded(state, delivered.message);
      return;
    case "PreviewError": {
      if (!selected(delivered.generation, delivered.selection)) return;
      const { uid } = delivered;
      state.previewPending.delete(uid);
      const card = state.cards.get(uid);
      if (card && (card.isExpanded() || card.isResponsePending())) open(state, uid);
      return;
    }
    case "Body": {
      if (!selected(delivered.generation, delivered.selection)) return;
      const { message } = delivered;
      if (message.isRead) state.pending.delete(message.uid);
      updateBody(state, message);
      if (message.isDraft) draftEditor(state, state.folder, message);
      if (message.isRead) loadExpanded(state);
      return;
    }
    case "BodyError": {
      if (!selected(delivered.generation, delivered.selection)) return;
      const { uid, error } = delivered;
      state.pending.delete(uid);
      const card = state.cards.get(uid);
      if (card) card.error(error);
      const loaded = (message: Message) => message.uid === uid && message.bodyLoaded;
      if (state.messages.some(loaded) || state.senderPane.messages().some(loaded)) toast(error);
      return;
    }
    case "Avatar":
      return state.avatars.resolved(delivered.email, delivered.image);
    case "Error": {
      const { generation, error } = delivered;
      if (generation !== null && !fresh(generation)) return;
      if (generation !== null) {
        state.loading = false;
        state.refresh.set_sensitive(state.account !== null);
      }
      refreshing(state.refresh, false);
      if (!searchOpen(state, false) && state.messages.length === 0) listState(state.listStack, `Failed to load messages: ${error}`, false, true);
      else toast(error);
    }
  }
}
