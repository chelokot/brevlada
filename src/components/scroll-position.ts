import type Gtk from "gi://Gtk?version=4.0";

interface Anchor {
  widget: WeakRef<Gtk.Widget>;
  y: number;
}

export const preserve = (scroll: Gtk.ScrolledWindow, container: Gtk.Widget, change: () => void) => preserveInner(scroll, container.get_first_child(), change);

export const preserveOffset = (scroll: Gtk.ScrolledWindow, change: () => void) => preserveInner(scroll, null, change);

function top(widget: Gtk.Widget | null, scroll: Gtk.Widget) {
  const [ok, bounds] = widget ? widget.compute_bounds(scroll) : [false, null];
  return ok && bounds ? bounds : null;
}

function preserveInner(scroll: Gtk.ScrolledWindow, first: Gtk.Widget | null, change: () => void) {
  const adjustment = scroll.get_vadjustment();
  const value = adjustment.get_value();
  let anchor: Anchor | null = null;
  for (let widget = first; widget && !anchor; widget = widget.get_next_sibling()) {
    const bounds = top(widget, scroll);
    if (bounds && bounds.get_y() + bounds.get_height() > 0) anchor = { widget: new WeakRef(widget), y: bounds.get_y() };
  }
  change();
  let laidOut = false;
  scroll.add_tick_callback((scroll) => {
    if (!laidOut) return (laidOut = true);
    if (Math.abs(adjustment.get_value() - value) < 1) {
      const bounds = anchor && top(anchor.widget.deref() ?? null, scroll);
      const delta = anchor && bounds ? bounds.get_y() - anchor.y : 0;
      const upper = Math.max(adjustment.get_upper() - adjustment.get_page_size(), adjustment.get_lower());
      adjustment.set_value(Math.min(Math.max(value + delta, adjustment.get_lower()), upper));
    }
    return false;
  });
}
