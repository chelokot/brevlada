import Gio from "gi://Gio?version=2.0";
import GObject from "gi://GObject?version=2.0";
import Gtk from "gi://Gtk?version=4.0";
import type { Message } from "../models";
import { scroll as scrolled } from "./index";

export interface Row {
  key: string;
  messages: Message[];
}

const rows = new WeakMap<GObject.Object, Row>();

export function withItem<T>(list: Gtk.ListView, position: number, inspect: (row: Row) => T): T | null {
  const object = model(list).get_item(position);
  const row = object && rows.get(object);
  return row ? inspect(row) : null;
}

export const item = (list: Gtk.ListView, position: number) => withItem(list, position, (row) => row);

export function position(list: Gtk.ListView, key: string) {
  const count = model(list).get_n_items();
  for (let position = 0; position < count; position++) if (withItem(list, position, (row) => row.key === key)) return position;
  return null;
}

export const identify = (row: Gtk.Widget, key: string) => row.set_name(`virtual-message-row-${key}`);

export function groups(list: Gtk.ListView) {
  const store = model(list);
  return Array.from({ length: store.get_n_items() }, (_, position) => item(list, position)).flatMap((row) => (row ? [row.messages] : []));
}

export function create() {
  const selection = new Gtk.SingleSelection({ model: new Gio.ListStore({ itemType: GObject.Object.$gtype }), autoselect: false, canUnselect: true });
  return new Gtk.ListView({ model: selection, singleClickActivate: true, cssClasses: ["boxed-list", "message-list-view"] });
}

export function scroll(list: Gtk.ListView) {
  const scroll = scrolled(list);
  scroll.set_propagate_natural_height(true);
  scroll.set_valign(Gtk.Align.START);
  scroll.set_overflow(Gtk.Overflow.HIDDEN);
  scroll.add_css_class("message-list-surface");
  return scroll;
}

export function selection(list: Gtk.ListView) {
  const selection = list.get_model();
  if (!(selection instanceof Gtk.SingleSelection)) throw new Error("List view has single selection");
  return selection;
}

export function model(list: Gtk.ListView) {
  const store = selection(list).get_model();
  if (!(store instanceof Gio.ListStore)) throw new Error("Selection has a row store");
  return store;
}

export function selected(list: Gtk.ListView) {
  const position = selection(list).get_selected();
  return position === Gtk.INVALID_LIST_POSITION ? null : position;
}

export function focusSelected(list: Gtk.ListView) {
  const position = selected(list);
  if (position === null) return;
  list.grab_focus();
  list.scroll_to(position, Gtk.ListScrollFlags.FOCUS, null);
}

export function reveal(list: Gtk.ListView, position: number) {
  const key = withItem(list, position, (row) => row.key);
  selection(list).set_selected(position);
  list.scroll_to(position, Gtk.ListScrollFlags.SELECT, null);
  let laidOut = false;
  list.add_tick_callback((list) => {
    if (!laidOut) return (laidOut = true);
    if (list instanceof Gtk.ListView && selected(list) === position && withItem(list, position, (row) => row.key) === key) list.scroll_to(position, Gtk.ListScrollFlags.SELECT, null);
    return false;
  });
}

export function replace(list: Gtk.ListView, count: number, selected: number | null) {
  updateOwned(list, Array.from({ length: count }, (_, index) => ({ key: String(index), messages: [] })), [], selected);
}

export const update = (list: Gtk.ListView, rows: Row[], changed: number[], selected: number | null) => updateOwned(list, [...rows], changed, selected);

export function replaceItem(list: Gtk.ListView, position: number, row: Row) {
  const object = new GObject.Object();
  rows.set(object, row);
  model(list).splice(position, 1, [object]);
}

type Match = [old: number, next: number];

function longestIncreasing(matches: Match[]) {
  type Link = { match: Match; previous: Link | null };
  const tails: Link[] = [];
  for (const match of matches) {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (tails[middle]!.match[1] < match[1]) low = middle + 1;
      else high = middle;
    }
    tails[low] = { match, previous: tails[low - 1] ?? null };
  }
  const kept: Match[] = [];
  for (let link = tails.at(-1) ?? null; link; link = link.previous) kept.push(link.match);
  return kept.reverse();
}

export function updateOwned(list: Gtk.ListView, next: Row[], changed: number[], selectedPosition: number | null) {
  const root = list.get_root();
  const focus = root && root.get_focus();
  const restoreFocus = !!focus && (focus === list || focus.is_ancestor(list)) && !(focus instanceof Gtk.Popover) && focus.get_ancestor(Gtk.Popover.$gtype) === null;
  if (root && restoreFocus) Gtk.Root.prototype.set_focus.call(root, list);
  const store = model(list);
  const objects = Array.from({ length: store.get_n_items() }, (_, position) => store.get_item(position)!);
  const old = objects.map((object) => rows.get(object)!.key);
  const keys = next.map((row) => row.key);
  if (new Set(keys).size !== keys.length) throw new Error("List rows must have unique identities");
  const byKey = new Map(old.map((key, index) => [key, objects[index]]));
  const changedSet = new Set(changed);
  const additions = next.map((row, index) => {
    const object = (!changedSet.has(index) && byKey.get(row.key)) || new GObject.Object();
    rows.set(object, row);
    return object;
  });
  const positions = new Map(keys.map((key, index) => [key, index]));
  const kept = longestIncreasing(old.flatMap((key, index): Match[] => {
    const position = positions.get(key);
    return position === undefined ? [] : [[index, position]];
  }));
  const retained = new Set(kept.map(([, index]) => index));
  let previous: Match = [-1, -1];
  const gaps = [...kept, [old.length, keys.length] satisfies Match].map(([oldEnd, nextEnd]) => {
    const gap = { old: [previous[0] + 1, oldEnd], next: [previous[1] + 1, nextEnd] } as const;
    previous = [oldEnd, nextEnd];
    return gap;
  });
  const reversed = [...gaps.entries()].reverse();
  for (const [, { old: [start, end] }] of reversed) if (start !== end) store.splice(start, end - start, []);
  for (const [position, { next: [start, end] }] of reversed) if (start !== end) store.splice(position, 0, additions.slice(start, end));
  for (const index of changed) if (retained.has(index)) store.splice(index, 1, additions.slice(index, index + 1));
  selection(list).set_selected(selectedPosition !== null && selectedPosition < keys.length ? selectedPosition : Gtk.INVALID_LIST_POSITION);
  if (restoreFocus) focusSelected(list);
}

export function visibleRow(list: Gtk.ListView, position: number) {
  const row = item(list, position);
  if (!row) return null;
  const name = `virtual-message-row-${row.key}`;
  const find = (widget: Gtk.Widget): Gtk.Widget | null => {
    if (widget.get_name() === name) return widget;
    for (let child = widget.get_first_child(); child; child = child.get_next_sibling()) {
      const found = find(child);
      if (found) return found;
    }
    return null;
  };
  return find(list);
}
