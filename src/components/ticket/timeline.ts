import Gtk from "gi://Gtk?version=4.0";
import Pango from "gi://Pango?version=1.0";
import { dateLabel, dayLabel, type Reservation, timeLabel } from "../../models/ticket";
import { ATTACHMENT_NAME_MIN_CHARS, SMALL_SPACING, SPACING } from "../../theme";
import { popup } from "../details";
import { column } from "../index";
import { text } from "../ticket";

function stop(title: string, date: string | null, location: string | null) {
  const label = text([date === null ? null : timeLabel(date), location].filter((part) => part !== null).join(" · "), "");
  label.set_wrap_mode(Pango.WrapMode.WORD_CHAR);
  label.set_width_chars(ATTACHMENT_NAME_MIN_CHARS);
  const button = new Gtk.Button({ child: label, hexpand: true, tooltipText: `Show ${title} location`, cssClasses: ["flat", "ticket-stop"] });
  const details = [date === null ? null : dateLabel(date), location].filter((part) => part !== null).join("\n");
  button.connect("clicked", (clicked) => popup(clicked, title, details));
  return button;
}

export function view({ start, end, departure, arrival }: Reservation) {
  const timeline = column("ticket-timeline");
  timeline.set_spacing(SPACING);
  const [first, last = first] = [start, end].filter((date) => date !== null).map((date) => dayLabel(date));
  if (first !== undefined) timeline.append(text(last === first ? first : `${first} – ${last}`, "dim-label"));
  const grid = new Gtk.Grid({ columnSpacing: SMALL_SPACING, cssClasses: ["ticket-destinations"] });
  const stops: [icon: string, stop: Gtk.Button][] = [];
  if (start !== null || departure !== null) stops.push(["user-home-symbolic", stop("Departure", start, departure)]);
  if (end !== null || arrival !== null) stops.push(["location-services-active-symbolic", stop("Arrival", end, arrival)]);
  stops.forEach(([icon, stop], index) => {
    const row = index * 2;
    if (index > 0) {
      const line = Gtk.Separator.new(Gtk.Orientation.VERTICAL);
      line.set_halign(Gtk.Align.CENTER);
      line.add_css_class("ticket-stop-line");
      grid.attach(line, 0, row - 1, 1, 1);
    }
    grid.attach(Gtk.Image.new_from_icon_name(icon), 0, row, 1, 1);
    grid.attach(stop, 1, row, 1, 1);
  });
  timeline.append(grid);
  return timeline;
}
