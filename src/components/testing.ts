import { afterAll, beforeAll, expect } from "bun:test";
import Adw from "gi://Adw?version=1";
import Gdk from "gi://Gdk?version=4.0";
import Gtk from "gi://Gtk?version=4.0";
import { startLoop, stopLoop } from "../gi/loop";
import { CSS } from "../theme";

let display: Gdk.Display | null = null;

function setup() {
  Gtk.init();
  Adw.init();
  const current = Gdk.Display.get_default();
  if (current === null) throw new Error("GTK tests need a display");
  Gtk.IconTheme.get_for_display(current).add_search_path(Bun.fileURLToPath(new URL("../../resources", import.meta.url)));
  const provider = new Gtk.CssProvider();
  const errors: string[] = [];
  provider.connect("parsing-error", (_provider, _section, error) => errors.push(error.message));
  provider.load_from_string(CSS);
  if (errors.length > 0) throw new Error(errors.join("\n"));
  Gtk.StyleContext.add_provider_for_display(current, provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
  return current;
}

export function useDisplay() {
  display ??= setup();
  beforeAll(startLoop);
  afterAll(stopLoop);
  return display;
}

export const settle = (milliseconds = 150) => Bun.sleep(milliseconds);

export async function until(predicate: () => boolean, timeout = 3000) {
  const deadline = performance.now() + timeout;
  while (!predicate() && performance.now() < deadline) await Bun.sleep(1);
  expect(predicate()).toBe(true);
}

export function descendants(widget: Gtk.Widget): Gtk.Widget[] {
  const found = [widget];
  for (let child = widget.get_first_child(); child; child = child.get_next_sibling()) found.push(...descendants(child));
  return found;
}

export const buttons = (widget: Gtk.Widget) => descendants(widget).filter((child) => child instanceof Gtk.Button);

export const labels = (widget: Gtk.Widget) => descendants(widget).flatMap((child) => (child instanceof Gtk.Label ? [child.get_text()] : []));

export function capture(variable: string, widget: Gtk.Widget, native: Gtk.Native) {
  const path = process.env[variable];
  if (path === undefined) return;
  const snapshot = new Gtk.Snapshot();
  new Gtk.WidgetPaintable({ widget }).snapshot(snapshot, widget.get_width(), widget.get_height());
  const node = snapshot.to_node();
  const renderer = native.get_renderer();
  if (node !== null && renderer !== null) renderer.render_texture(node, null).save_to_png(path);
}
