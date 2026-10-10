import { expect, test } from "bun:test";
import { matches, message, type Message } from "../models";
import { compactReply, event, participants, snapshot } from "../models/calendar";
import { merge } from "../models/read-state";
import { htmlText } from "../models/search";
import { Storage } from "./storage";

const visit = (storage: Storage, query: string) => {
  const candidates = storage.searchCandidates(query);
  const visited: [Message, number][] = [];
  storage.visitSearchMessages("a", "INBOX", (message, id) => visited.push([message, id]) > 0);
  return visited.filter(([, id]) => candidates === null || candidates.has(id));
};

test("search messages preserve mailbox identity and flag revisions", () => {
  const storage = Storage.open(":memory:");
  storage.store("a", "INBOX", message({ uid: 1, uidValidity: 7, messageId: "search-match", isFlagged: true, flagRevision: 4 }));
  const found = visit(storage, "").map(([message]) => message);
  expect([found[0]?.uidValidity, found[0]?.flagRevision]).toEqual([7, 4]);
  const read = storage.markReadCached("a", "INBOX", null, 1);
  if (read === null) throw new Error("The cached message was not marked read");
  merge(found, [read]);
  expect([found[0]?.isRead, found[0]?.readRevision]).toEqual([true, read.readRevision]);
  const revisions: [boolean, number][] = [];
  storage.visitSearchMessages("a", "INBOX", (message) => revisions.push([message.isRead, message.readRevision]) < 0);
  expect(revisions).toEqual([[true, read.readRevision]]);
});

test("sender headers hydrate ticket payloads before trimming HTML", () => {
  const storage = Storage.open(":memory:");
  const bodyHtml = `<script type='application/ld+json'>{"@type":"EventReservation","reservationNumber":"booking-one","reservationFor":{"@type":"Event","name":"Concert","startDate":"2026-10-08T20:00:00+02:00"},"reservedTicket":{"@type":"Ticket","ticketNumber":"ticket-one"}}</script>`;
  storage.store("me@example.com", "INBOX", message({ uid: 1, sender: "sender@example.com", bodyLoaded: true, bodyHtml }));
  const [header, ...rest] = storage.senderHeaders("me@example.com", "INBOX");
  expect(rest).toEqual([]);
  expect(header?.bodyHtml).toBe("");
  expect(header?.tickets.map(({ number, tickets }) => [number, tickets.map(({ number }) => number)])).toEqual([["booking-one", ["ticket-one"]]]);
  expect(storage.message("me@example.com", "INBOX", 1)?.tickets).toEqual([]);
});

test("sender pages prepare previews without copying inline images", () => {
  const storage = Storage.open(":memory:");
  const original = message({
    uid: 1,
    sender: "sender@example.com",
    bodyLoaded: true,
    bodyHtml: "<p>Cached HTML preview</p>",
    inlineMediaLoaded: true,
    inlineMedia: [{ contentId: "image", mime: "image/png", data: "x".repeat(1024 * 1024) }],
  });
  storage.store("a", "INBOX", original);
  const [page] = storage.senderPage("a", "INBOX", "sender@example.com", null, 25);
  expect(page?.listPreview).toBe("Cached HTML preview");
  expect([page?.displayPrepared, page?.bodyLoaded, page?.inlineMedia]).toEqual([true, true, []]);
  expect(storage.message("a", "INBOX", 1)).toEqual(original);
});

test("headers keep searchable HTML-only text and recipients without HTML payloads", () => {
  const storage = Storage.open(":memory:");
  const bodyHtml = "<style>hidden</style><p>De<span>liv</span>ery &amp; status</p>";
  storage.store("a", "INBOX", message({ uid: 1, sender: "sender@example.com", recipients: "receiver@example.com", cc: "copy@example.com", bodyLoaded: true, bodyHtml }));
  const [header] = storage.senderHeaders("a", "INBOX");
  expect(header?.bodyHtml).toBe("");
  for (const query of ["sender", "receiver", "copy", "delivery & status"]) expect(header && matches(header, query)).toBe(true);
  expect(header && matches(header, "hidden")).toBe(false);
});

