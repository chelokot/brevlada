import Gtk from "gi://Gtk?version=4.0";
import Pango from "gi://Pango?version=1.0";
import { dateLabel, type Event, type Response } from "../models/calendar";
import { SMALL_SPACING, SPACING } from "../theme";
import { responses, save } from "./calendar/actions";
import { column, horizontal, label } from "./index";

export { save } from "./calendar/actions";
export { rows as participants } from "./calendar/participants";

const STATUSES = new Map([
  ["EventCancelled", "Cancelled"],
  ["CANCELLED", "Cancelled"],
  ["EventPostponed", "Postponed"],
  ["EventRescheduled", "Rescheduled"],
  ["TENTATIVE", "Tentative"],
]);

export function withParticipants(card: Gtk.Box, participants: Gtk.Widget) {
  const event = column("calendar-event");
  event.append(card);
  event.append(participants);
  return event;
}

function detail(icon: string, text: string) {
  const row = horizontal("calendar-detail", SMALL_SPACING);
  row.append(Gtk.Image.new_from_icon_name(icon));
  const value = label(text, "");
  value.set_wrap(true);
  value.set_ellipsize(Pango.EllipsizeMode.NONE);
  row.append(value);
  return row;
}

export function card(event: Event, email: string, pending: boolean, respond: (response: Response) => void) {
  const card = column("calendar-card");
  card.set_spacing(SPACING);
  card.append(label(event.name, "title-2"));
  const date = dateLabel(event);
  if (date) card.append(detail("x-office-calendar-symbolic", date));
  if (event.location !== null) card.append(detail("location-services-active-symbolic", event.location));
  if (event.organizer !== null) card.append(label(`Organized by ${event.organizer}`, "dim-label"));
  const status = event.status === null ? undefined : STATUSES.get(event.status.slice(event.status.lastIndexOf("/") + 1));
  if (status !== undefined) card.append(label(status, "dim-label"));
  const error = label("", "error");
  error.set_wrap(true);
  error.set_ellipsize(Pango.EllipsizeMode.NONE);
  error.set_visible(false);
  const response = responses(event, email, pending, respond);
  if (response) card.append(response);
  card.append(save(event, error));
  card.append(error);
  return card;
}
