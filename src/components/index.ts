import Gtk from "gi://Gtk?version=4.0";
import Pango from "gi://Pango?version=1.0";
import { SMALL_SPACING } from "../theme";

export { messageRow, senderRow } from "./message-row";

function box(orientation: Gtk.Orientation, cssClass: string, spacing: number) {
  const widget = new Gtk.Box({ orientation, spacing });
  widget.add_css_class(cssClass);
  return widget;
}

export const column = (cssClass: string) => box(Gtk.Orientation.VERTICAL, cssClass, 0);

export const horizontal = (cssClass: string, spacing: number) => box(Gtk.Orientation.HORIZONTAL, cssClass, spacing);

export function label(text: string, cssClass: string) {
  const widget = new Gtk.Label({ label: text, xalign: 0, halign: Gtk.Align.START, hexpand: true, ellipsize: Pango.EllipsizeMode.END });
  if (cssClass) widget.add_css_class(cssClass);
  return widget;
}

export function errorLabel() {
  const widget = label("", "error");
  widget.set_halign(Gtk.Align.FILL);
  widget.set_ellipsize(Pango.EllipsizeMode.NONE);
  widget.set_wrap(true);
  widget.set_visible(false);
  return widget;
}

export function button(icon: string, tooltip: string) {
  const widget = new Gtk.Button({ iconName: icon, tooltipText: tooltip, hexpand: false, vexpand: false, halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER });
  widget.add_css_class("flat");
  return widget;
}

export function actionButton(icon: string, title: string) {
  const content = horizontal("action-button-content", SMALL_SPACING);
  content.append(Gtk.Image.new_from_icon_name(icon));
  const text = label(title, "");
  text.set_hexpand(false);
  content.append(text);
  return new Gtk.Button({ child: content, halign: Gtk.Align.START, cssClasses: ["pill"] });
}

export function scroll(child: Gtk.Widget) {
  return new Gtk.ScrolledWindow({ child, hexpand: true, vexpand: true, kineticScrolling: true, hscrollbarPolicy: Gtk.PolicyType.NEVER });
}

export function pane(left: Gtk.Widget, right: Gtk.Widget, position: number) {
  return new Gtk.Paned({
    orientation: Gtk.Orientation.HORIZONTAL,
    startChild: left,
    endChild: right,
    position,
    resizeStartChild: false,
    resizeEndChild: true,
    shrinkStartChild: false,
    shrinkEndChild: false,
    wideHandle: false,
  });
}

export function clear(container: Gtk.Box) {
  for (let child = container.get_first_child(); child; child = container.get_first_child()) container.remove(child);
}
