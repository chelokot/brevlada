import type { Message } from "../models";
import { open } from "./actions";
import { renderList, updateBody } from "./rendering";
import type { State } from "./state";

export function requestPreview(state: State, message: Message) {
  const { account } = state;
  if (!account) return;
  const loaded = (source: Message) => source.uid === message.uid && source.messageId === message.messageId && source.bodyLoaded;
  if (
    message.bodyLoaded ||
    message.listPreview !== null ||
    (state.searchSender && state.searchSender.messages.some(loaded)) ||
    state.senderPane.messages().some(loaded) ||
    state.messages.some(loaded) ||
    state.pending.has(message.uid) ||
    state.previewPending.has(message.uid)
  )
    return;
  state.previewPending.add(message.uid);
  state.sender.body({ account, folder: state.folder, uid: message.uid, generation: state.generation, selection: state.selection, markRead: false });
}

export function previewLoaded(state: State, preview: Message) {
  state.previewPending.delete(preview.uid);
  applyCachedBody(state, preview);
}

const parsed = ({ parcels, calendarEvents, tickets }: Message) => ({ parcels, calendarEvents, tickets });

export const loadedBody = (source: Message) => {
  const { listPreview, displayPrepared, remoteMedia, bodyHtml, bodyText, attachments, attachmentDetails, inlineMedia, inlineMediaLoaded } = source;
  return { listPreview, displayPrepared, remoteMedia, bodyHtml, bodyText, attachments, attachmentDetails, inlineMedia, inlineMediaLoaded, ...parsed(source) };
};

export function applyCachedBody(state: State, preview: Message) {
  const same = (message: Message) => message.uid === preview.uid && message.messageId === preview.messageId;
  const { listPreview, displayPrepared, remoteMedia, bodyText, bodyHtml, replyTo, cc, attachments, attachmentDetails } = preview;
  const search = state.searchSender;
  if (!state.senderPane.messages().some(same) && !state.openGroup.some(same) && !(search && search.messages.some(same))) {
    const index = state.messages.findIndex(same);
    const header = state.messages[index];
    if (!header) return;
    const body = { bodyText, bodyHtml, recipients: preview.recipients, cc, replyTo, attachments, attachmentDetails, ...parsed(preview) };
    const changed = !Bun.deepEquals({ ...header, ...body }, header);
    state.messages[index] = { ...header, ...body, listPreview, displayPrepared, remoteMedia };
    if (!changed) return;
    state.searchSnapshots = [null, null];
    if (state.search.get_text().trim() || state.threadSearch.get_text().trim()) renderList(state);
    return;
  }
  const found = state.messages.find(same) ?? state.senderPane.messages().find(same) ?? state.openGroup.find(same) ?? (search && search.messages.find(same));
  if (!found) return;
  updateBody(state, { ...found, ...loadedBody(preview), replyTo, cc, bodyLoaded: preview.bodyLoaded, unsubscribe: preview.unsubscribe ?? found.unsubscribe });
  const card = state.cards.get(found.uid);
  if (card && card.isExpanded()) open(state, found.uid);
}
