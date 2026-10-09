import Gio from "gi://Gio?version=2.0";
import GLib from "gi://GLib?version=2.0";
import Gtk from "gi://Gtk?version=4.0";

export class SortMenu {
  readonly widget: Gtk.MenuButton;
  readonly #action = Gio.SimpleAction.new_stateful("unread-first", null, GLib.Variant.new_boolean(true));

  constructor() {
    this.#action.connect("activate", (action) => action.set_state(GLib.Variant.new_boolean(!action.get_state()!.get_boolean())));
    const actions = new Gio.SimpleActionGroup();
    actions.add_action(this.#action);
    const menu = new Gio.Menu();
    menu.append("Sort unread first", "sort.unread-first");
    this.widget = new Gtk.MenuButton({
      iconName: "open-menu-symbolic",
      tooltipText: "Sorting options",
      menuModel: menu,
      halign: Gtk.Align.CENTER,
      valign: Gtk.Align.CENTER,
      cssClasses: ["flat"],
    });
    this.widget.insert_action_group("sort", actions);
  }

  unreadFirst() {
    return this.#action.get_state()!.get_boolean();
  }

  setUnreadFirst(active: boolean) {
    this.#action.set_state(GLib.Variant.new_boolean(active));
  }

  connectChanged(changed: () => void) {
    this.#action.connect("notify::state", () => changed());
  }
}
