import { expect, test } from "bun:test";
import Gdk from "gi://Gdk?version=4.0";
import Gtk from "gi://Gtk?version=4.0";
import { attachOpenMessage } from "./mail-shortcuts";
import { useDisplay } from "./testing";

useDisplay();

test("open message shortcuts respect editors and row handlers", () => {
  const content = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
  const list = new Gtk.ListBox();
  list.append(new Gtk.Label({ label: "Message" }));
  const reader = Gtk.Button.new_with_label("Reader control");
  const entry = new Gtk.Entry();
  const text = new Gtk.TextView();
  const compose = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
  const draftControl = Gtk.Button.new_with_label("Draft control");
  compose.append(draftControl);
  for (const widget of [list, reader, entry, text, compose]) content.append(widget);
  const window = new Gtk.Window({ child: content });
  let called = 0;
  attachOpenMessage(window, list, compose, () => {
    called++;
    return true;
  });
  const controllers = window.observe_controllers();
  const keys = Array.from({ length: controllers.get_n_items() }, (_, index) => controllers.get_item(index)).find(
    (controller): controller is Gtk.EventControllerKey => controller instanceof Gtk.EventControllerKey && controller.get_name() === "open-message-shortcuts",
  );
  if (!keys) throw new Error("Shortcuts are attached to the window");
  const press = (key: number, modifiers: Gdk.ModifierType): unknown => keys.emit("key-pressed", key, 0, modifiers);
  for (const key of [Gdk.KEY_Delete, Gdk.KEY_BackSpace, Gdk.KEY_KP_Delete]) {
    reader.grab_focus();
    expect(press(key, 0)).toBe(true);
    expect(press(key, Gdk.ModifierType.CONTROL_MASK)).toBe(false);
    for (const widget of [entry, text, draftControl, list.get_row_at_index(0)]) {
      widget?.grab_focus();
      expect(press(key, 0)).toBe(false);
    }
  }
  expect(called).toBe(3);
  window.destroy();
});
