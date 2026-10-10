import Adw from "gi://Adw?version=1";
import type GLib from "gi://GLib?version=2.0";
import Gtk from "gi://Gtk?version=4.0";
import WebKit from "gi://WebKit?version=6.0";
import type { Message } from "../models";
import { BODY_HEIGHT } from "../theme";
import { connect, observe } from "./body-layout";
import { document as htmlDocument } from "./html";
import { open } from "./links";

export function view(message: Message, media: boolean, hideQuotes: boolean): [Gtk.Widget, WebKit.WebView] {
  const settings = new WebKit.Settings({ enableJavascript: true, enableJavascriptMarkup: false, enableHtml5LocalStorage: false, autoLoadImages: media });
  const manager = new WebKit.UserContentManager();
  const view = new WebKit.WebView({ userContentManager: manager, vexpand: false, settings, heightRequest: BODY_HEIGHT, hexpand: true });
  const content = new Gtk.ScrolledWindow({
    child: view,
    opacity: 0,
    hscrollbarPolicy: Gtk.PolicyType.NEVER,
    vscrollbarPolicy: Gtk.PolicyType.EXTERNAL,
    heightRequest: BODY_HEIGHT,
    vexpand: false,
  });
  const stack = new Gtk.Stack({ vexpand: false, heightRequest: BODY_HEIGHT, vhomogeneous: false });
  stack.add_named(loading(), "loading");
  stack.set_visible_child_name("loading");
  const overlay = new Gtk.Overlay({ child: content, vexpand: false });
  overlay.add_overlay(stack);
  overlay.set_measure_overlay(stack, true);
  const stacks = new WeakRef(stack);
  const contents = new WeakRef(content);
  const views = new WeakRef(view);
  connect(view, content, manager, () => {
    const stack = stacks.deref();
    const content = contents.deref();
    if (!stack || stack.get_visible_child_name() === "error" || !content) return;
    content.set_opacity(1);
    stack.set_visible(false);
  });
  view.connect("load-changed", (view, event: WebKit.LoadEvent) => {
    if (event === WebKit.LoadEvent.FINISHED) observe(view);
  });
  let document: string | null = null;
  const fail = (message: string) => {
    const stack = stacks.deref();
    if (!stack) return;
    contents.deref()?.set_opacity(0);
    const row = error(message, () => {
      const view = views.deref();
      const stack = stacks.deref();
      if (!view || !stack) return;
      stack.set_visible_child_name("loading");
      if (document !== null) view.load_html(document, "about:blank");
    });
    const previous = stack.get_child_by_name("error");
    if (previous) stack.remove(previous);
    stack.add_named(row, "error");
    stack.set_visible_child_name("error");
    stack.set_visible(true);
  };
  view.connect("load-failed", (_view, _event: WebKit.LoadEvent, _uri: string, failure: GLib.Error) => {
    fail(failure.message);
    return true;
  });
  view.connect("web-process-terminated", () => fail("The message renderer stopped"));
  view.connect("map", observe);
  view.connect("unrealize", (view) => view.stop_loading());
  view.connect("decide-policy", (_view, decision: WebKit.PolicyDecision, kind: WebKit.PolicyDecisionType) => {
    if (kind !== WebKit.PolicyDecisionType.NAVIGATION_ACTION && kind !== WebKit.PolicyDecisionType.NEW_WINDOW_ACTION) return false;
    if (!(decision instanceof WebKit.NavigationPolicyDecision)) return false;
    const action = decision.get_navigation_action();
    if (action.get_navigation_type() !== WebKit.NavigationType.LINK_CLICKED) return false;
    const uri = action.get_request().get_uri();
    if (uri.startsWith("https://") || uri.startsWith("http://") || uri.startsWith("mailto:")) open(uri);
    decision.ignore();
    return true;
  });
  queueMicrotask(() => {
    document = htmlDocument(message, hideQuotes, media);
    views.deref()?.load_html(document, "about:blank");
  });
  return [new Gtk.Frame({ vexpand: false, child: overlay, hexpand: true, cssClasses: ["html-viewer-frame"] }), view];
}

export function enableMedia(view: WebKit.WebView) {
  view.get_settings().set_auto_load_images(true);
  view
    .evaluate_javascript(
      "document.querySelectorAll('img').forEach(image => { for (const name of ['src', 'srcset']) { const source = image.getAttribute(name); if (source && /^(https?:|\\/\\/)/i.test(source.trim())) { image.removeAttribute(name); image.setAttribute(name, source); } } });",
      -1,
      null,
      null,
      null,
    )
    .catch((error: GLib.Error) => console.error(`Could not load message media: ${error.message}`));
}

export function loading() {
  const row = new Adw.ActionRow({ title: "Loading...", heightRequest: BODY_HEIGHT });
  row.add_prefix(new Gtk.Spinner({ spinning: true, widthRequest: 16, heightRequest: 16, valign: Gtk.Align.CENTER }));
  return row;
}

export function error(message: string, retry: () => void) {
  const row = new Adw.ActionRow({ title: "Unable to load message", subtitle: message, useMarkup: false, cssClasses: ["message-load-error"], heightRequest: BODY_HEIGHT });
  const button = new Gtk.Button({ label: "Retry", valign: Gtk.Align.CENTER });
  button.connect("clicked", () => retry());
  row.add_suffix(button);
  return row;
}
