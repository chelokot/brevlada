import Gtk from "gi://Gtk?version=4.0";
import Pango from "gi://Pango?version=1.0";
import { type Ticket, webUrl } from "../../models/ticket";
import { ATTACHMENT_NAME_MAX_CHARS, ATTACHMENT_NAME_MIN_CHARS, ATTACHMENT_TILE_WIDTH, SMALL_SPACING } from "../../theme";
import { popup } from "../details";
import { button, column, horizontal } from "../index";
import { open } from "../links";
import { text } from "../ticket";

const CODE = /^(?:qrCode|barcode|aztecCode):(.+)$/s;

const wrapped = (value: string, cssClass: string) => {
  const label = text(value, cssClass);
  label.set_wrap_mode(Pango.WrapMode.WORD_CHAR);
  label.set_max_width_chars(ATTACHMENT_NAME_MAX_CHARS);
  return label;
};

export function card(ticket: Ticket, fallback: string | null, index: number) {
  const tile = column("ticket-passenger");
  tile.add_css_class("card");
  tile.widthRequest = ATTACHMENT_TILE_WIDTH;
  const content = column("ticket-tile-content");
  content.set_spacing(SMALL_SPACING);
  const holder = ticket.holder ?? fallback ?? `Ticket ${index + 1}`;
  const title = wrapped(holder, "heading");
  title.set_width_chars(ATTACHMENT_NAME_MIN_CHARS);
  const name = horizontal("ticket-passenger-name", SMALL_SPACING);
  const icon = Gtk.Image.new_from_icon_name("person-symbolic");
  icon.set_valign(Gtk.Align.START);
  name.append(icon);
  name.append(title);
  content.append(name);
  if (ticket.seat !== null) content.append(wrapped(ticket.seat, ""));
  const footer = horizontal("ticket-tile-footer", SMALL_SPACING);
  footer.set_vexpand(true);
  footer.set_valign(Gtk.Align.END);
  const actions = horizontal("ticket-copy-actions", 0);
  if (ticket.number !== null) {
    const number = ticket.number;
    footer.append(wrapped(number, "dim-label"));
    const copy = button("edit-copy-symbolic", "Copy ticket ID");
    copy.connect("clicked", (clicked) => clicked.get_clipboard().set(number));
    actions.append(copy);
  }
  const space = horizontal("ticket-copy-space", 0);
  const sizes = new Gtk.SizeGroup({ mode: Gtk.SizeGroupMode.BOTH });
  sizes.add_widget(space);
  sizes.add_widget(actions);
  footer.append(space);
  content.append(footer);
  const token = ticket.token;
  const url = token !== null && webUrl(token) ? token : null;
  const code = token === null ? null : (CODE.exec(token)?.[1] ?? null);
  const tooltip = url !== null ? `Open ticket for ${holder}` : code !== null ? `Copy ticket code for ${holder}` : `Ticket details for ${holder}`;
  const opener = new Gtk.Button({ child: content, tooltipText: tooltip, hexpand: true, vexpand: true, cssClasses: ["flat", "ticket-open", "attachment-open"] });
  if (url !== null) opener.connect("clicked", () => open(url));
  else if (code !== null) opener.connect("clicked", (clicked) => clicked.get_clipboard().set(code));
  else {
    const details = [holder, ticket.seat, ticket.number].filter((part) => part !== null).join("\n");
    opener.connect("clicked", (clicked) => popup(clicked, "Ticket", details));
  }
  const overlay = new Gtk.Overlay();
  overlay.set_child(opener);
  const controls = horizontal("attachment-overlay-actions", 0);
  controls.set_halign(Gtk.Align.END);
  controls.set_valign(Gtk.Align.END);
  controls.append(actions);
  overlay.add_overlay(controls);
  tile.append(overlay);
  return tile;
}
