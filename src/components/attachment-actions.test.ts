import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import Gtk from "gi://Gtk?version=4.0";
import { path } from "../backend/attachment-cache";
import { type Account, message } from "../models";
import { attach } from "./attachment-actions";
import { FileCard, Section } from "./attachments";
import { scroll } from "./index";
import { buttons, capture, settle, useDisplay } from "./testing";

useDisplay();

test("clicking an attachment opens it and a failed download restores both buttons", async () => {
  const account: Account = { path: "", email: "attachment-diagnostic@example.com", name: "", host: "", username: "", port: 993, ssl: false, tls: false, oauth2: false, smtp: null };
  const name = `${Date.now()}.txt`;
  const mail = message({ messageId: `attachment-diagnostic-${process.pid}-${Bun.nanoseconds()}`, attachments: [name] });
  const card = new FileCard("test.txt", 3);
  attach(card, name, account, "INBOX", mail, 0);
  const [open, save, ...rest] = buttons(card.widget);
  if (open === undefined || save === undefined) throw new Error("Attachment card has open and save buttons");
  expect(rest).toEqual([]);
  expect(open.get_icon_name()).toBeNull();
  expect(open.get_tooltip_text()).toBe(`Open ${name}`);
  expect(card.status.is_ancestor(open)).toBe(true);
  expect(save.is_ancestor(open)).toBe(false);
  const indicator = save.get_child();
  if (!(indicator instanceof Gtk.Stack)) throw new Error("Save button shows a stack");
  const spinner = indicator.get_child_by_name("spinner");
  if (!(spinner instanceof Gtk.Spinner)) throw new Error("Save button has a spinner");
  open.emit("clicked");
  expect(open.get_sensitive() || save.get_sensitive()).toBe(false);
  for (const deadline = Date.now() + 3000; !open.get_sensitive() && Date.now() < deadline; ) await settle(5);
  expect(open.get_sensitive() && save.get_sensitive()).toBe(true);
  expect(indicator.get_visible_child_name()).toBe("icon");
  expect(spinner.get_spinning()).toBe(false);
  expect(card.status.get_text()).toContain("Could not open attachment");
  card.status.set_text("3 bytes");
  expect(existsSync(path(account, "INBOX", mail, 0))).toBe(false);
  const section = new Section();
  section.update(6, 18);
  section.append(card);
  for (let index = 0; index < 5; index++) {
    const tile = new FileCard("a long attachment filename that must wrap without widening the pane.txt", 3);
    attach(tile, name, null, "INBOX", mail, 0);
    section.append(tile);
  }
  expect(section.expander.get_expanded()).toBe(false);
  const window = new Gtk.Window({ child: scroll(section.widget), defaultWidth: 1000, defaultHeight: 500 });
  window.present();
  section.expander.set_expanded(true);
  for (const width of [1000, 340]) {
    window.set_default_size(width, 500);
    await settle(250);
    const [first, second] = [0, 1].map((index) => section.grid.get_child_at_index(index)?.compute_bounds(section.grid)[1].get_y());
    if (width === 1000) expect(first).toBe(second);
    else expect(second).toBeGreaterThan(first ?? Infinity);
    expect(section.grid.get_width()).toBeLessThanOrEqual(width);
    const [, bounds] = open.compute_bounds(card.widget);
    const [cardWidth, cardHeight] = [card.widget.get_width(), card.widget.get_height()];
    expect([bounds.get_x(), bounds.get_y(), bounds.get_width(), bounds.get_height()]).toEqual([0, 0, cardWidth, cardHeight]);
    for (const [x, y] of [
      [cardWidth / 2, 1],
      [1, cardHeight / 2],
      [cardWidth - 1, cardHeight / 2],
      [cardWidth / 2, cardHeight - 1],
    ] as const) {
      const target = card.widget.pick(x, y, Gtk.PickFlags.DEFAULT);
      expect(target === open || target?.is_ancestor(open)).toBe(true);
    }
    const [, saveBounds] = save.compute_bounds(card.widget);
    const target = card.widget.pick(saveBounds.get_x() + saveBounds.get_width() / 2, saveBounds.get_y() + saveBounds.get_height() / 2, Gtk.PickFlags.DEFAULT);
    expect(target === save || target?.is_ancestor(save)).toBe(true);
    expect(target?.is_ancestor(open)).toBe(false);
  }
  capture("BREVLADA_ATTACHMENT_PREVIEW", window, window);
  window.close();
});
