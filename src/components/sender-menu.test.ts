import { expect, test } from "bun:test";
import Gdk from "gi://Gdk?version=4.0";
import Graphene from "gi://Graphene?version=1.0";
import Gtk from "gi://Gtk?version=4.0";
import Pango from "gi://Pango?version=1.0";
import { ALL, type SenderAction } from "../models/sender-action";
import { attach, attachView, container } from "./sender-menu";
import { descendants, settle, useDisplay } from "./testing";
import { create, replace, visibleRow } from "./virtual-list";

useDisplay();

const NO_FLAGS: number = 0;

const controllers = (widget: Gtk.Widget) => {
  const model = widget.observe_controllers();
  return Array.from({ length: model.get_n_items() }, (_, index) => model.get_item(index));
};

const press = (list: Gtk.Widget, row: Gtk.Widget) => {
  const [, point] = row.compute_point(list, new Graphene.Point().init(4, 4));
  const click = controllers(list).find((controller) => controller instanceof Gtk.GestureClick);
  return () => click?.emit("pressed", 1, point.x, point.y);
};

const menu = (host: Gtk.Box) => {
  const popover = host.get_last_child();
  if (!(popover instanceof Gtk.PopoverMenu)) throw new Error("Menu pops up from the container");
  return popover;
};

const actionButton = (popover: Gtk.PopoverMenu, title: string) => {
  const button = descendants(popover).find((widget) => {
    const label = widget instanceof Gtk.Button ? widget.get_child()?.get_first_child()?.get_next_sibling() : null;
    return label instanceof Gtk.Label && label.get_text() === title;
  });
  const content = button instanceof Gtk.Button ? button.get_child() : null;
  const icon = content?.get_first_child();
  const label = icon?.get_next_sibling();
  if (!(button instanceof Gtk.Button && content && icon instanceof Gtk.Image && label instanceof Gtk.Label)) throw new Error(`Menu has ${title}`);
  const hint = content.get_last_child();
  return { button, icon, label, shortcut: hint instanceof Gtk.Label && hint.has_css_class("mail-action-shortcut") ? hint.get_text() : null };
};

const menuShortcuts = (popover: Gtk.PopoverMenu) =>
  controllers(popover).find((controller) => controller instanceof Gtk.ShortcutController && controller.get_name() === "message-menu-shortcuts");

