import Gtk from "gi://Gtk?version=4.0";
import Pango from "gi://Pango?version=1.0";
import { calendarEvent, dateLabel, type Kind, type Reservation, statusLabel, webUrl } from "../models/ticket";
import { SMALL_SPACING, SPACING } from "../theme";
import { grid } from "./attachments";
import { save } from "./calendar";
import { actionButton, column, errorLabel, horizontal, label } from "./index";
import { open } from "./links";
import { card as passenger } from "./ticket/passenger";
import { view as timeline } from "./ticket/timeline";

const HEADERS: Record<Kind, [icon: string, title: string]> = {
  Bus: ["ticket-symbolic", "Bus tickets"],
  Train: ["ticket-symbolic", "Train tickets"],
  Flight: ["airplane-mode-symbolic", "Flight reservation"],
  Event: ["ticket-symbolic", "Event tickets"],
  Ticket: ["ticket-symbolic", "Tickets"],
};

const STATUS_CLASSES = new Map([
  ["Confirmed", "ticket-confirmed"],
  ["Cancelled", "ticket-cancelled"],
]);

export function text(value: string, cssClass: string) {
  const text = label(value, cssClass);
  text.set_halign(Gtk.Align.FILL);
  text.set_wrap(true);
  text.set_ellipsize(Pango.EllipsizeMode.NONE);
  return text;
}

function detail(icon: string, title: string, value: string) {
  const row = horizontal("ticket-detail", SMALL_SPACING);
  const image = Gtk.Image.new_from_icon_name(icon);
  image.set_valign(Gtk.Align.START);
  row.append(image);
  const content = column("ticket-detail-content");
  content.append(text(title, "dim-label"));
  content.append(text(value, ""));
  row.append(content);
  return row;
}

function link(url: string, title: string) {
  const button = actionButton("web-browser-symbolic", title);
  button.connect("clicked", () => open(url));
  return button;
}

export function card(reservation: Reservation) {
  const card = column("ticket-card");
  card.set_spacing(SPACING);
  const header = horizontal("ticket-header", SMALL_SPACING);
  const [icon, title] = HEADERS[reservation.kind];
  header.append(Gtk.Image.new_from_icon_name(icon));
  header.append(text(title, "dim-label"));
  const status = statusLabel(reservation);
  if (status !== null) {
    const badge = text(status, "ticket-status");
    badge.set_hexpand(false);
    badge.add_css_class(STATUS_CLASSES.get(status) ?? "ticket-pending");
    header.append(badge);
  }
  card.append(header);
  card.append(text(reservation.name, "title-2"));
  const booking = reservation.number === null ? null : `Booking ${reservation.number}`;
  const provider = [reservation.provider, reservation.service, booking].filter((part) => part !== null).join(" · ");
  if (provider) {
    const value = text(provider, "dim-label");
    value.set_selectable(true);
    card.append(value);
  }
  const { kind } = reservation;
  if (kind === "Bus" || kind === "Train" || kind === "Flight") card.append(timeline(reservation));
  if (kind === "Event" || kind === "Ticket") {
    if (reservation.start !== null) {
      const range = [dateLabel(reservation.start), ...(reservation.end === null ? [] : [dateLabel(reservation.end)])].join(" – ");
      card.append(detail("x-office-calendar-symbolic", "When", range));
    }
    if (reservation.location !== null) card.append(detail("location-services-active-symbolic", "Venue", reservation.location));
  }
  if (reservation.tickets.length > 0) {
    const people = grid();
    people.add_css_class("ticket-passengers");
    reservation.tickets.forEach((ticket, index) => people.append(passenger(ticket, reservation.holder, index)));
    card.append(people);
  } else if (reservation.holder !== null) card.append(detail("avatar-default-symbolic", "Passenger", reservation.holder));
  if (reservation.url !== null && webUrl(reservation.url)) card.append(link(reservation.url, "View Booking"));
  const event = calendarEvent(reservation);
  if (event !== null) {
    const error = errorLabel();
    card.append(save(event, error));
    card.append(error);
  }
  return card;
}
