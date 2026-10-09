import Adw from "gi://Adw?version=1";
import Gtk from "gi://Gtk?version=4.0";
import { type Participant, responseLabel } from "../../models/calendar";
import { CALENDAR_AVATAR_SIZE, SMALL_SPACING } from "../../theme";
import type { Avatars } from "../avatars";
import { column, horizontal, label } from "../index";

function line(orientation: Gtk.Orientation, cssClass: string) {
  const line = Gtk.Separator.new(orientation);
  line.add_css_class(cssClass);
  return line;
}

function header(person: Participant, avatars: Avatars) {
  const row = horizontal("calendar-participant-header", SMALL_SPACING);
  const { attendee } = person;
  const title = attendee.name ?? attendee.email;
  const avatar = Adw.Avatar.new(CALENDAR_AVATAR_SIZE, title, true);
  avatar.set_valign(Gtk.Align.CENTER);
  avatars.attach(avatar, attendee.email);
  row.append(avatar);
  const name = label(title, "calendar-participant-name");
  name.set_hexpand(false);
  name.set_tooltip_text(attendee.email);
  if (person.unread) name.add_css_class("heading");
  row.append(name);
  const separator = label("·", "dim-label");
  separator.set_hexpand(false);
  row.append(separator);
  const status = label(responseLabel(person), "dim-label");
  status.set_hexpand(false);
  status.set_halign(Gtk.Align.START);
  row.append(status);
  return row;
}

export function rows(people: Participant[], avatars: Avatars) {
  const tree = column("calendar-participants");
  people.forEach((person, index) => {
    const branch = new Gtk.Grid();
    branch.add_css_class("calendar-participant");
    const connector = column("calendar-branch");
    connector.append(line(Gtk.Orientation.VERTICAL, "calendar-branch-top"));
    if (index + 1 < people.length) {
      const stem = line(Gtk.Orientation.VERTICAL, "calendar-branch-stem");
      stem.set_vexpand(true);
      connector.append(stem);
    } else connector.set_valign(Gtk.Align.START);
    branch.attach(connector, 0, 0, 1, 1);
    const twig = line(Gtk.Orientation.HORIZONTAL, "calendar-branch-twig");
    twig.set_valign(Gtk.Align.START);
    branch.attach(twig, 1, 0, 1, 1);
    branch.attach(header(person, avatars), 2, 0, 1, 1);
    tree.append(branch);
  });
  return tree;
}
