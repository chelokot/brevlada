import { expect, test } from "bun:test";
import Adw from "gi://Adw?version=1";
import Gio from "gi://Gio?version=2.0";
import GLib from "gi://GLib?version=2.0";
import Gtk from "gi://Gtk?version=4.0";
import { SettingsWindow } from "./settings";
import { descendants, useDisplay } from "./testing";

useDisplay();

const findRow = (widget: Gtk.Widget, title: string) =>
  descendants(widget).find((child): child is Adw.ActionRow => child instanceof Adw.ActionRow && child.get_title() === title);

test("background switch uses application actions", () => {
  const app = new Adw.Application({ applicationId: "io.github.ExposedCat.Brevlada.BackgroundDiagnostics", flags: Gio.ApplicationFlags.NON_UNIQUE });
  app.register(null);
  const action = Gio.SimpleAction.new_stateful("background", null, GLib.Variant.new_boolean(false));
  app.add_action(action);
  const parent = new Adw.ApplicationWindow({ application: app });
  const settings = new SettingsWindow(parent, false);
  const overview = settings.window.get_visible_page();
  if (!overview) throw new Error("Settings have an overview page");
  findRow(overview, "General")?.emit("activated");
  const row = findRow(settings.window, "Background service");
  if (!(row instanceof Adw.SwitchRow)) throw new Error("Background service is a switch");
  expect(row.get_active()).toBe(false);
  row.activate_action("app.background", null);
  expect(action.get_state()?.get_boolean()).toBe(true);
  expect(row.get_active()).toBe(true);
  action.set_state(GLib.Variant.new_boolean(false));
  expect(row.get_active()).toBe(false);
  action.set_enabled(false);
  expect(row.get_sensitive()).toBe(false);
  settings.window.destroy();
  parent.destroy();
});
