import Adw from "gi://Adw?version=1";
import Graphene from "gi://Graphene?version=1.0";
import Gtk from "gi://Gtk?version=4.0";
import { defineClass } from "../gi";

const Base = defineClass("BrevladaReveal", Gtk.Widget, {
  snapshot(snapshot: Gtk.Snapshot) {
    const child = this.get_first_child();
    if (!(this instanceof Reveal) || !child) return;
    snapshot.push_clip(new Graphene.Rect().init(0, 0, this.get_width(), this.get_height() * this.progress));
    this.snapshot_child(child, snapshot);
    snapshot.pop();
  },
});

export class Reveal extends Base {
  progress = 1;
  readonly #animation: Adw.TimedAnimation;

  constructor(child: Gtk.Widget) {
    super({ layoutManager: new Gtk.BinLayout(), hexpand: child.compute_expand(Gtk.Orientation.HORIZONTAL), vexpand: child.compute_expand(Gtk.Orientation.VERTICAL) });
    child.set_parent(this);
    const self = new WeakRef(this);
    const target = Adw.CallbackAnimationTarget.new((progress) => {
      const widget = self.deref();
      if (!widget) return;
      widget.progress = progress;
      widget.queue_draw();
    });
    this.#animation = Adw.TimedAnimation.new(this, 0, 1, 160, target);
    this.#animation.set_easing(Adw.Easing.EASE_OUT_CUBIC);
  }

  play() {
    this.#animation.reset();
    this.#animation.play();
  }
}
