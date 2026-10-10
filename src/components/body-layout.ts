import type GLib from "gi://GLib?version=2.0";
import Gtk from "gi://Gtk?version=4.0";
import type JavaScriptCore from "gi://JavaScriptCore?version=6.0";
import WebKit from "gi://WebKit?version=6.0";
import { BODY_HEIGHT } from "../theme";
import layout from "./html_viewer/layout.js" with { type: "text" };
import quotes from "./html_viewer/quotes.js" with { type: "text" };
import textQuotes from "./html_viewer/text_quotes.js" with { type: "text" };
import { preserve } from "./scroll-position";

const WORLD = "brevlada-layout";
const SCRIPT = textQuotes + quotes + layout;

export function connect(view: WebKit.WebView, content: Gtk.ScrolledWindow, manager: WebKit.UserContentManager, ready: () => void) {
  manager.register_script_message_handler("bodySize", WORLD);
  manager.add_script(WebKit.UserScript.new_for_world(SCRIPT, WebKit.UserContentInjectedFrames.TOP_FRAME, WebKit.UserScriptInjectionTime.END, WORLD, null, null));
  const views = new WeakRef(view);
  const contents = new WeakRef(content);
  manager.connect("script-message-received::bodySize", (_manager: WebKit.UserContentManager, value: JavaScriptCore.Value) => {
    const view = views.deref();
    const content = contents.deref();
    if (!view || !content || !view.get_mapped() || view.get_width() <= 0 || value.object_get_property("width").to_int32() !== view.get_width()) return;
    const height = Math.max(value.object_get_property("height").to_int32(), BODY_HEIGHT);
    if (height !== view.heightRequest) {
      const resize = () => {
        view.heightRequest = height;
        content.heightRequest = height;
      };
      const scroll = content.get_ancestor(Gtk.ScrolledWindow.$gtype);
      const container = scroll instanceof Gtk.ScrolledWindow && scroll.get_child();
      if (scroll instanceof Gtk.ScrolledWindow && container) preserve(scroll, container, resize);
      else resize();
    }
    ready();
  });
}

export function observe(view: WebKit.WebView) {
  view.evaluate_javascript(SCRIPT, -1, WORLD, null, null).catch((error: GLib.Error) => console.error(`Could not measure message content: ${error.message}`));
}
