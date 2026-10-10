import { mkdirSync, writeFileSync } from "node:fs";
import GLib from "gi://GLib?version=2.0";
import Gtk from "gi://Gtk?version=4.0";
import { canReply, type Event, type Response, status, toIcal } from "../../models/calendar";
import { sameAscii } from "../../models/text";
import { SMALL_SPACING } from "../../theme";
import { actionButton, column, horizontal, label } from "../index";
import { open, openFile } from "../links";

const CHOICES: [title: string, icon: string, response: Response][] = [
  ["Yes", "object-select-symbolic", "Accepted"],
  ["Maybe", "dialog-question-symbolic", "Tentative"],
  ["No", "window-close-symbolic", "Declined"],
];

export function responses(event: Event, email: string, pending: boolean, respond: (response: Response) => void) {
  const current = event.attendees.find((attendee) => sameAscii(attendee.email, email));
  const replyable = canReply(event, email);
  if (!replyable && event.rsvp.length === 0) return null;
  const section = column("calendar-response");
  section.set_spacing(SMALL_SPACING);
  section.append(label("Your response:", "dim-label"));
  const row = horizontal("calendar-response-actions", SMALL_SPACING);
  if (replyable) {
    for (const [title, icon, response] of CHOICES) {
      const button = actionButton(icon, title);
      button.set_sensitive(!pending);
      button.set_tooltip_text(`Send RSVP to ${event.organizerEmail ?? ""}`);
      if (current !== undefined && current.status === status(response)) button.add_css_class("suggested-action");
      button.connect("clicked", () => respond(response));
      row.append(button);
    }
  } else {
    for (const action of event.rsvp) {
      const button = actionButton("web-browser-symbolic", action.label);
      button.set_tooltip_text("Respond on the organizer’s website");
      button.connect("clicked", () => open(action.url));
      row.append(button);
    }
  }
  section.append(new Gtk.ScrolledWindow({ child: row, hscrollbarPolicy: Gtk.PolicyType.AUTOMATIC, vscrollbarPolicy: Gtk.PolicyType.NEVER }));
  return section;
}

export function save(event: Event, error: Gtk.Label) {
  const button = actionButton("x-office-calendar-symbolic", "Save to Calendar");
  button.set_tooltip_text("Open this event in your default calendar app");
  button.connect("clicked", (clicked) => openCalendar(clicked, event, error));
  return button;
}

const serialized = ({ uid, recurrenceId, sequence, stamp, method, organizerEmail, attendees, name, start, end, timezone, location, organizer, description, url, status, rsvp, invitation, calendar }: Event) =>
  JSON.stringify({
    uid,
    recurrence_id: recurrenceId,
    sequence,
    stamp,
    method,
    organizer_email: organizerEmail,
    attendees: attendees.map(({ email, name, status }) => ({ email, name, status })),
    name,
    start,
    end,
    timezone,
    location,
    organizer,
    description,
    url,
    status,
    rsvp: rsvp.map(({ label, url }) => ({ label, url })),
    invitation,
    calendar,
  });

function openCalendar(button: Gtk.Button, event: Event, error: Gtk.Label) {
  const calendar = toIcal(event);
  if (calendar === null) {
    error.set_text("This event has an invalid date and cannot be saved.");
    error.set_visible(true);
    return;
  }
  const directory = `${GLib.get_user_cache_dir()}/brevlada/calendar`;
  const path = `${directory}/${new Bun.CryptoHasher("sha256").update(serialized(event)).digest("hex")}.ics`;
  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(path, calendar);
  } catch (failure) {
    error.set_text(`Unable to save event: ${failure instanceof Error ? failure.message : failure}`);
    error.set_visible(true);
    return;
  }
  error.set_visible(false);
  button.set_sensitive(false);
  const root = button.get_root();
  openFile(path, root instanceof Gtk.Window ? root : null, (result) => {
    button.set_sensitive(true);
    if (result.ok) return;
    error.set_text(`Unable to open calendar app: ${result.error}`);
    error.set_visible(true);
  });
}
