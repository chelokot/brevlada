import Gdk from "gi://Gdk?version=4.0";
import Gtk from "gi://Gtk?version=4.0";
import { COMPOSE_HEADROOM, COMPOSE_HEIGHT, COMPOSE_RESIZE_STEP, COMPOSE_SHRINK_SLACK, WINDOW_HEIGHT } from "../theme";
import { horizontal } from "./index";

export function automaticHeight(current: number, previous: number, content: number) {
  const target = Math.max(content + COMPOSE_HEADROOM, COMPOSE_HEIGHT);
  const grew = content > previous && content + COMPOSE_RESIZE_STEP > current;
  const shrank = content < previous && current - target >= COMPOSE_SHRINK_SLACK;
  return grew || shrank ? target : current;
}

export class Size {
  readonly stack = new Gtk.Stack({ vhomogeneous: false, vexpand: false, heightRequest: COMPOSE_HEIGHT });
  height = COMPOSE_HEIGHT;
  dragging = false;
  readonly #measured: [number | null, number | null] = [null, null];

  constructor() {
    const sizes = new WeakRef(this);
    this.stack.add_tick_callback(() => {
      const size = sizes.deref();
      size?.set(size.height);
      return size !== undefined;
    });
  }

  measure(mode: 0 | 1, contentHeight: number, edited: boolean) {
    const previous = this.#measured[mode];
    this.#measured[mode] = contentHeight;
    if (previous !== null && edited && !this.dragging) this.set(automaticHeight(this.height, previous, contentHeight));
  }

  maximum() {
    const scroll = this.stack.get_ancestor(Gtk.ScrolledWindow.$gtype);
    const height = scroll instanceof Gtk.ScrolledWindow ? scroll.get_height() : 0;
    return Math.max(height > 0 ? height : WINDOW_HEIGHT, COMPOSE_HEIGHT);
  }

  set(height: number) {
    const clamped = Math.min(Math.max(height, COMPOSE_HEIGHT), this.maximum());
    if (this.height === clamped) return;
    this.height = clamped;
    this.stack.heightRequest = clamped;
  }

  trackText(body: Gtk.TextView) {
    let edited = false;
    body.get_buffer().connect("end-user-action", () => (edited = true));
    const sizes = new WeakRef(this);
    body.add_tick_callback((body) => {
      const size = sizes.deref();
      if (!size) return false;
      if (body instanceof Gtk.TextView && body.get_mapped()) {
        const end = body.get_iter_location(body.get_buffer().get_end_iter());
        size.measure(0, end.y + end.height + body.get_top_margin() + body.get_bottom_margin(), edited);
        edited = false;
      }
      return true;
    });
  }

  handle() {
    const handle = horizontal("compose-resize-handle", 0);
    handle.set_focusable(true);
    handle.set_cursor_from_name("ns-resize");
    handle.set_tooltip_text("Drag to resize; use Up/Down when focused. New lines grow the field. Double-click to reset height.");
    const grip = horizontal("compose-resize-grip", 0);
    grip.set_halign(Gtk.Align.CENTER);
    grip.set_valign(Gtk.Align.CENTER);
    grip.set_hexpand(true);
    handle.append(grip);
    const drag = new Gtk.GestureDrag();
    let origin = { height: COMPOSE_HEIGHT, y: 0 };
    const pointer = (gesture: Gtk.Gesture) => {
      const event = gesture.get_current_event();
      const [ok, , y] = event ? event.get_position() : [false, 0, 0];
      return ok ? y : null;
    };
    drag.connect("drag-begin", (gesture) => {
      const y = pointer(gesture);
      if (y === null) return;
      origin = { height: this.height, y };
      this.dragging = true;
    });
    drag.connect("drag-update", (gesture) => {
      const y = pointer(gesture);
      if (this.dragging && y !== null) this.set(origin.height + Math.round(y - origin.y));
    });
    drag.connect("drag-end", () => (this.dragging = false));
    drag.connect("cancel", () => (this.dragging = false));
    handle.add_controller(drag);
    const click = new Gtk.GestureClick();
    click.connect("pressed", (_click, count: number) => {
      if (count === 2) this.set(COMPOSE_HEIGHT);
    });
    handle.add_controller(click);
    const keys = new Gtk.EventControllerKey();
    keys.connect("key-pressed", (_keys, key: number) => {
      const delta = key === Gdk.KEY_Up ? -COMPOSE_RESIZE_STEP : key === Gdk.KEY_Down ? COMPOSE_RESIZE_STEP : 0;
      if (delta === 0) return false;
      this.set(this.height + delta);
      return true;
    });
    handle.add_controller(keys);
    return handle;
  }
}
