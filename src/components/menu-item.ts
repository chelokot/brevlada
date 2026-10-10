import Gtk from "gi://Gtk?version=4.0";
import { SMALL_SPACING } from "../theme";
import { horizontal, label } from "./index";

export function action(title: string, icon: string, shortcut: string | null, name: string) {
  const content = horizontal("mail-action-content", SMALL_SPACING);
  content.append(Gtk.Image.new_from_icon_name(icon));
  content.append(label(title, "mail-action-title"));
  if (shortcut !== null) {
    const hint = label(shortcut, "mail-action-shortcut");
    hint.set_hexpand(false);
    hint.set_halign(Gtk.Align.END);
    content.append(hint);
  }
  const button = new Gtk.Button({ child: content, actionName: name, accessibleRole: Gtk.AccessibleRole.MENU_ITEM, cssClasses: ["flat", "mail-action"] });
  button.update_property([Gtk.AccessibleProperty.LABEL], [title]);
  return button;
}
