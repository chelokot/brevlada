import { expect, test } from "bun:test";
import Gdk from "gi://Gdk?version=4.0";
import Gtk from "gi://Gtk?version=4.0";
import { COMPOSE_HEIGHT, COMPOSE_RESIZE_STEP } from "../theme";
import { automaticHeight, Size } from "./editor-size";
import { settle, useDisplay, until } from "./testing";

useDisplay();

test("automatic sizing keeps headroom without chasing every line", () => {
  const cases: [current: number, previous: number, content: number, expected: number][] = [
    [200, 40, 64, 200],
    [200, 160, 184, 232],
    [232, 184, 208, 232],
    [500, 200, 224, 500],
    [500, 224, 200, 248],
    [248, 200, 176, 248],
    [400, 176, 40, 200],
  ];
  for (const [current, previous, content, expected] of cases) expect(automaticHeight(current, previous, content)).toBe(expected);
});

test("grows text and resizes both modes", async () => {
  const size = new Size();
  const text = new Gtk.TextView();
  size.trackText(text);
  size.stack.add_named(new Gtk.ScrolledWindow({ child: text }), "text");
  size.stack.add_named(new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL }), "html");
  const container = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
  container.append(size.stack);
  const handle = size.handle();
  container.append(handle);
  const window = new Gtk.Window({ child: new Gtk.ScrolledWindow({ child: container }), defaultHeight: 800, defaultWidth: 400 });
  window.present();
  await settle(100);
  expect(size.height).toBe(COMPOSE_HEIGHT);
  const type = async (lines: string) => {
    text.get_buffer().begin_user_action();
    text.get_buffer().insert_at_cursor(lines, -1);
    text.get_buffer().end_user_action();
    await settle(100);
  };
  await type("A line\n".repeat(100));
  await until(() => size.height === size.maximum());
  size.stack.set_visible_child_name("html");
  await settle(100);
  expect(size.stack.heightRequest).toBe(size.maximum());
  const controllers = handle.observe_controllers();
  const keys = Array.from({ length: controllers.get_n_items() }, (_, index) => controllers.get_item(index)).find((item) => item instanceof Gtk.EventControllerKey);
  if (!(keys instanceof Gtk.EventControllerKey)) throw new Error("The handle reacts to keys");
  for (let press = 0; press < 8; press++) expect(keys.emit("key-pressed", Gdk.KEY_Up, 0, 0) as unknown).toBe(true);
  const resized = size.maximum() - 8 * COMPOSE_RESIZE_STEP;
  expect(size.height).toBe(resized);
  size.stack.set_visible_child_name("text");
  await settle(100);
  expect(size.stack.heightRequest).toBe(resized);
  await type("One more line\n");
  expect(size.height).toBeGreaterThan(resized);
  const height = size.height;
  size.measure(1, 40, false);
  size.measure(1, 64, true);
  expect(size.height).toBe(height);
  size.dragging = true;
  size.measure(1, 88, true);
  expect(size.height).toBe(height);
  size.dragging = false;
  size.measure(1, 20, true);
  expect(size.height).toBe(COMPOSE_HEIGHT);
  window.destroy();
});
