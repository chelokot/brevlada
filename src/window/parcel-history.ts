import Gtk from "gi://Gtk?version=4.0";
import { card } from "../components/parcel";
import { preserve } from "../components/scroll-position";
import type { Message } from "../models";
import { type Identifier, identifier, type Parcel, parseMessage, sequence } from "../models/parcel";
import { key } from "../models/senders";
import { renderConversation, type Source } from "./conversation";
import type { State } from "./state";

const historyKey = (sender: string, { kind, value }: Identifier) => JSON.stringify([sender, kind, value]);

const rerender = (state: State) => preserve(state.viewerScroll, state.viewer, () => renderConversation(state));

export function parcelWidgets(state: State, messages: Source[], group: Message[]) {
  const slots = messages.map(([sent, , message]) => ({ sent, message, widgets: new Array<Gtk.Widget>() }));
  const received = slots.filter(({ sent, message }) => !sent && !message.isDraft);
  const latest = new Map<string, [Parcel, Message]>();
  for (const { message } of received) {
    const sender = key(message);
    for (const parcel of message.parcels) {
      const id = identifier(parcel);
      if (id && sender && !latest.has(historyKey(sender, id))) latest.set(historyKey(sender, id), [parcel, message]);
    }
  }
  for (const slot of received.toReversed()) {
    const sender = key(slot.message);
    for (const parcel of slot.message.parcels) {
      const id = identifier(parcel);
      const newest: [Parcel, Message] | undefined = id && sender ? latest.get(historyKey(sender, id)) : [parcel, slot.message];
      if (!newest) continue;
      if (id && sender) latest.delete(historyKey(sender, id));
      const [shown, source] = newest;
      slot.widgets.push(card(deliverySequence(state, shown, source, group), source.timestamp));
    }
  }
  return slots.map(({ widgets }) => widgets);
}

export function deliveryCacheChanged(state: State, message: Message) {
  const sender = key(message);
  const loaded = message.parcels.length === 0 ? { ...message, parcels: parseMessage(message) } : message;
  let changed = false;
  for (const update of loaded.parcels) {
    const id = identifier(update);
    const history = id && state.parcelHistory.get(historyKey(sender, id));
    if (!id || !history || history.some((old) => Bun.deepEquals(old, loaded))) continue;
    state.parcelHistory.set(historyKey(sender, id), [...history.filter((old) => old.uid !== loaded.uid || old.messageId !== loaded.messageId), loaded]);
    changed = true;
  }
  if (changed) rerender(state);
}

export function deliverySequence(state: State, parcel: Parcel, source: Message, group: Message[]) {
  const id = identifier(parcel);
  const sender = key(source);
  if (!id || !sender) return parcel;
  const history = historyKey(sender, id);
  if (!state.parcelHistory.has(history) && state.account) {
    state.parcelHistory.set(history, []);
    state.sender.send({
      type: "ParcelHistory",
      account: state.account,
      folder: state.folder,
      sender,
      identifier: id,
      generation: state.generation,
      selection: state.selection,
    });
  }
  const cached = state.parcelHistory.get(history) ?? [];
  return sequence(parcel, source, [cached, group, state.messages, state.senderPane.messages()].values().flatMap((messages) => messages));
}

export function deliveryHistoryLoaded(state: State, sender: string, id: Identifier, incoming: Message[]) {
  const history = historyKey(sender, id);
  const messages = [...incoming];
  for (const message of state.parcelHistory.get(history) ?? [])
    if (!messages.some((known) => known.uid === message.uid && known.messageId === message.messageId)) messages.push(message);
  messages.sort((a, b) => a.timestamp - b.timestamp || a.uid - b.uid);
  if (Bun.deepEquals(state.parcelHistory.get(history), messages)) return;
  state.parcelHistory.set(history, messages);
  rerender(state);
}
