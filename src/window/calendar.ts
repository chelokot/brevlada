import Adw from "gi://Adw?version=1";
import Gtk from "gi://Gtk?version=4.0";
import type { Result } from "../backend/protocol";
import { card, participants as participantRows, withParticipants } from "../components/calendar";
import { preserve } from "../components/scroll-position";
import type { Account, Message } from "../models";
import { events as calendarEvents, compactReply, type Event, participants, type Response, sameEvent, snapshot } from "../models/calendar";
import { calendarEvent } from "../models/ticket";
import { renderConversation, type Source } from "./conversation";
import type { State } from "./state";

const pendingKey = (account: string, { uid, recurrenceId }: Event) => JSON.stringify([account, uid ?? "", recurrenceId]);

const closing = ({ method }: Event) => method === "REPLY" || method === "CANCEL";

const rerender = (state: State) => preserve(state.viewerScroll, state.viewer, () => renderConversation(state));

export function calendarWidgets(state: State, messages: Source[]) {
  const slots = messages.map(([, , message]) => ({ message, widgets: new Array<Gtk.Widget>() }));
  const widgets = { before: slots.map(({ widgets }) => widgets), compact: new Set<number>() };
  const { account } = state;
  if (!account) return widgets;
  const events: Event[] = [];
  const invitations: Event[] = [];
  const sources = slots
    .flatMap((slot, index) => (slot.message.isDraft ? [] : calendarEvents(slot.message).map((source) => ({ index, slot, source }))))
    .sort((a, b) => Number(closing(a.source)) - Number(closing(b.source)) || b.index - a.index);
  for (const { slot, source } of sources) {
    const { message } = slot;
    const booked = (event: Event | null) => event !== null && sameEvent(event, source);
    if (!source.invitation && message.tickets.some((reservation) => reservation.kind === "Event" && booked(calendarEvent(reservation)))) continue;
    if (events.some((old) => sameEvent(old, source))) continue;
    if (source.uid !== null && !state.calendarHistory.has(source.uid)) {
      state.calendarHistory.set(source.uid, []);
      state.sender.send({ type: "CalendarHistory", account, uid: source.uid, generation: state.generation });
    }
    const cached = (source.uid !== null && state.calendarHistory.get(source.uid)) || [];
    const context = [...slots.map(({ message }) => message), ...cached];
    const event = snapshot(source, context);
    const view = card(event, account.email, state.calendarPending.has(pendingKey(account.email, event)), (response) =>
      calendarReply(state, account, message, event, response),
    );
    if (!closing(source) && event.attendees.length > 0) {
      slot.widgets.push(withParticipants(view, participantRows(participants(event, context), state.avatars)));
      invitations.push(event);
    } else slot.widgets.push(view);
    events.push(event);
  }
  widgets.compact = new Set(messages.flatMap(([, , message], index) => (compactReply(message, invitations) ? [index] : [])));
  return widgets;
}

function calendarReply(state: State, account: Account, message: Message, event: Event, response: Response) {
  const key = pendingKey(account.email, event);
  if (state.calendarPending.has(key)) return;
  state.calendarPending.add(key);
  state.sender.send({ type: "CalendarReply", account, message, event, response });
  rerender(state);
}

export function calendarHistoryLoaded(state: State, uid: string, result: Result<Message[]>) {
  if (!result.ok) {
    state.calendarHistory.delete(uid);
    state.toast.add_toast(Adw.Toast.new(`Could not load RSVP history: ${result.error}`));
    return;
  }
  const messages = [...result.value];
  for (const message of state.calendarHistory.get(uid) ?? []) if (!messages.some((old) => old.messageId === message.messageId)) messages.push(message);
  messages.sort((a, b) => (a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : a.uid - b.uid));
  if (Bun.deepEquals(state.calendarHistory.get(uid), messages)) return;
  const visible = calendarVisible(state, uid);
  state.calendarHistory.set(uid, messages);
  if (visible) rerender(state);
}

const calendarVisible = (state: State, uid: string) =>
  [...state.openGroup, ...state.relatedSent.map(({ message }) => message)].some((message) => message.calendarEvents.some((event) => event.uid === uid));

export function calendarCacheChanged(state: State, message: Message) {
  let changed = false;
  for (const { uid } of calendarEvents(message)) {
    const history = uid !== null && state.calendarHistory.get(uid);
    if (uid === null || !history || history.some((old) => Bun.deepEquals(old, message))) continue;
    state.calendarHistory.set(uid, [...history.filter((old) => old.messageId !== message.messageId), message]);
    changed = true;
  }
  if (changed) rerender(state);
}
