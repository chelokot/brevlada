import Gio from "gi://Gio?version=2.0";
import GLib from "gi://GLib?version=2.0";
import Gtk from "gi://Gtk?version=4.0";
import Pango from "gi://Pango?version=1.0";
import type { Account, Message } from "../models";
import { renderedCalendar } from "../models/attachment";
import { ATTACHMENT_MAX_COLUMNS, ATTACHMENT_NAME_MAX_CHARS, ATTACHMENT_NAME_MIN_CHARS, ATTACHMENT_TILE_WIDTH, AVATAR_SIZE, SMALL_SPACING } from "../theme";
import { attach } from "./attachment-actions";
import { column, horizontal, label } from "./index";

export class FileCard {
  readonly widget = column("attachment-tile");
  readonly status: Gtk.Label;
  readonly actions = horizontal("attachment-actions", SMALL_SPACING);
  readonly #header = horizontal("attachment-tile-header", SMALL_SPACING);
  readonly #footer = horizontal("attachment-tile-footer", SMALL_SPACING);

  constructor(name: string, size: number | null) {
    const [contentType] = Gio.content_type_guess(name, null);
    this.widget.add_css_class("card");
    this.widget.widthRequest = ATTACHMENT_TILE_WIDTH;
    const icon = Gtk.Image.new_from_gicon(Gio.content_type_get_icon(contentType));
    icon.set_pixel_size(AVATAR_SIZE);
    const title = label(name, "heading");
    title.set_wrap(true);
    title.set_wrap_mode(Pango.WrapMode.WORD_CHAR);
    title.set_lines(2);
    title.set_width_chars(ATTACHMENT_NAME_MIN_CHARS);
    title.set_max_width_chars(ATTACHMENT_NAME_MAX_CHARS);
    title.set_halign(Gtk.Align.FILL);
    title.set_tooltip_text(name);
    this.#header.append(icon);
    this.#header.append(title);
    this.widget.append(this.#header);
    this.status = label(size === null ? Gio.content_type_get_description(contentType) : GLib.format_size(size), "dim-label");
    this.status.set_halign(Gtk.Align.FILL);
    this.status.set_max_width_chars(ATTACHMENT_NAME_MAX_CHARS);
    this.#footer.append(this.status);
    this.#footer.append(this.actions);
    this.widget.append(this.#footer);
  }

  openButton(name: string) {
    this.widget.remove(this.#header);
    this.widget.remove(this.#footer);
    this.#footer.remove(this.actions);
    this.widget.add_css_class("attachment-openable");
    const space = horizontal("attachment-action-space", 0);
    const sizes = new Gtk.SizeGroup({ mode: Gtk.SizeGroupMode.BOTH });
    sizes.add_widget(space);
    sizes.add_widget(this.actions);
    this.#footer.append(space);
    this.#footer.set_vexpand(true);
    this.#footer.set_valign(Gtk.Align.END);
    const content = column("attachment-open-content");
    content.append(this.#header);
    content.append(this.#footer);
    const button = new Gtk.Button({ child: content, tooltipText: `Open ${name}`, hexpand: true, vexpand: true, cssClasses: ["flat", "attachment-open"] });
    const overlay = new Gtk.Overlay();
    overlay.set_vexpand(true);
    overlay.set_child(button);
    const actions = horizontal("attachment-overlay-actions", 0);
    actions.set_halign(Gtk.Align.END);
    actions.set_valign(Gtk.Align.END);
    actions.append(this.actions);
    overlay.add_overlay(actions);
    this.widget.append(overlay);
    return button;
  }
}

export class Section {
  readonly widget = column("attachment-section");
  readonly expander: Gtk.Expander;
  readonly grid = grid();
  readonly #title = label("Attachments", "heading");
  readonly #summary = label("", "dim-label");

  constructor() {
    this.#summary.set_hexpand(false);
    const header = horizontal("attachment-heading", SMALL_SPACING);
    header.append(Gtk.Image.new_from_icon_name("mail-attachment-symbolic"));
    header.append(this.#title);
    header.append(this.#summary);
    this.expander = new Gtk.Expander({ labelWidget: header, child: this.grid, expanded: false, hexpand: true });
    this.widget.append(this.expander);
  }

  update(count: number, total: number | null) {
    this.widget.set_visible(count > 0);
    this.#title.set_text(`Attachments (${count})`);
    this.#summary.set_text(total === null ? "" : GLib.format_size(total));
  }

  append(card: FileCard) {
    this.grid.append(card.widget);
  }
}

export function grid() {
  return new Gtk.FlowBox({
    selectionMode: Gtk.SelectionMode.NONE,
    activateOnSingleClick: false,
    homogeneous: true,
    minChildrenPerLine: 1,
    maxChildrenPerLine: ATTACHMENT_MAX_COLUMNS,
    columnSpacing: SMALL_SPACING,
    rowSpacing: SMALL_SPACING,
    hexpand: true,
    cssClasses: ["attachment-grid"],
  });
}

export function view(message: Message, account: Account | null, folder: string) {
  const section = new Section();
  const visible = message.attachments.flatMap((name, index) =>
    renderedCalendar(message, index) ? [] : [{ name, index, size: message.attachmentDetails[index]?.size ?? null }],
  );
  section.update(visible.length, visible.reduce<number | null>((total, { size }) => (total === null || size === null ? null : total + size), 0));
  for (const { name, index, size } of visible) {
    const card = new FileCard(name, size);
    attach(card, name, account, folder, message, index);
    section.append(card);
  }
  return section.widget;
}

export const cancelled = (error: GLib.Error) =>
  error.matches(Gtk.DialogError, Gtk.DialogError.DISMISSED) || error.matches(Gtk.DialogError, Gtk.DialogError.CANCELLED);
