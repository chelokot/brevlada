import Gdk from "gi://Gdk?version=4.0";
import type GLib from "gi://GLib?version=2.0";
import Gtk from "gi://Gtk?version=4.0";
import type JavaScriptCore from "gi://JavaScriptCore?version=6.0";
import WebKit from "gi://WebKit?version=6.0";
import { COMPOSE_HEIGHT } from "../theme";
import editorScript from "./html_editor/editor.js" with { type: "text" };
import formattingScript from "./html_editor/formatting.js" with { type: "text" };
import quoteStyle from "./html_editor/quote.css" with { type: "text" };
import style from "./html_editor/style.css" with { type: "text" };

export { toolbar } from "./html-formatting";

export const WORLD = "brevlada-compose";

interface Content {
  html: string;
  quote?: string;
  forwardHeader?: string;
}

const SHORTCUTS = new Map([
  [Gdk.KEY_a, "selectAllContent()"],
  [Gdk.KEY_b, "applyFormat('bold')"],
  [Gdk.KEY_i, "applyFormat('italic')"],
  [Gdk.KEY_u, "applyFormat('underline')"],
  [Gdk.KEY_backslash, "applyFormat('removeFormat')"],
]);

export function run(view: WebKit.WebView, script: string) {
  view.evaluate_javascript(script, -1, WORLD, null, null).catch((error: GLib.Error) => console.warn(`HTML editor: ${error.message}`));
}

const setContent = (view: WebKit.WebView, content: Content) => run(view, `setContent(${JSON.stringify(content)})`);

export class Editor {
  readonly view: WebKit.WebView;
  #pending: Content = { html: "" };
  #ready = false;

  constructor(buffer: Gtk.TextBuffer, mode: Gtk.ToggleButton, heightChanged: (height: number, edited: boolean) => void) {
    const manager = new WebKit.UserContentManager();
    const settings = new WebKit.Settings({ enableJavascript: true, enableJavascriptMarkup: false, enableHtml5LocalStorage: false });
    this.view = new WebKit.WebView({ settings, userContentManager: manager, heightRequest: COMPOSE_HEIGHT, vexpand: false, hexpand: true });
    this.view.set_background_color(new Gdk.RGBA({ red: 0, green: 0, blue: 0, alpha: 0 }));
    manager.register_script_message_handler("composeHeight", WORLD);
    manager.connect("script-message-received::composeHeight", (_manager: WebKit.UserContentManager, value: JavaScriptCore.Value) => {
      const [height, edited]: [number, boolean] = JSON.parse(value.to_string());
      heightChanged(height, edited);
    });
    const views = new WeakRef(this.view);
    const keys = new Gtk.EventControllerKey({ name: "compose-html-shortcuts", propagationPhase: Gtk.PropagationPhase.CAPTURE });
    keys.connect("key-pressed", (_keys, keyval: number, _code: number, state: Gdk.ModifierType) => {
      const modifiers = state & Gtk.accelerator_get_default_mod_mask();
      const control = Gdk.ModifierType.CONTROL_MASK;
      const key = Gdk.keyval_to_lower(keyval);
      const script =
        modifiers === control ? SHORTCUTS.get(key) : modifiers === (control | Gdk.ModifierType.SHIFT_MASK) && key === Gdk.KEY_x ? "applyFormat('strikeThrough')" : undefined;
      if (script === undefined) return false;
      const view = views.deref();
      if (view) run(view, script);
      return true;
    });
    this.view.add_controller(keys);
    manager.register_script_message_handler("composeText", WORLD);
    const buffers = new WeakRef(buffer);
    const modes = new WeakRef(mode);
    manager.connect("script-message-received::composeText", (_manager: WebKit.UserContentManager, value: JavaScriptCore.Value) => {
      const buffer = buffers.deref();
      if (modes.deref()?.get_active() && buffer) buffer.set_text(value.to_string(), -1);
    });
    this.view.connect("load-changed", (view, event: WebKit.LoadEvent) => {
      if (event !== WebKit.LoadEvent.FINISHED) return;
      this.#ready = true;
      run(view, `const quoteStyle = ${JSON.stringify(quoteStyle)};\n${editorScript}\n${formattingScript}`);
      setContent(view, this.#pending);
    });
    this.view.connect("decide-policy", (_view, decision: WebKit.PolicyDecision, kind: WebKit.PolicyDecisionType) => {
      if (kind !== WebKit.PolicyDecisionType.NAVIGATION_ACTION && kind !== WebKit.PolicyDecisionType.NEW_WINDOW_ACTION) return false;
      if (!(decision instanceof WebKit.NavigationPolicyDecision) || decision.get_navigation_action().get_navigation_type() === WebKit.NavigationType.OTHER) return false;
      decision.ignore();
      return true;
    });
    this.view.load_html(
      `<!doctype html><html><head><meta charset='utf-8'><meta http-equiv='Content-Security-Policy' content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-src 'self';"><style>:root { --compose-min-height: ${COMPOSE_HEIGHT}px; }${style}</style></head><body contenteditable='true' aria-label='Message body'></body></html>`,
      "about:blank",
    );
  }

  get ready() {
    return this.#ready;
  }

  setHtml(html: string) {
    this.#setContent({ html });
  }

  reply(html: string) {
    this.#setContent({ html: "<div><br></div><div><br></div>", quote: html });
  }

  forward(header: string, html: string) {
    this.#setContent({ forwardHeader: header, html: "<div><br></div><div><br></div>", quote: html });
  }

  #setContent(content: Content) {
    this.#pending = content;
    if (this.#ready) setContent(this.view, content);
  }

  focus() {
    this.view.grab_focus();
    if (this.#ready) run(this.view, "document.body.focus({preventScroll: true})");
  }

  async message(): Promise<[html: string, text: string]> {
    for (let attempt = 0; attempt < 250 && !this.#ready; attempt++) await Bun.sleep(20);
    if (!this.#ready) throw new Error("Formatted editor is still loading");
    const value = await this.view.evaluate_javascript("JSON.stringify([getMessageHtml(), getMessageText()])", -1, WORLD, null, null);
    return JSON.parse(value.to_string());
  }
}
