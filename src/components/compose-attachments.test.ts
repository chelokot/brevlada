import { expect, test } from "bun:test";
import Gtk from "gi://Gtk?version=4.0";
import { encode } from "../backend/attachments";
import { message } from "../models";
import { fromMessage } from "../models/draft";
import { Attachments } from "./compose-attachments";
import { buttons, useDisplay } from "./testing";

useDisplay();

const bytes = (text: string) => new TextEncoder().encode(text);

test("removes original files by position and keeps new binary parts", () => {
  const attachments = new Attachments();
  const cards = () => {
    const grid = attachments.widget.get_first_child();
    if (!(grid instanceof Gtk.FlowBox)) throw new Error("Attachments live in a flow box");
    return Array.from({ length: grid.observe_children().get_n_items() }, (_, index) => grid.get_child_at_index(index)?.get_child());
  };
  const removeFirst = () => {
    const [card] = cards();
    const [remove] = card ? buttons(card) : [];
    remove?.emit("clicked");
  };
  const draft = fromMessage(message({ attachments: ["same.txt", "same.txt", "third.txt"] }));
  const part = encode("new.bin", "application/octet-stream", new Uint8Array([0, 255]));
  draft.attachments.push(part);
  attachments.load(draft);
  expect(cards().length).toBe(4);
  removeFirst();
  expect(attachments.removed()).toEqual([0]);
  expect(attachments.names()).toEqual(["same.txt", "third.txt"]);
  expect(attachments.parts()).toEqual([part]);
  const originals = [
    encode("same.txt", "text/plain", bytes("first")),
    encode("same.txt", "text/plain", bytes("second")),
    encode("third.txt", "text/plain", bytes("third")),
    "Content-Type: image/png\r\nContent-ID: <inline>\r\nContent-Transfer-Encoding: base64\r\n\r\nAP8=\r\n",
  ];
  attachments.resolve(originals);
  expect(attachments.loaded()).toBe(true);
  expect(attachments.removed()).toEqual([]);
  expect(attachments.names()).toEqual([]);
  expect(attachments.parts()).toEqual([...originals.slice(1, 3), part, ...originals.slice(3)]);
  attachments.resolve(originals);
  expect(attachments.parts().length).toBe(4);
  removeFirst();
  expect(attachments.parts().length).toBe(3);
  expect(attachments.removed()).toEqual([]);
  attachments.clear();
  expect(cards()).toEqual([]);
  expect(attachments.removed()).toEqual([]);
  expect(attachments.widget.is_visible()).toBe(false);
});
