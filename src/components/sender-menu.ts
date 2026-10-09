import Gdk from "gi://Gdk?version=4.0";
import Gio from "gi://Gio?version=2.0";
import GLib from "gi://GLib?version=2.0";
import Graphene from "gi://Graphene?version=1.0";
import Gtk from "gi://Gtk?version=4.0";
import { ALL, icon, type SenderAction, title } from "../models/sender-action";
import * as mailShortcuts from "./mail-shortcuts";
import { action as menuAction } from "./menu-item";
import { position, selected, selection } from "./virtual-list";

type Lookup<T> = (index: number) => [sender: T, bulk: boolean] | null;
type Activate<T> = (sender: T, action: SenderAction) => void;

const ROW_PREFIX = "virtual-message-row-";

export function container(child: Gtk.Widget) {
  const host = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, focusable: true });
  host.append(child);
  return host;
}

const shortcut = <T>(senderAt: Lookup<T>, activate: Activate<T>) => (index: number, action: SenderAction) => {
  const found = senderAt(index);
  if (found === null || found[1]) return false;
  activate(found[0], action);
  return true;
};

export function attach<T>(
  list: Gtk.ListBox,
  scroll: Gtk.ScrolledWindow,
  senderAt: Lookup<T>,
  activate: Activate<T>,
  isTrusted: (sender: T) => boolean,
  toggleTrust: (sender: T) => void,
) {
  mailShortcuts.attach(list, shortcut(senderAt, activate));
  attachInner(
    list,
    scroll,
    senderAt,
    activate,
    isTrusted,
    toggleTrust,
    () => ALL.map(([action]) => action),
    (list, _x, y) => {
      const row = list.get_row_at_y(Math.trunc(y));
      return row === null ? null : row.get_index();
    },
    (list) => {
      const row = list.get_selected_row();
      return row === null ? null : row.get_index();
    },
    (list, index) => list.select_row(index === null ? null : list.get_row_at_index(index)),
  );
}

export function attachView<T>(
  list: Gtk.ListView,
  scroll: Gtk.ScrolledWindow,
  senderAt: Lookup<T>,
  activate: Activate<T>,
  isTrusted: (sender: T) => boolean,
  toggleTrust: (sender: T) => void,
  menuActions: (sender: T) => SenderAction[],
) {
  mailShortcuts.attachView(list, shortcut(senderAt, activate));
  attachInner(
    list,
    scroll,
    senderAt,
    activate,
    isTrusted,
    toggleTrust,
    menuActions,
    (list, x, y) => {
      for (let widget = list.pick(x, y, Gtk.PickFlags.DEFAULT); widget; widget = widget.get_parent()) {
        const name = widget.get_name();
        if (name.startsWith(ROW_PREFIX)) return position(list, name.slice(ROW_PREFIX.length));
      }
      return null;
    },
    (list) => selected(list),
    (list, index) => selection(list).set_selected(index === null ? Gtk.INVALID_LIST_POSITION : index),
  );
}

function attachInner<W extends Gtk.Widget, T>(
  list: W,
  scroll: Gtk.ScrolledWindow,
  senderAt: Lookup<T>,
  activate: Activate<T>,
  isTrusted: (sender: T) => boolean,
  toggleTrust: (sender: T) => void,
  menuActions: (sender: T) => SenderAction[],
  hit: (list: W, x: number, y: number) => number | null,
  selectedIndex: (list: W) => number | null,
  select: (list: W, index: number | null) => void,
) {
  const host = scroll.get_parent();
  if (host === null) throw new Error("Sender menu container");
  const click = new Gtk.GestureClick();
  click.set_button(Gdk.BUTTON_SECONDARY);
  click.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
  click.connect("pressed", (gesture, _count, x, y) => {
    const index = hit(list, x, y);
    if (index === null) return;
    const found = senderAt(index);
    if (found === null) return;
    const [sender, bulk] = found;
    gesture.set_state(Gtk.EventSequenceState.CLAIMED);
    const menu = new Gio.Menu();
    const actions = new Gio.SimpleActionGroup();
    const popover = Gtk.PopoverMenu.new_from_model(menu);
    popover.insert_action_group("sender", actions);
    const shortcuts = new Gtk.ShortcutController();
    shortcuts.set_name("message-menu-shortcuts");
    menuActions(sender).forEach((action, index) => {
      const name = `action${index}`;
      const entry = Gio.MenuItem.new(null, null);
      entry.set_attribute_value("custom", GLib.Variant.new_string(name));
      const key = bulk ? null : action.kind === "Archive" ? "BackSpace" : action.kind === "Delete" ? "Delete" : null;
      const item = Gio.SimpleAction.new(name, null);
      item.connect("activate", () => {
        popover.popdown();
        activate(sender, action);
      });
      actions.add_action(item);
      menu.append_item(entry);
      const detailedName = `sender.${name}`;
      popover.add_child(menuAction(title(action, bulk), icon(action), key === "BackSpace" ? "Backspace" : key, detailedName), name);
      if (key !== null) shortcuts.add_shortcut(Gtk.Shortcut.new(Gtk.ShortcutTrigger.parse_string(key), Gtk.NamedAction.new(detailedName)));
    });
    if (bulk) {
      const section = new Gio.Menu();
      const entry = Gio.MenuItem.new(null, null);
      entry.set_attribute_value("custom", GLib.Variant.new_string("trust"));
      section.append_item(entry);
      menu.append_section(null, section);
      const trusted = isTrusted(sender);
      const trust = Gio.SimpleAction.new("trust", null);
      trust.connect("activate", () => {
        popover.popdown();
        toggleTrust(sender);
      });
      actions.add_action(trust);
      const icon = trusted ? "changes-prevent-symbolic" : "changes-allow-symbolic";
      popover.add_child(menuAction(trusted ? "Don't trust" : "Trust", icon, null, "sender.trust"), "trust");
    } else popover.add_controller(shortcuts);
    popover.set_has_arrow(false);
    popover.add_css_class("mail-actions");
    const [inside, point] = list.compute_point(host, new Graphene.Point().init(x, y));
    if (!inside) return;
    popover.set_parent(host);
    popover.set_pointing_to(new Gdk.Rectangle({ x: Math.trunc(point.x), y: Math.trunc(point.y), width: 1, height: 1 }));
    const position = scroll.get_vadjustment().get_value();
    const previous = selectedIndex(list);
    popover.connect("closed", (popover) => {
      host.grab_focus();
      GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        popover.unparent();
        select(list, previous);
        scroll.get_vadjustment().set_value(position);
        return GLib.SOURCE_REMOVE;
      });
    });
    host.grab_focus();
    popover.popup();
  });
  list.add_controller(click);
}
