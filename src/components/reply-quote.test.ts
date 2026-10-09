import { expect, test } from "bun:test";
import Gtk from "gi://Gtk?version=4.0";
import { message } from "../models";
import { insert } from "./reply-quote";

test("quotes every line below two empty lines and puts the cursor first", () => {
  const buffer = new Gtk.TextBuffer();
  const text = () => buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), true);
  for (const [body, quoted] of [
    ["", "\n\n"],
    ["Hi\r\nthere\n", "\n\n> Hi\n> there"],
    ["a\n\nb", "\n\n> a\n> \n> b"],
  ] as const) {
    insert(buffer, message({ bodyText: body }));
    expect(text()).toBe(quoted);
    expect(buffer.get_iter_at_mark(buffer.get_insert()).get_offset()).toBe(0);
  }
});
