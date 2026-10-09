import { expect, test } from "bun:test";
import Gtk from "gi://Gtk?version=4.0";
import { preserveOffset } from "./scroll-position";
import { settle, useDisplay } from "./testing";

useDisplay();

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
