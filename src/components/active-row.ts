import type Gtk from "gi://Gtk?version=4.0";

interface Binding {
  row: WeakRef<Gtk.Widget>;
  key: string;
  classes: string[];
}

export class ActiveRow {
  #key: string | null = null;
  readonly #bindings = new Set<Binding>();

  get key() {
    return this.#key;
  }

  setKey(key: string | null) {
    this.#key = key;
    for (const binding of this.#bindings) {
      if (binding.row.deref()) this.#apply(binding);
      else this.#bindings.delete(binding);
    }
  }

  bind(row: Gtk.Widget, key: string) {
    const binding = { row: new WeakRef(row), key, classes: row.get_css_classes() };
    this.#bindings.add(binding);
    this.#apply(binding);
  }

  #apply({ row, key, classes }: Binding) {
    row.deref()?.set_css_classes(this.#key === key ? [...classes, "message-row-open"] : classes);
  }
}
