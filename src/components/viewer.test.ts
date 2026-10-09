import { expect, test } from "bun:test";
import Gtk from "gi://Gtk?version=4.0";
import { message, type Message } from "../models";
import { event } from "../models/calendar";
import { Avatars } from "./avatars";
import { buttons, settle, useDisplay } from "./testing";
import { card } from "./viewer";

useDisplay();

test("rsvp body never creates a webview before its invitation loads", async () => {
  let mediaRequests = 0;
  const show = (shown: Message) =>
    card(shown, true, false, false, false, new Avatars(() => {}), false, true, null, "", () => {}, () => {}, () => mediaRequests++, () => {});
  const pending = message({ bodyText: "Accepted: Lunch", bodyHtml: "<p>Accepted: Lunch</p><img src='https://example.com/image'>" });
  const reply = show(pending);
  const window = new Gtk.Window({ child: reply.widget });
  window.present();
  await settle();
  expect(reply.content.body.get_mapped()).toBe(true);
  expect(reply.content.webview).toBeNull();

  const loaded = { ...pending, bodyLoaded: true, calendarEvents: [event({ method: "REPLY" })] };
  reply.update(loaded);
  expect(reply.content.rendered).toBe(true);
  expect(reply.content.webview).toBeNull();
  expect(reply.content.hasMedia).toBe(false);
  expect(reply.content.mediaButton.get_visible()).toBe(false);

  const known = show(loaded);
  window.set_child(known.widget);
  await settle();
  expect(known.content.rendered).toBe(true);
  expect(known.content.webview).toBeNull();
  expect(mediaRequests).toBe(0);
  window.close();
});

test("responses wait for the body and replay once it loads", async () => {
  const responses: string[] = [];
  let opened = 0;
  const pending = message({ uid: 7, sender: "Ada <ada@example.com>", subject: "Plans", unsubscribe: { url: "https://example.com/u", oneClick: true } });
  const shown = card(pending, false, true, false, false, new Avatars(() => {}), false, false, null, "", () => opened++, (_message, action) => responses.push(action), () => {}, () => {});
  const window = new Gtk.Window({ child: shown.widget });
  window.present();
  await settle();
  expect(shown.isExpanded()).toBe(false);
  const byTooltip = (text: string) => buttons(shown.widget).find((button) => button.get_tooltip_text() === text);
  byTooltip("Reply All")?.emit("clicked");
  expect([responses, opened, shown.isResponsePending()]).toEqual([[], 1, true]);
  shown.update({ ...pending, bodyLoaded: true, bodyText: "Sure" });
  expect([responses, shown.isResponsePending()]).toEqual([["ReplyAll"], false]);
  const unsubscribe = buttons(shown.widget).find((button) => button.get_label() === "Unsubscribe");
  expect(unsubscribe?.get_visible()).toBe(true);
  shown.finishUnsubscribe(true);
  expect([unsubscribe?.get_label(), unsubscribe?.get_sensitive()]).toEqual(["Unsubscribed", false]);
  expect(shown.layoutMatches(pending, true, false)).toBe(true);
  expect(shown.layoutMatches(pending, false, false)).toBe(false);
  window.close();
});
