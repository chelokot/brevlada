import type Gtk from "gi://Gtk?version=4.0";
import type { Card } from "../components/viewer";
import { type Message, prepareDisplay } from "../models";
import { quotedMessageVisible } from "../models/conversation";
import { card as messageCard, open, openSent } from "./actions";
import { draftInComposer } from "./autosave";
import { calendarWidgets } from "./calendar";
import { draftEditor, draftKey } from "./drafts";
import { parcelWidgets } from "./parcel-history";
import { messageKey, type State } from "./state";
import { ticketWidgets } from "./tickets";

export type Source = [sent: boolean, folder: string, message: Message];

export function renderConversation(state: State) {
  const byId = new Map(state.messages.map((message) => [messageKey(message), message]));
  for (const message of state.senderPane.messages()) if (message.bodyLoaded || !byId.has(messageKey(message))) byId.set(messageKey(message), message);
  const sources = [
    ...state.openGroup.map((original): Source => [false, "", byId.get(messageKey(original)) ?? original]),
    ...state.relatedSent.map(({ folder, message }): Source => [true, folder, message]),
  ]
    .filter(([sent, folder, message]) => !state.draftRemoved.has(draftKey(state, sent ? folder : state.folder, message.messageId)))
    .sort(([, , a], [, , b]) => b.timestamp - a.timestamp || b.uid - a.uid);
  const messages = sources.slice(0, state.conversationLimit).map(([sent, folder, message]): Source => [sent, folder, { ...message }]);
  for (const [, , message] of messages) prepareDisplay(message);
  const group = messages.flatMap(([sent, , message]) => (sent ? [] : [message]));
  const previous = new Map(state.cards);
  const previousSent = new Map(state.sentCards);
  const widgets: Gtk.Widget[] = [];
  state.cards.clear();
  state.sentCards.clear();
  state.viewer.set_vexpand(false);
  const parcels = parcelWidgets(state, messages, group);
  const tickets = ticketWidgets(messages);
  const events = calendarWidgets(state, messages);
  const shown = messages.map(([, , message], index) => !message.isDraft && !events.compact.has(index));
  const threaded = shown.filter(Boolean).length > 1;
  const firstMessage = shown.indexOf(true);
  const unread = messages.some(([sent, , message], index) => !sent && !message.isDraft && !message.isRead && !events.compact.has(index));
  messages.forEach(([sent, folder, message], index) => {
    if (events.compact.has(index)) {
      if (!sent && !message.isRead) open(state, message.uid);
      return;
    }
    if (message.isDraft) {
      const draftFolder = sent ? folder : state.folder;
      if (draftInComposer(state, draftFolder, message.messageId)) return;
      const editor = draftEditor(state, draftFolder, message);
      widgets.push(editor.widget);
      if (message.bodyLoaded || editor.loaded) return;
      if (sent) openSent(state, draftFolder, message.uid, message.messageId);
      else open(state, message.uid);
      return;
    }
    for (const context of [parcels, tickets, events.before]) widgets.push(...(context[index] ?? []));
    const older = messages.slice(index + 1).flatMap(([, , older], offset) => (events.compact.has(index + 1 + offset) || older.isDraft ? [] : [older]));
    const hideQuotes = quotedMessageVisible(message, older);
    const old = sent ? previousSent.get(message.messageId) : previous.get(message.uid);
    const expanded = old ? old.isExpanded() : (!sent && !message.isRead) || (!unread && index === firstMessage);
    let view: Card;
    if (old && old.layoutMatches(message, threaded, hideQuotes)) {
      old.update(message);
      view = old;
    } else view = messageCard(state, message, expanded, sent ? folder : null, threaded, hideQuotes);
    widgets.push(view.widget);
    if (sent) {
      state.sentCards.set(message.messageId, view);
      if (expanded && !message.bodyLoaded) openSent(state, folder, message.uid, message.messageId);
    } else state.cards.set(message.uid, view);
    if (expanded && !sent) open(state, message.uid);
  });
  if (sources.length > messages.length) {
    state.conversationMore.set_label(`Load older messages (${sources.length - messages.length})`);
    widgets.push(state.conversationMore);
  }
  const kept = new Set(widgets);
  for (let child = state.viewer.get_first_child(); child; ) {
    const next = child.get_next_sibling();
    if (!kept.has(child)) state.viewer.remove(child);
    child = next;
  }
  let previousWidget: Gtk.Widget | null = null;
  for (const widget of widgets) {
    if (widget.get_parent()) state.viewer.reorder_child_after(widget, previousWidget);
    else state.viewer.insert_child_after(widget, previousWidget);
    previousWidget = widget;
  }
}
