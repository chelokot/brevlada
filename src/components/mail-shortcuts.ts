import Gdk from "gi://Gdk?version=4.0";
import Gtk from "gi://Gtk?version=4.0";
import type { SenderAction } from "../models/sender-action";
import { selected } from "./virtual-list";

export function action(key: number, modifiers: Gdk.ModifierType): SenderAction | null {
  if (modifiers & Gtk.accelerator_get_default_mod_mask()) return null;
  if (key === Gdk.KEY_Delete || key === Gdk.KEY_KP_Delete) return { kind: "Delete" };
  return key === Gdk.KEY_BackSpace ? { kind: "Archive" } : null;
}

function shortcuts(name: string, choose: (action: SenderAction, controller: Gtk.EventControllerKey) => boolean) {
  const keys = new Gtk.EventControllerKey({ name });
  keys.connect("key-pressed", (controller, key: number, _code: number, modifiers: Gdk.ModifierType) => {
    const chosen = action(key, modifiers);
    return chosen !== null && choose(chosen, controller);
  });
  return keys;
}

export function attach(list: Gtk.ListBox, activate: (index: number, action: SenderAction) => boolean) {
  const lists = new WeakRef(list);
  const keys = shortcuts("mail-row-shortcuts", (action) => {
    const list = lists.deref();
    const root = list && list.get_root();
    const focus = root && root.get_focus();
    const row = focus instanceof Gtk.ListBoxRow ? focus : focus && focus.get_ancestor(Gtk.ListBoxRow.$gtype);
    return row instanceof Gtk.ListBoxRow && row.get_parent() === list && activate(row.get_index(), action);
  });
  list.add_controller(keys);
}

export function attachView(list: Gtk.ListView, activate: (index: number, action: SenderAction) => boolean) {
  const lists = new WeakRef(list);
  const keys = shortcuts("mail-row-shortcuts", (action) => {
    const list = lists.deref();
    const index = list ? selected(list) : null;
    return index !== null && activate(index, action);
  });
  list.add_controller(keys);
}

export function attachOpenMessage(window: Gtk.Widget, messageList: Gtk.Widget, compose: Gtk.Widget, activate: (action: SenderAction) => boolean) {
  const lists = new WeakRef(messageList);
  const composes = new WeakRef(compose);
  const keys = shortcuts("open-message-shortcuts", (action, controller) => {
    const list = lists.deref();
    const compose = composes.deref();
    const widget = controller.get_widget();
    const root = widget && widget.get_root();
    for (let widget = root && root.get_focus(); widget; widget = widget.get_parent()) {
      if (widget instanceof Gtk.Editable || widget instanceof Gtk.TextView || widget instanceof Gtk.Popover || widget === compose || widget === list) return false;
    }
    return activate(action);
  });
  keys.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
  window.add_controller(keys);
}
