import Adw from "gi://Adw?version=1";
import Gtk from "gi://Gtk?version=4.0";
import { pane } from "./index";

export class Sidebar {
  readonly pane: Gtk.Paned;
  readonly #clip: Gtk.ScrolledWindow;
  readonly #content: Gtk.Box;
  #visible: boolean;
  #width: number;
  #animating = false;
  #animation: Adw.TimedAnimation | null = null;
  readonly #handlers: ((sidebar: Sidebar) => void)[] = [];

  constructor(content: Gtk.Box, end: Gtk.Widget, width: number, visible: boolean) {
    this.#clip = new Gtk.ScrolledWindow({ hscrollbarPolicy: Gtk.PolicyType.NEVER, vscrollbarPolicy: Gtk.PolicyType.NEVER, child: content, visible });
    this.pane = pane(this.#clip, end, width);
    this.#content = content;
    this.#visible = visible;
    this.#width = width;
  }

  getVisible() {
    return this.#visible;
  }

  width() {
    return this.#visible && !this.#animating ? Math.max(this.pane.get_position(), 1) : this.#width;
  }

  restoreWidth(width: number) {
    this.#width = Math.max(width, 1);
    this.pane.set_position(Math.max(width, 1));
  }

  connectVisibleNotify(handler: (sidebar: Sidebar) => void) {
    this.#handlers.push(handler);
  }

  setVisible(visible: boolean) {
    if (visible === this.#visible) return;
    const width = this.width();
    this.#width = width;
    const from = this.#clip.get_visible() ? this.pane.get_position() : 0;
    this.#animation?.pause();
    this.#visible = visible;
    this.#animating = true;
    this.#content.widthRequest = width;
    this.#clip.hscrollbarPolicy = Gtk.PolicyType.EXTERNAL;
    this.pane.set_shrink_start_child(true);
    this.#clip.set_visible(true);
    this.pane.set_position(from);
    const self = new WeakRef(this);
    const target = Adw.CallbackAnimationTarget.new((value) => self.deref()?.pane.set_position(Math.round(value)));
    const animation = Adw.TimedAnimation.new(this.pane, from, visible ? width : 0, 200, target);
    animation.set_easing(Adw.Easing.EASE_OUT_CUBIC);
    animation.connect("done", () => this.#finish());
    this.#animation = animation;
    animation.play();
    for (const handler of this.#handlers) handler(this);
  }

  #finish() {
    this.#clip.set_visible(this.#visible);
    this.#content.widthRequest = -1;
    this.#clip.hscrollbarPolicy = Gtk.PolicyType.NEVER;
    this.pane.set_shrink_start_child(false);
    this.pane.set_position(this.#width);
    this.#animating = false;
  }
}
