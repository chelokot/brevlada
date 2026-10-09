import { expect, test } from "bun:test";
import Gtk from "gi://Gtk?version=4.0";
import { message } from "../models";
import { Avatars } from "./avatars";
import { messageRow, senderRow } from "./message-row";
import { capture, settle, useDisplay } from "./testing";

useDisplay();

const metadata = (row: Gtk.Widget) => {
  const date = row.get_last_child()?.get_first_child();
  const icons = date?.get_next_sibling();
  if (!date || !icons) throw new Error("Rows end with a date above their icons");
  return { date, icons, star: icons.get_last_child(), spam: icons.get_first_child() };
};

const bounds = (widget: Gtk.Widget | null, target: Gtk.Widget) => {
  const [ok, rect] = widget ? widget.compute_bounds(target) : [false, null];
  if (!ok || !rect) throw new Error("Widget is laid out");
  return rect;
};

test("stars follow dates in sender and conversation rows", async () => {
  const starred = message({
    uid: 1,
    sender: "Alice <alice@example.com>",
    subject: "Weekend plans",
    bodyText: "See you on Saturday.",
    timestamp: Math.floor(Date.now() / 1000),
    isFlagged: true,
    isSpam: true,
  });
  const plain = { ...starred, uid: 2, isFlagged: false, isSpam: false, subject: "Monthly newsletter" };
  const content = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 16, marginTop: 24, marginBottom: 24, marginStart: 24, marginEnd: 24 });
  const avatars = new Avatars(() => {});
  for (const [spam, row] of [
    [false, senderRow([starred], avatars)],
    [true, messageRow([starred])],
  ] as const) {
    const { date, star, spam: first } = metadata(row);
    expect(date.has_css_class("message-row-date")).toBe(true);
    expect(star?.has_css_class("message-row-flag-icon")).toBe(true);
    expect(first?.has_css_class("message-row-spam-icon")).toBe(spam);
    content.append(row);
  }
  content.append(senderRow([plain], avatars));
  content.append(messageRow([plain]));
  const window = new Gtk.Window({ defaultWidth: 450, child: content });
  window.present();
  await settle(200);
  for (const row of [content.get_first_child(), content.get_first_child()?.get_next_sibling()]) {
    if (!row) throw new Error("Rows are shown");
    const { date, star, spam } = metadata(row);
    const parent = row.get_last_child();
    if (!parent) throw new Error("Rows have metadata");
    const dateBounds = bounds(date, parent);
    const starBounds = bounds(star, parent);
    expect(starBounds.get_y()).toBeGreaterThanOrEqual(dateBounds.get_y() + dateBounds.get_height());
    if (spam?.has_css_class("message-row-spam-icon")) {
      const spamBounds = bounds(spam, parent);
      expect(spamBounds.get_x() + spamBounds.get_width()).toBeLessThanOrEqual(starBounds.get_x());
    }
  }
  capture("BREVLADA_STAR_SCREENSHOT", window, window);
  window.close();
});