test("menu actions and dismissal preserve selection and scroll", async () => {
  const list = new Gtk.ListBox();
  for (let index = 0; index < 80; index++) list.append(Gtk.Label.new(`Sender ${index}`));
  const scroll = new Gtk.ScrolledWindow({ child: list });
  const host = container(scroll);
  const window = new Gtk.Window({ defaultWidth: 400, defaultHeight: 300, child: host });
  const activated: [string, SenderAction][] = [];
  let bulk = true;
  attach(
    list,
    scroll,
    (index) => [String(index), bulk],
    (sender, action) => activated.push([sender, action]),
    () => false,
    () => {},
  );
  window.present();
  await settle();
  list.unselect_all();
  list.get_row_at_index(0)?.grab_focus();
  list.unselect_all();
  const row = list.get_row_at_index(40);
  if (row === null) throw new Error("Row 40 exists");
  const [, point] = row.compute_point(list, new Graphene.Point().init(4, 4));
  const adjustment = scroll.get_vadjustment();
  adjustment.set_value(point.y - 30);
  await settle();
  const position = adjustment.get_value();
  expect(position).toBeGreaterThan(0);
  const open = press(list, row);
  const expectRestored = () => {
    expect(list.get_selected_row()).toBeNull();
    expect(adjustment.get_value()).toBe(position);
  };
  for (const [action, title] of ALL) {
    open();
    await settle();
    const popover = menu(host);
    const item = actionButton(popover, title);
    expect(item.label.get_pango_context().get_font_description()?.get_weight()).toBe(Pango.Weight.NORMAL);
    expect(item.icon.get_mapped()).toBe(true);
    expect(item.icon.get_width()).toBeGreaterThan(0);
    expect(menuShortcuts(popover)).toBeUndefined();
    if (action.kind === "MarkRead") expect(item.icon.get_icon_name()).toBe("brevlada-mail-read-symbolic");
    const name = item.icon.get_icon_name();
    if (name === null) throw new Error("Menu icons are named");
    const paintable = Gtk.IconTheme.get_for_display(item.icon.get_display()).lookup_icon(name, [], 16, 1, Gtk.TextDirection.LTR, Gtk.IconLookupFlags.NONE);
    expect(paintable.isSymbolic).toBe(true);
    expect(item.shortcut).toBeNull();
    item.button.emit("clicked");
    expect(activated.at(-1)).toEqual(["40", action]);
    await settle();
    expect(popover.get_parent()).toBeNull();
    expectRestored();
    expect(window.get_focus()).toBe(host);
  }
  open();
  await settle();
  menu(host).set_visible(false);
  await settle();
  expect(activated.length).toBe(ALL.length);
  expectRestored();
  bulk = false;
  const single: [SenderAction, string, string | null][] = [
    [{ kind: "MarkRead" }, "Mark as read", null],
    [{ kind: "Spam" }, "Mark as spam", null],
    [{ kind: "Archive" }, "Archive", "Backspace"],
    [{ kind: "Delete" }, "Delete", "Delete"],
  ];
  for (const [action, title, shortcut] of single) {
    open();
    await settle();
    const item = actionButton(menu(host), title);
    expect(item.shortcut).toBe(shortcut);
    item.button.emit("clicked");
    expect(activated.at(-1)).toEqual(["40", action]);
    await settle();
    expectRestored();
  }
  const keyed: [number, SenderAction][] = [
    [Gdk.KEY_BackSpace, { kind: "Archive" }],
    [Gdk.KEY_Delete, { kind: "Delete" }],
  ];
  for (const [key, action] of keyed) {
    open();
    await settle();
    const popover = menu(host);
    const shortcuts = menuShortcuts(popover);
    if (!(shortcuts instanceof Gtk.ShortcutController)) throw new Error("Single sender menus have shortcuts");
    const shortcut = Array.from({ length: shortcuts.get_n_items() }, (_, index) => shortcuts.get_item(index)).find((shortcut) => {
      const trigger = shortcut instanceof Gtk.Shortcut ? shortcut.get_trigger() : null;
      return trigger instanceof Gtk.KeyvalTrigger && trigger.get_keyval() === key;
    });
    if (!(shortcut instanceof Gtk.Shortcut)) throw new Error("Shortcut is registered");
    expect(shortcut.get_action()?.activate(NO_FLAGS, popover, null)).toBe(true);
    expect(activated.at(-1)).toEqual(["40", action]);
    await settle();
    expect(popover.get_visible()).toBe(false);
  }
  const keys = controllers(list).find((controller) => controller instanceof Gtk.EventControllerKey && controller.get_name() === "mail-row-shortcuts");
  if (!(keys instanceof Gtk.EventControllerKey)) throw new Error("Rows have keyboard shortcuts");
  const pressKey = (key: number, modifiers: Gdk.ModifierType): unknown => keys.emit("key-pressed", key, 0, modifiers);
  row.grab_focus();
  for (const [key, action] of [...keyed].reverse()) {
    expect(pressKey(key, 0)).toBe(true);
    expect(activated.at(-1)).toEqual(["40", action]);
  }
  bulk = true;
  const count = activated.length;
  for (const [key] of keyed) expect(pressKey(key, 0)).toBe(false);
  expect(activated.length).toBe(count);
  bulk = false;
  expect(pressKey(Gdk.KEY_Delete, Gdk.ModifierType.CONTROL_MASK)).toBe(false);
  const entry = new Gtk.Entry();
  host.append(entry);
  entry.grab_focus();
  expect(pressKey(Gdk.KEY_BackSpace, 0)).toBe(false);
  expect(activated.length).toBe(count);
  window.close();
}, 20_000);

test("virtual row context menu targets the clicked item", async () => {
  const list = create();
  const factory = new Gtk.SignalListItemFactory();
  factory.connect("bind", (_factory, item) => {
    if (!(item instanceof Gtk.ListItem)) return;
    const row = Gtk.Label.new(`Sender ${item.get_position()}`);
    row.set_name(`virtual-message-row-${item.get_position()}`);
    item.set_child(row);
  });
  list.set_factory(factory);
  replace(list, 20, null);
  const scroll = new Gtk.ScrolledWindow({ child: list, vexpand: true });
  const host = container(scroll);
  const window = new Gtk.Window({ defaultWidth: 400, defaultHeight: 300, child: host });
  const activated: [number, SenderAction][] = [];
  attachView(
    list,
    scroll,
    (index) => [index, true],
    (index, action) => activated.push([index, action]),
    () => false,
    () => {},
    () => ALL.map(([action]) => action),
  );
  window.present();
  await settle();
  const row = visibleRow(list, 3);
  if (row === null) throw new Error("Row 3 is visible");
  press(list, row)();
  await settle();
  actionButton(menu(host), "Archive all").button.emit("clicked");
  expect(activated).toEqual([[3, { kind: "Archive" }]]);
  window.close();
});
