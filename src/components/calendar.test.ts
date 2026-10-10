import { expect, test } from "bun:test";
import Gtk from "gi://Gtk?version=4.0";
import { parseIcal, type Response } from "../models/calendar";
import { card } from "./calendar";
import { buttons, descendants, labels, useDisplay } from "./testing";

const display = useDisplay();

const INVITATION =
  "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:demo\r\nDTSTART:20261002T151500Z\r\nDTEND:20261002T160000Z\r\nSUMMARY:Demo\r\nLOCATION:Meeting\r\nORGANIZER:mailto:artem13.prokop@gmail.com\r\nATTENDEE;CN=Artem Prokop Dev;PARTSTAT=ACCEPTED:mailto:artem.prokop.dev@gmail.com\r\nATTENDEE;CN=Alex;PARTSTAT=TENTATIVE:mailto:alex@example.com\r\nATTENDEE;PARTSTAT=DECLINED:mailto:sam@example.com\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";

const title = (button: Gtk.Button) => {
  const label = button.get_child()?.get_last_child();
  return label instanceof Gtk.Label ? label.get_text() : null;
};

const unreachable = () => {
  throw new Error("No response expected");
};

test("attendee can RSVP but organizer sees attendance and save", () => {
  expect(Gtk.IconTheme.get_for_display(display).has_icon("location-services-active-symbolic")).toBe(true);
  const [event] = parseIcal(INVITATION);
  if (event === undefined) throw new Error("Invitation was not parsed");
  const received: Response[] = [];
  const attendee = card(event, "artem.prokop.dev@gmail.com", false, (response) => received.push(response));
  const actions = buttons(attendee);
  expect(actions.map(title)).toEqual(["Yes", "Maybe", "No", "Save to Calendar"]);
  expect(actions.every((button) => button.has_css_class("pill"))).toBe(true);
  const [yes] = actions;
  expect(yes?.has_css_class("suggested-action")).toBe(true);
  expect(yes?.get_parent()?.get_first_child()).toBe(yes);
  expect(actions[3]?.get_parent()).toBe(attendee);
  expect(labels(attendee)).toContain("Your response:");
  expect(labels(attendee)).not.toContain("RSVP");
  const organized = descendants(attendee).find((widget) => widget instanceof Gtk.Label && widget.get_text().startsWith("Organized by "));
  const response = organized?.get_next_sibling();
  expect(response?.has_css_class("calendar-response")).toBe(true);
  const heading = response?.get_first_child();
  expect(heading instanceof Gtk.Label && heading.get_text()).toBe("Your response:");
  expect(response?.get_last_child()).toBeInstanceOf(Gtk.ScrolledWindow);
  for (const action of actions.slice(0, 3)) action.emit("clicked");
  expect(received).toEqual(["Accepted", "Tentative", "Declined"]);
  const pending = card(event, "artem.prokop.dev@gmail.com", true, unreachable);
  expect(buttons(pending).slice(0, 3).some((button) => button.get_sensitive())).toBe(false);
  const organizer = card(event, "artem13.prokop@gmail.com", false, unreachable);
  expect(buttons(organizer).map(title)).toEqual(["Save to Calendar"]);
  expect(labels(organizer).some((text) => text.startsWith("Your response:"))).toBe(false);
});
