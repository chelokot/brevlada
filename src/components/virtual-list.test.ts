import { expect, test } from "bun:test";
import Gtk from "gi://Gtk?version=4.0";
import { message } from "../models";
import { key } from "../models/senders";
import { settle, useDisplay } from "./testing";
import { create, focusSelected, identify, item, model, replace, type Row, scroll, selected, update, visibleRow } from "./virtual-list";

useDisplay();

const rows = (keys: string[]): Row[] => keys.map((key) => ({ key, messages: [] }));
const keysOf = (list: Gtk.ListView) => Array.from({ length: model(list).get_n_items() }, (_, position) => item(list, position)?.key);

test("replacing the selected row keeps keyboard focus on it", async () => {
  const list = create();
  const factory = new Gtk.SignalListItemFactory();
  factory.connect("bind", (_factory, object) => {
    if (!(object instanceof Gtk.ListItem)) return;
    const data = item(list, object.get_position());
    if (!data) return;
    const label = new Gtk.Label({ label: data.key });
    identify(label, data.key);
    object.set_child(label);
  });
  list.set_factory(factory);
  const initial = rows(Array.from({ length: 10 }, (_, index) => String(index)));
  update(list, initial, [], 6);
  const reader = Gtk.Button.new_with_label("Reader control");
  const content = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
  content.append(scroll(list));
  content.append(reader);
  const window = new Gtk.Window({ defaultWidth: 300, defaultHeight: 400, child: content });
  const focused = () => {
    const row = visibleRow(list, 6)?.get_parent();
    const focus = window.get_focus();
    return !!row && !!focus && (focus === row || focus.is_ancestor(row));
  };
  window.present();
  await settle(100);
  list.scroll_to(6, Gtk.ListScrollFlags.FOCUS, null);
  await settle(100);
  expect(focused()).toBe(true);
  update(list, initial, [6], 6);
  await settle(100);
  expect(selected(list)).toBe(6);
  expect(focused()).toBe(true);
  const remaining = initial.filter((row) => row.key !== "6");
  update(list, remaining, [], 6);
  await settle(100);
  expect(focused()).toBe(true);
  reader.grab_focus();
  update(list, remaining, [6], 6);
  await settle(100);
  expect(window.get_focus()).toBe(reader);
  focusSelected(list);
  await settle(100);
  expect(focused()).toBe(true);
  window.close();
});

test("sorting, filtering and paging never publish duplicate or mismatched rows", () => {
  const list = create();
  model(list).connect("items-changed", () => {
    const seen = new Set<string>();
    for (let position = 0; position < model(list).get_n_items(); position++) {
      const row = item(list, position);
      expect(row && seen.has(row.key)).toBe(false);
      if (!row || !row.messages[0]) throw new Error("Rows carry their sender");
      seen.add(row.key);
      expect(row.key).toBe(key(row.messages[0]));
    }
  });
  const senders: Row[] = Array.from({ length: 100 }, (_, uid) => {
    const sender = `sender${uid}@example.com`;
    return { key: sender, messages: [message({ uid, sender })] };
  });
  update(list, senders, [], null);
  for (let offset = 0; offset < 100; offset++) {
    const rotated = [...senders.slice(offset), ...senders.slice(0, offset)];
    const next = (offset % 2 === 0 ? rotated.reverse() : rotated).filter((row) => (row.messages[0]?.uid ?? 0) % 3 !== offset % 3);
    update(list, next, [], null);
    expect(keysOf(list)).toEqual(next.map((row) => row.key));
  }
});

test("inserting between rows keeps existing model items", () => {
  const list = create();
  update(list, rows(["a", "b", "c", "d"]), [], null);
  const changes: number[][] = [];
  model(list).connect("items-changed", (_model, position, removed, added) => changes.push([position, removed, added]));
  update(list, rows(["a", "b", "new", "c", "d"]), [], null);
  expect(changes).toEqual([[2, 0, 1]]);
});

test("only visible rows are bound", async () => {
  const list = create();
  let binds = 0;
  const factory = new Gtk.SignalListItemFactory();
  factory.connect("bind", (_factory, object) => {
    binds++;
    if (object instanceof Gtk.ListItem) object.set_child(new Gtk.Label({ label: String(object.get_position()) }));
  });
  list.set_factory(factory);
  replace(list, 1000, null);
  const scrolled = new Gtk.ScrolledWindow({ child: list, minContentHeight: 300 });
  const window = new Gtk.Window({ defaultWidth: 300, defaultHeight: 300, child: scrolled });
  window.present();
  await settle(200);
  expect(binds).toBeGreaterThan(0);
  expect(binds).toBeLessThan(300);
  const adjustment = scrolled.get_vadjustment();
  adjustment.set_value(3000);
  await settle(100);
  const before = adjustment.get_value();
  update(list, rows(Array.from({ length: 1050 }, (_, index) => String(index))), [150], null);
  await settle(100);
  expect(Math.abs(adjustment.get_value() - before)).toBeLessThan(1);
  window.close();
});
