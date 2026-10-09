import { expect, test } from "bun:test";
import Gtk from "gi://Gtk?version=4.0";
import { ActiveRow } from "./active-row";
import { useDisplay } from "./testing";

useDisplay();

const classes = (...rows: Gtk.Widget[]) => rows.map((row) => row.get_css_classes().toSorted());

test("only the row whose key is active is marked open, keeping its own classes", () => {
  const active = new ActiveRow();
  const first = new Gtk.Box({ cssClasses: ["message-row"] });
  const second = new Gtk.Box({ cssClasses: ["message-row", "unread"] });
  active.bind(first, "a");
  active.bind(second, "b");
  expect(classes(first, second)).toEqual([["message-row"], ["message-row", "unread"]]);
  active.setKey("b");
  expect(classes(first, second)).toEqual([["message-row"], ["message-row", "message-row-open", "unread"]]);
  const rebound = new Gtk.Box({ cssClasses: ["message-row"] });
  active.bind(rebound, "b");
  expect(classes(rebound)).toEqual([["message-row", "message-row-open"]]);
  active.setKey(null);
  expect(classes(second, rebound)).toEqual([["message-row", "unread"], ["message-row"]]);
  expect(active.key).toBeNull();
});
