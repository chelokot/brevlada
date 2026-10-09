import type Gtk from "gi://Gtk?version=4.0";
import type { Message } from "../models";

export function insert(buffer: Gtk.TextBuffer, message: Message) {
  buffer.set_text(`\n\n${quoted(message.bodyText)}`, -1);
  buffer.place_cursor(buffer.get_start_iter());
}

const quoted = (text: string) =>
  (text ? text.split(/(?<=\n)/) : [])
    .map((line) => `> ${line.endsWith("\n") ? line.slice(0, -1).replace(/\r$/, "") : line}`)
    .join("\n");
