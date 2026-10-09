import Gtk from "gi://Gtk?version=4.0";
import type JavaScriptCore from "gi://JavaScriptCore?version=6.0";
import type WebKit from "gi://WebKit?version=6.0";
import { type Editor, run, WORLD } from "./html-editor";
import { button, horizontal } from "./index";

const FORMATS = [
  ["format-text-bold-symbolic", "Bold (Ctrl+B)", "bold"],
  ["format-text-italic-symbolic", "Italic (Ctrl+I)", "italic"],
  ["format-text-underline-symbolic", "Underline (Ctrl+U)", "underline"],
  ["format-text-strikethrough-symbolic", "Strikethrough (Ctrl+Shift+X)", "strikeThrough"],
] as const;

function connect(button: Gtk.Button, view: WebKit.WebView, command: string) {
  const views = new WeakRef(view);
  button.connect("clicked", () => {
    const view = views.deref();
    if (!view) return;
    view.grab_focus();
    run(view, `applyFormat(${JSON.stringify(command)})`);
  });
}

export function toolbar(editor: Editor, mode: Gtk.ToggleButton) {
  const toolbar = horizontal("compose-formatting", 0);
  toolbar.add_css_class("linked");
  toolbar.set_visible(mode.get_active());
  const toggles = FORMATS.map(([icon, title, command]) => {
    const toggle = new Gtk.ToggleButton({ iconName: icon, tooltipText: title, focusOnClick: false });
    connect(toggle, editor.view, command);
    toolbar.append(toggle);
    return new WeakRef(toggle);
  });
  const clear = button("edit-clear-symbolic", "Clear formatting (Ctrl+\\)");
  clear.remove_css_class("flat");
  clear.set_focus_on_click(false);
  connect(clear, editor.view, "removeFormat");
  toolbar.append(clear);
  const manager = editor.view.get_user_content_manager();
  manager.register_script_message_handler("composeFormats", WORLD);
  manager.connect("script-message-received::composeFormats", (_manager: WebKit.UserContentManager, value: JavaScriptCore.Value) => {
    const active: boolean[] = JSON.parse(value.to_string());
    toggles.forEach((toggle, index) => toggle.deref()?.set_active(active[index] === true));
  });
  const toolbars = new WeakRef(toolbar);
  const views = new WeakRef(editor.view);
  mode.connect("toggled", (mode) => {
    toolbars.deref()?.set_visible(mode.get_active());
    const view = views.deref();
    if (mode.get_active() && view && !view.isLoading) run(view, "reportFormats()");
  });
  return toolbar;
}
