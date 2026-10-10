import { item, position } from "../components/virtual-list";
import type { Message } from "../models";
import { mergeInto } from "../models/read-state";
import { preview } from "../models/senders";
import { showThread } from "./actions";
import { renderSenderPane } from "./rendering";
import { cancelSearch, renderOrQueueSearch, revealSearchMessage } from "./search";
import { visibleGroup } from "./sender-actions";
import { filterSender, resetThreads } from "./sender-pane";
import { messageKey, type State } from "./state";

export interface SenderMatches {
  key: string;
  messages: Message[];
}

export function openSearchSender(state: State, key: string, messages: Message[]) {
  const found = preview(messages);
  if (!found) return;
  const message = { ...found, searchMatch: false };
  filterSender(state, message);
  state.threadSearch.set_text("");
  state.searchSender = { key, messages };
  resetThreads(state);
  renderSenderPane(state);
  showThread(state, [message]);
  state.searchMessage = [message.uid, message.messageId];
  revealSearchMessage(state);
}

export function matchedSenderMessages(state: State) {
  if (!state.searchSender) return null;
  const matches = new Map(state.searchSender.messages.map((message) => [messageKey(message), message]));
  const known = [...state.messages, ...state.senderPane.messages(), ...state.openGroup];
  for (const message of known) {
    const matched = matches.get(messageKey(message));
    if (matched && (message.bodyLoaded || !matched.bodyLoaded)) matches.set(messageKey(message), message);
  }
  const merged = [...matches.values()].map((message) => ({ ...message }));
  mergeInto(merged, known);
  return visibleGroup(state, merged);
}

export function refreshSearchSender(state: State) {
  const search = state.searchSender;
  if (!search) return;
  const found = position(state.list, search.key);
  const row = found === null ? null : item(state.list, found);
  const matches = (row ? row.messages : []).map((message) => {
    const loaded = search.messages.find((old) => old.uid === message.uid && old.messageId === message.messageId && old.bodyLoaded);
    return loaded ? { ...message, bodyText: loaded.bodyText, bodyHtml: loaded.bodyHtml, bodyLoaded: true, listPreview: loaded.listPreview } : message;
  });
  if (Bun.deepEquals(search.messages, matches)) return;
  search.messages = matches;
  state.searchSnapshots[1] = null;
  cancelSearch(state, true);
  renderOrQueueSearch(state, true);
}
