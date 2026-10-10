import { expect, test } from "bun:test";
import Gtk from "gi://Gtk?version=4.0";
import { labels } from "../components/testing";
import { message } from "../models";
import { event as calendarEvent, isReply } from "../models/calendar";
import { parse } from "../models/parcel";
import { showThread } from "./actions";
import { calendarWidgets } from "./calendar";
import { renderConversation, type Source } from "./conversation";
import { event } from "./events";
import { applyCachedBody } from "./previews";
import { updateBody } from "./rendering";
import { inbox, present, useWindows, widget } from "./testing";

useWindows();

const mail = (uid: number, sender: string) =>
  message({ uid, timestamp: uid, messageId: `message-${uid}`, subject: `Message ${uid}`, sender, isRead: true, bodyLoaded: true });

const parcel = (order: string, status: string) =>
  present(parse(`<script type='application/ld+json'>${JSON.stringify({ "@type": "ParcelDelivery", partOfOrder: { orderNumber: order }, deliveryStatus: status })}</script>`)[0]);

const branchStatus = (responses: Gtk.Widget) =>
  widget(present(widget(responses.get_first_child(), Gtk.Grid).get_child_at(2, 0)).get_last_child(), Gtk.Label).get_text();

test("places context cards above sources and keeps updates on the original", () => {
  const { state, commands } = inbox("Context", "me@example.com");
  const invitation = calendarEvent({
    uid: "meeting",
    name: "Meeting",
    start: "2026-10-02T12:00:00Z",
    method: "REQUEST",
    stamp: 20,
    invitation: true,
    organizerEmail: "host@example.com",
    attendees: [{ email: "me@example.com", name: null, status: "NEEDS-ACTION" }],
  });
  const originalParcel = { ...mail(10, "shop@example.com"), parcels: [parcel("123", "Sent"), parcel("456", "Processing")] };
  const originalEvent = {
    ...mail(20, "host@example.com"),
    bodyLoaded: false,
    calendarEvents: [invitation, { ...invitation, uid: "another-meeting", name: "Another meeting" }],
  };
  const update = { ...mail(30, "shop@example.com"), parcels: [{ ...parcel("123", "Delivered"), trackingUrl: "https://example.com/track" }] };
  const reply = {
    ...mail(40, "me@example.com"),
    bodyLoaded: false,
    calendarEvents: [{ ...invitation, method: "REPLY", stamp: 21, invitation: false, attendees: [{ email: "me@example.com", name: null, status: "ACCEPTED" }] }],
  };
  const sentInvitation = { ...mail(15, "me@example.com"), calendarEvents: [{ ...invitation, uid: "sent-meeting", name: "Sent meeting" }] };
  const group = [mail(50, "host@example.com"), update, originalEvent, originalParcel];
  state.messages = [...group];
  state.openGroup = [...group];
  state.relatedSent = [
    { folder: "Sent", message: reply },
    { folder: "Sent", message: sentInvitation },
  ];
  renderConversation(state);
  const card = (uid: number) => present(state.cards.get(uid)).widget;
  const sentCard = (id: string) => present(state.sentCards.get(id)).widget;
  expect(state.viewer.get_first_child()).toBe(card(50));
  expect(state.sentCards.has("message-40")).toBe(false);
  expect(card(30).get_prev_sibling()).toBe(card(50));
  const secondEvent = present(card(20).get_prev_sibling());
  const firstEvent = present(secondEvent.get_prev_sibling());
  for (const shown of [firstEvent, secondEvent]) {
    expect(shown.has_css_class("calendar-event")).toBe(true);
    expect(present(shown.get_first_child()).has_css_class("calendar-card")).toBe(true);
    expect(present(shown.get_last_child()).has_css_class("calendar-participants")).toBe(true);
  }
  expect(firstEvent.get_prev_sibling()).toBe(card(30));
  expect(branchStatus(present(firstEvent.get_last_child()))).toStartWith("Accepted · ");
  const sentEvent = present(sentCard("message-15").get_prev_sibling());
  expect(sentEvent.get_prev_sibling()).toBe(card(20));
  expect(sentEvent.has_css_class("calendar-event")).toBe(true);
  const secondParcel = present(card(10).get_prev_sibling());
  const firstParcel = present(secondParcel.get_prev_sibling());
  expect(firstParcel.has_css_class("parcel-card")).toBe(true);
  expect(secondParcel.has_css_class("parcel-card")).toBe(true);
  expect(labels(firstParcel)).toContain("Track Package");
  expect(labels(firstParcel)).toContain("Delivered");
  expect(firstParcel.get_prev_sibling()).toBe(sentCard("message-15"));
  const sources = state.messages.map((message): Source => [false, "", message]);
  expect(calendarWidgets(state, sources).before.map((widgets) => widgets.length)).toEqual([0, 0, 2, 0]);
  const updatedReply = structuredClone(present(state.relatedSent[0]).message);
  updatedReply.uid = 60;
  updatedReply.timestamp = 60;
  updatedReply.messageId = "reply-update";
  const [replied] = updatedReply.calendarEvents;
  present(replied).stamp = 22;
  present(present(replied).attendees[0]).status = "TENTATIVE";
  state.messages.push(updatedReply);
  state.openGroup.push(updatedReply);
  renderConversation(state);
  expect(state.cards.has(60)).toBe(false);
  const responses = present(present(present(card(20).get_prev_sibling()).get_prev_sibling()).get_last_child());
  expect(branchStatus(responses)).toStartWith("Maybe · ");
  expect(widget(responses.get_first_child(), Gtk.Grid).get_child_at(2, 0)).toBeInstanceOf(Gtk.Box);
  const source = structuredClone(present(state.messages.find((message) => message.uid === 20)));
  source.calendarEvents = source.calendarEvents.slice(0, 1);
  const latestReply = structuredClone(present(state.messages.find((message) => message.uid === 60)));
  state.messages = [latestReply, source];
  showThread(state, [latestReply, source]);
  expect(state.cards.size).toBe(1);
  const original = present(state.cards.get(20));
  expect(original.isExpanded()).toBe(true);
  updateBody(state, { ...latestReply, bodyLoaded: true, bodyText: "Maybe: Meeting" });
  expect(card(20)).toBe(original.widget);
  expect(present(state.cards.get(20)).isExpanded()).toBe(true);
  expect(state.cards.has(60)).toBe(false);
  event(state, { type: "CalendarHistory", generation: state.generation, uid: "meeting", result: { ok: true, value: [source, { ...latestReply, bodyLoaded: true, bodyText: "Maybe: Meeting" }] } });
  expect(card(20)).toBe(original.widget);
  expect(present(state.cards.get(20)).isExpanded()).toBe(true);
  commands.splice(0);
  showThread(state, [source]);
  expect(branchStatus(present(present(state.viewer.get_first_child()).get_last_child()))).toStartWith("Maybe · ");
  expect(commands.some((command) => command.type === "CalendarHistory")).toBe(false);
  const cachedReply = {
    ...mail(70, "me@example.com"),
    bodyText: "Accepted: Meeting",
    calendarEvents: [{ ...present(source.calendarEvents[0]), method: "REPLY" }],
  };
  state.messages = [{ ...cachedReply, bodyLoaded: false, bodyText: "", calendarEvents: [] }];
  applyCachedBody(state, cachedReply);
  const header = present(state.messages[0]);
  expect(header.bodyLoaded).toBe(false);
  expect(isReply(header)).toBe(true);
  showThread(state, [header, source]);
  expect(state.cards.has(70)).toBe(false);
  expect(state.cards.size).toBe(1);
});
