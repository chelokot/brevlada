import { expect, test } from "bun:test";
import Gtk from "gi://Gtk?version=4.0";
import { descendants } from "../components/testing";
import { message } from "../models";
import { parseMessage } from "../models/parcel";
import { newSelection } from "./actions";
import { renderConversation } from "./conversation";
import { event } from "./events";
import { deliverySequence } from "./parcel-history";
import { inbox, next, present, useWindows } from "./testing";

useWindows();

const update = (uid: number, order: string | null, status: string) =>
  message({
    uid,
    messageId: `update-${uid}`,
    timestamp: uid,
    sender: "Shop <shop@example.com>",
    subject: `Update ${uid}`,
    isRead: true,
    bodyLoaded: true,
    bodyHtml: `<script type='application/ld+json'>${JSON.stringify({ "@type": "ParcelDelivery", partOfOrder: { orderNumber: order }, deliveryStatus: status })}</script>`,
  });

const statuses = (widget: Gtk.Widget) =>
  descendants(widget).flatMap((child) =>
    child instanceof Gtk.Label && (child.has_css_class("parcel-step-name") || child.has_css_class("parcel-single-step-name")) ? [child.get_text()] : [],
  );

test("requests history only with an id and refreshes the sequence from other emails", () => {
  const { state, commands } = inbox("Delivery", "me@example.com");
  const missing = update(1, null, "Sent");
  const parcel = present(parseMessage(missing)[0]);
  expect(deliverySequence(state, parcel, missing, [])).toEqual(parcel);
  expect(next(commands)).toBeNull();
  newSelection(state);
  const shipped = message({
    uid: 10,
    messageId: "shipped",
    timestamp: 10,
    sender: "UGREEN <service.eu@ugreen.com>",
    subject: "Your order KVM Switch has already been shipped.",
    bodyHtml: "<div>Tracking number: CC996635912DE</div>",
    bodyLoaded: true,
    isRead: true,
  });
  const delivered = { ...shipped, uid: 11, messageId: "delivered", timestamp: 11, subject: "Your order KVM Switch has been delivered." };
  state.messages = [delivered, shipped];
  state.openGroup = [delivered, shipped];
  renderConversation(state);
  expect(statuses(state.viewer)).toEqual(["In transit", "Delivered"]);
  expect(descendants(state.viewer).filter((child) => child.get_parent() === state.viewer && child.has_css_class("parcel-card"))).toHaveLength(1);
  expect(next(commands)).toMatchObject({ type: "ParcelHistory", identifier: { kind: "Tracking", value: "CC996635912DE" } });
  expect(next(commands)).toBeNull();
  const source = update(2, "123", "In transit");
  state.messages = [source];
  state.openGroup = [source];
  renderConversation(state);
  expect(next(commands)).toMatchObject({
    type: "ParcelHistory",
    account: { email: "me@example.com" },
    folder: "INBOX",
    sender: "shop@example.com",
    identifier: { kind: "Order", value: "123" },
  });
  expect(statuses(state.viewer)).toEqual(["In transit"]);
  const history = (selection: number, ...messages: ReturnType<typeof update>[]) =>
    event(state, { type: "ParcelHistory", generation: state.generation, selection, sender: "shop@example.com", identifier: { kind: "Order", value: "123" }, messages });
  history(state.selection + 1, update(3, "123", "Delivered"));
  expect(statuses(state.viewer)).toEqual(["In transit"]);
  history(state.selection, update(1, "123", "Sent"));
  expect(statuses(state.viewer)).toEqual(["Sent", "In transit"]);
  event(state, { type: "CacheBody", account: "me@example.com", folder: "INBOX", message: update(3, "123", "Delivered") });
  expect(statuses(state.viewer)).toEqual(["Sent", "In transit", "Delivered"]);
  history(state.selection, update(1, "123", "Sent"));
  expect(statuses(state.viewer)).toEqual(["Sent", "In transit", "Delivered"]);
  expect(next(commands)).toBeNull();
});
