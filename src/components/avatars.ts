import type Adw from "gi://Adw?version=1";
import Gdk from "gi://Gdk?version=4.0";
import GdkPixbuf from "gi://GdkPixbuf?version=2.0";
import GLib from "gi://GLib?version=2.0";

const OVERSAMPLE = 2;

export const PIXEL = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00,
  0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x70, 0x68, 0x38, 0x00, 0x00, 0x02, 0x84, 0x01, 0x81, 0x26, 0x97, 0xa7,
  0x2b, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

function decode(data: Uint8Array) {
  const loader = new GdkPixbuf.PixbufLoader();
  try {
    loader.write(data);
    loader.close();
  } catch (error) {
    if (error instanceof GLib.Error) return null;
    throw error;
  }
  return loader.get_pixbuf();
}

export class Avatars {
  readonly #masters = new Map<string, GdkPixbuf.Pixbuf | null>();
  readonly #scaled = new Map<string, Gdk.Texture>();
  readonly #waiting = new Map<string, WeakRef<Adw.Avatar>[]>();

  constructor(private readonly request: (email: string) => void) {}

  attach(avatar: Adw.Avatar, email: string) {
    if (!email) return;
    if (this.#masters.has(email)) return this.#draw(avatar, email);
    const waiting = this.#waiting.get(email);
    this.#waiting.set(email, [...(waiting ?? []).filter((widget) => widget.deref()), new WeakRef(avatar)]);
    if (!waiting) this.request(email);
  }

  resolved(email: string, image: Uint8Array | null) {
    this.#masters.set(email, image && decode(image));
    const waiting = this.#waiting.get(email) ?? [];
    this.#waiting.delete(email);
    for (const widget of waiting) {
      const avatar = widget.deref();
      if (avatar) this.#draw(avatar, email);
    }
  }

  #draw(avatar: Adw.Avatar, email: string) {
    const pixels = Math.max(avatar.get_size(), 1) * OVERSAMPLE;
    const key = `${pixels}:${email}`;
    const cached = this.#scaled.get(key);
    if (cached) return avatar.set_custom_image(cached);
    const master = this.#masters.get(email);
    if (!master) return;
    const texture = Gdk.Texture.new_for_pixbuf(master.scale_simple(pixels, pixels, GdkPixbuf.InterpType.HYPER) ?? master);
    this.#scaled.set(key, texture);
    avatar.set_custom_image(texture);
  }
}