test("parcel history includes older sender mail and isolates account, folder and address", () => {
  const storage = Storage.open(":memory:");
  for (let uid = 1; uid <= 60; uid++) {
    storage.store("a", "INBOX", message({ uid, timestamp: uid, sender: "Shop <shop@example.com>", bodyLoaded: true, bodyHtml: "Delivery details" }));
  }
  const others = [
    ["b", "INBOX", "shop@example.com"],
    ["a", "Archive", "shop@example.com"],
    ["a", "INBOX", "other-shop@example.com"],
    ["a", "INBOX", "shop@example.com <other@example.com>"],
  ] as const;
  others.forEach(([account, folder, sender], index) => storage.store(account, folder, message({ uid: 100 + index, sender })));
  const history = storage.parcelSenderMessages("a", "INBOX", "shop@example.com", "123");
  expect([history.length, history[0]?.uid, history[0]?.bodyHtml]).toEqual([60, 1, "Delivery details"]);
  expect(storage.parcelSenderMessages("a", "INBOX", "shop@example.com", " ")).toEqual([]);
  expect(storage.parcelSenderMessages("a", "INBOX", "", "123")).toEqual([]);
});

test("calendar history spans folders and local replies without crossing accounts", () => {
  const storage = Storage.open(":memory:");
  const invitation = message({
    uid: 1,
    messageId: "invitation",
    sender: "host@example.com",
    calendarEvents: [
      event({
        uid: "one",
        organizerEmail: "host@example.com",
        attendees: [{ email: "me@example.com", name: null, status: "NEEDS-ACTION" }],
        sequence: 1,
        method: "REQUEST",
      }),
    ],
  });
  const response = {
    ...invitation,
    uid: 2,
    messageId: "reply",
    sender: "me@example.com",
    calendarEvents: invitation.calendarEvents.map((item) => ({
      ...item,
      method: "REPLY",
      attendees: item.attendees.map((attendee) => ({ ...attendee, status: "ACCEPTED" })),
    })),
  };
  storage.store("me", "INBOX", invitation);
  storage.storeSent("me", response);
  storage.store("other", "INBOX", response);
  const history = storage.calendarMessages("me", "one");
  expect(history).toHaveLength(2);
  const [source] = invitation.calendarEvents;
  expect(source && snapshot(source, history).attendees[0]?.status).toBe("ACCEPTED");
  expect(storage.calendarMessages("me", "two")).toEqual([]);
});

test("lightweight headers keep reply classification without loading bodies", () => {
  const storage = Storage.open(":memory:");
  const invitation = message({
    uid: 1,
    messageId: "invitation",
    sender: "host@example.com",
    bodyLoaded: true,
    bodyHtml: "<p>Invitation body</p>",
    calendarEvents: [
      event({
        uid: "meeting",
        stamp: 10,
        method: "REQUEST",
        organizerEmail: "host@example.com",
        attendees: [{ email: "me@example.com", name: null, status: "NEEDS-ACTION" }],
      }),
    ],
  });
  const reply = {
    ...invitation,
    uid: 2,
    messageId: "response",
    sender: "me@example.com",
    calendarEvents: invitation.calendarEvents.map((item) => ({
      ...item,
      method: "REPLY",
      stamp: 11,
      attendees: item.attendees.map((attendee) => ({ ...attendee, status: "ACCEPTED" })),
    })),
    attachments: ["response.ics"],
    attachmentDetails: [{ mime: "text/calendar", size: 100, calendarRendered: true }],
  };
  storage.store("me", "INBOX", invitation);
  storage.store("me", "INBOX", reply);
  storage.store("me", "INBOX", { ...reply, uid: 3, messageId: "response-with-file", attachments: [...reply.attachments, "notes.pdf"] });
  const headers = storage.senderHeaders("me", "INBOX");
  expect(headers.every(({ bodyLoaded, bodyHtml }) => !bodyLoaded && !bodyHtml)).toBe(true);
  const [mixed, answer, source] = headers;
  expect([mixed?.uid, answer?.uid, source?.uid]).toEqual([3, 2, 1]);
  if (!mixed || !answer || !source) throw new Error("Missing headers");
  expect(compactReply(answer, source.calendarEvents)).toBe(true);
  expect(compactReply(mixed, source.calendarEvents)).toBe(false);
  const [event0] = source.calendarEvents;
  if (!event0) throw new Error("Missing event");
  const current = snapshot(event0, [source, answer]);
  expect(current.attendees[0]?.status).toBe("ACCEPTED");
  expect(participants(current, [answer])[0]?.respondedAt).toBe(11);
});

