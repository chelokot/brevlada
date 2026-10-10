import Gtk from "gi://Gtk?version=4.0";
import Pango from "gi://Pango?version=1.0";
import { SMALL_SPACING } from "../theme";
import { column, label } from "./index";

export function popup(anchor: Gtk.Widget, title: string, value: string) {
  const popover = new Gtk.Popover();
  popover.set_parent(anchor);
  const content = column("detail-popup");
  content.set_spacing(SMALL_SPACING);
  content.append(label(title, "title-4"));
  const text = label(value, "");
  text.set_wrap(true);
  text.set_ellipsize(Pango.EllipsizeMode.NONE);
  content.append(text);
  popover.set_child(content);
  popover.connect("closed", (popover) => popover.unparent());
  popover.popup();
}
