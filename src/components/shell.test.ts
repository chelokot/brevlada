import { expect, test } from "bun:test";
import Adw from "gi://Adw?version=1";
import Gio from "gi://Gio?version=2.0";
import Gtk from "gi://Gtk?version=4.0";
import { createShell, type Shell } from "./shell";
import { capture, settle, useDisplay } from "./testing";

useDisplay();

const shell = (id: string) => {
  const app = new Adw.Application({ applicationId: `org.example.Brevlada${id}Diagnostic`, flags: Gio.ApplicationFlags.NON_UNIQUE });
  app.register(null);
  return createShell(app);
};

const bounds = (widget: Gtk.Widget, target: Gtk.Widget) => {
  const [ok, rect] = widget.compute_bounds(target);
  if (!ok) throw new Error("Widget is laid out");
  return rect;
};

const searchBar = (entry: Gtk.SearchEntry) => {
  const bar = entry.get_ancestor(Gtk.SearchBar.$gtype);
  if (!(bar instanceof Gtk.SearchBar)) throw new Error("Search entries live in search bars");
  return bar;
};

test("search entries fill their panes and filters stay above sender search", async () => {
  const { window, accountSidebar, threadSidebar, search, threadSearch, searchFilters } = shell("Search");
  accountSidebar.setVisible(false);
  threadSidebar.setVisible(true);
  for (const entry of [search, threadSearch]) searchBar(entry).set_search_mode(true);
  window.present();
  await settle(400);
  for (const entry of [search, threadSearch]) expect(bounds(searchBar(entry), window).get_width() - bounds(entry, window).get_width()).toBeLessThanOrEqual(16);
  const filters = bounds(searchFilters.widget, window);
  expect(filters.get_y() + filters.get_height()).toBeLessThanOrEqual(bounds(search, window).get_y());
  capture("BREVLADA_SEARCH_SCREENSHOT", window, window);
  const pane = search.get_ancestor(Gtk.Paned.$gtype);
  if (!(pane instanceof Gtk.Paned)) throw new Error("Search sits in a pane");
  pane.set_position(550);
  await settle(400);
  expect(pane.get_position()).toBeGreaterThanOrEqual(550);
  expect(bounds(searchBar(search), window).get_width() - bounds(search, window).get_width()).toBeLessThanOrEqual(16);
  window.destroy();
});

test("empty state labels align", async () => {
  const { window, listStack, viewer } = shell("EmptyState");
  window.present();
  await settle(500);
  const list = listStack.get_child_by_name("state")?.get_last_child();
  const reader = viewer.get_first_child()?.get_last_child();
  if (!list || !reader) throw new Error("Both panes show an empty state");
  expect(Math.abs(bounds(list, window).get_y() - bounds(reader, window).get_y())).toBeLessThanOrEqual(1);
  window.destroy();
});

test("window transitions keep headers and input in sync", async () => {
  const existing = Gtk.Window.list_toplevels().length;
  const shown = shell("Window");
  const { window, refresh, sidebar } = shown;
  const pane = sidebar.get_ancestor(Gtk.Paned.$gtype);
  if (!(pane instanceof Gtk.Paned)) throw new Error("The sidebar sits in a pane");
  pane.set_position(1106);
  refresh.set_sensitive(true);
  const check = async (fullscreen: boolean, maximized: boolean, { window, refresh }: Shell) => {
    await settle(3000);
    expect([window.is_fullscreen(), window.is_maximized()]).toEqual([fullscreen, maximized]);
    const rect = bounds(refresh, window);
    expect(rect.get_x()).toBeGreaterThanOrEqual(0);
    expect(rect.get_y()).toBeGreaterThanOrEqual(0);
    expect(rect.get_x() + rect.get_width()).toBeLessThanOrEqual(window.get_width());
    expect(rect.get_y() + rect.get_height()).toBeLessThanOrEqual(window.get_height());
    const picked = window.pick(rect.get_x() + rect.get_width() / 2, rect.get_y() + rect.get_height() / 2, Gtk.PickFlags.DEFAULT);
    expect(picked === refresh || !!picked?.is_ancestor(refresh)).toBe(true);
    expect(Gtk.Window.list_toplevels()).toHaveLength(existing + 1);
  };
  window.present();
  await check(false, false, shown);
  for (let round = 0; round < 4; round++) {
    window.fullscreen();
    await check(true, false, shown);
    window.unfullscreen();
    await check(false, false, shown);
    window.maximize();
    await check(false, true, shown);
    window.unmaximize();
    await check(false, false, shown);
  }
  window.destroy();
}, 60_000);