test("cached search visits exactly what scanning would match, including Unicode case mappings", () => {
  const storage = Storage.open(":memory:");
  const fields: Partial<Message>[] = [
    { subject: "ΟΔΟΣ ΑΓΑΠΗΣ" },
    { subject: "İSTANBUL trip" },
    { subject: "Straße", bodyText: "Größe" },
    { subject: "🎉 Party" },
    { subject: "Invoice", bodyHtml: "<p>Caf&eacute; &amp; cr&egrave;me</p>" },
    { subject: "Meeting", cc: "Carol <CAROL@example.com>", replyTo: "Desk <desk@example.com>" },
    { subject: "the theme", bodyText: `${"x".repeat(5000)}needle` },
    ...Array.from({ length: 70 }, (_, index) => ({ subject: `Filler ${index}`, sender: `filler${index}@example.com` })),
  ];
  fields.forEach((item, index) => storage.store("a", "INBOX", message({ uid: index + 1, timestamp: index, ...item })));
  storage.store("a", "Archive", message({ uid: 1, subject: "Invoice archived" }));
  storage.storeBody("a", "INBOX", null, message({ uid: 2, subject: "İSTANBUL trip", bodyLoaded: true, bodyText: "Bosphorus ferry" }));
  storage.reconcile("a", "INBOX", 1, [message({ uid: 3, subject: "Strasse renamed" })], fields.map((_, index) => index + 1));
  const all = fields.map((_, index) => storage.message("a", "INBOX", index + 1)).filter((item) => item !== null);
  const scan = (query: string) =>
    all
      .filter(({ subject, sender, replyTo, recipients, cc, bodyText, bodyHtml }) =>
        [subject, sender, replyTo, recipients, cc, bodyText, bodyHtml && htmlText(bodyHtml)].some((field) => field.toLowerCase().includes(query)),
      )
      .map(({ uid }) => uid);
  const queries = ["", "ο", "οδος", "οδοσ", "αγαπης", "i̇st", "stanbul", "ist", "straße", "strasse ren", "größe", "🎉 p", "party", "café & cr", "carol@", "desk"];
  for (const query of [...queries, "the", "needle", "ferry", "filler6", "x".repeat(40), "zz"]) {
    const visited = visit(storage, query)
      .filter(([found, id]) => {
        const fields = () => [found.subject, found.sender, found.replyTo, found.recipients, found.cc, storage.searchBody(id, "bodyText"), storage.searchBody(id, "htmlText")];
        return !query || fields().some((field) => field.toLowerCase().includes(query));
      })
      .map(([found]) => found.uid);
    expect([query, visited.sort()]).toEqual([query, scan(query).sort()]);
  }
  expect(visit(storage, "invoice").length).toBeLessThan(16);
  expect(visit(storage, "needle").length).toBeLessThan(16);
  expect(["ΟΔΟΣ".toLowerCase(), "İ".toLowerCase()]).toEqual(["οδος", "i\u0307"]);
});
