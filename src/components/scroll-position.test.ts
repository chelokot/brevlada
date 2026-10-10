import { expect, test } from "bun:test";
import Gtk from "gi://Gtk?version=4.0";
import { clear } from "./index";
import { preserve, preserveOffset } from "./scroll-position";
import { settle, useDisplay } from "./testing";

const display = useDisplay();

test("reordering rows does not scroll after layout", async () => {
  const list = new Gtk.ListBox();
  for (let index = 0; index < 30; index++) list.append(new Gtk.Label({ label: `Sender ${index}`, heightRequest: 40 }));
  const scroll = new Gtk.ScrolledWindow({ child: list });
  const window = new Gtk.Window({ defaultWidth: 300, defaultHeight: 200, child: scroll });
  window.present();
  await settle();
  for (const offset of [0, 200]) {
    scroll.get_vadjustment().set_value(offset);
    await settle();
    const row = Array.from({ length: 30 }, (_, index) => list.get_row_at_index(index)).find((row) => {
      const [ok, bounds] = row ? row.compute_bounds(scroll) : [false, null];
      return ok && bounds && bounds.get_y() + bounds.get_height() > 0;
    });
    if (!row) throw new Error("A row is visible");
    preserveOffset(scroll, () => {
      list.remove(row);
      list.append(row);
    });
    await settle();
    expect(Math.abs(scroll.get_vadjustment().get_value() - offset)).toBeLessThan(1);
  }
  window.close();
});

test("a widget below one that was never laid out does not anchor the viewport", async () => {
  const provider = new Gtk.CssProvider();
  provider.load_from_string(".padded { padding: 13px; }");
  Gtk.StyleContext.add_provider_for_display(display, provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
  const content = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
  content.append(new Gtk.Label({ label: "Previous conversation", heightRequest: 40 }));
  const scroll = new Gtk.ScrolledWindow({ child: content });
  const window = new Gtk.Window({ defaultWidth: 300, defaultHeight: 200, child: scroll });
  window.present();
  await settle();
  clear(content);
  const draft = new Gtk.Label({ label: "Draft", heightRequest: 300 });
  content.append(draft);
  content.append(new Gtk.Label({ label: "Event", heightRequest: 400, cssClasses: ["padded"] }));
  preserve(scroll, content, () => draft.set_label("Draft body"));
  await settle();
  expect(scroll.get_vadjustment().get_value()).toBe(0);
  Gtk.StyleContext.remove_provider_for_display(display, provider);
  window.close();
});
