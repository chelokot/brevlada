import { expect, test } from "bun:test";
import type { Account } from "../models";
import { message } from "../models";
import { BodyQueue } from "./body-queue";
import { load } from "./body-worker";
import { Connections } from "./connections";
import type { BodyRequest, Event } from "./protocol";
import { Storage } from "./storage";

const account: Account = { path: "", email: "a", name: "", host: "", username: "", port: 993, ssl: true, tls: false, oauth2: true, smtp: null };

test("reads the latest cached body and ignores a cancelled selection", async () => {
  const storage = Storage.open(":memory:");
  const request: BodyRequest = { account, folder: "INBOX", uid: 1, generation: 1, selection: 1, markRead: true };
  storage.store("a", "INBOX", message({ uid: 1 }));
  storage.store("a", "INBOX", message({ uid: 1, bodyLoaded: true, isRead: true, bodyText: "Already fetched" }));
  const queue = new BodyQueue();
  const events: Event[] = [];
  queue.select(1);
  await load(storage, request, queue, (event) => events.push(event), new Connections());
  expect(events).toMatchObject([{ type: "Body", generation: 1, selection: 1, message: { bodyText: "Already fetched" } }]);
  const unread = storage.message("a", "INBOX", 1);
  if (!unread) throw new Error("Message missing");
  storage.store("a", "INBOX", { ...unread, isRead: false });
  await load(storage, { ...request, markRead: false }, queue, (event) => events.push(event), new Connections());
  expect(events.slice(1)).toMatchObject([{ type: "Preview", generation: 1, selection: 1, message: { bodyText: "Already fetched", isRead: false } }]);
  expect(storage.message("a", "INBOX", 1)?.isRead).toBeFalse();
  queue.select(2);
  await load(storage, request, queue, (event) => events.push(event), new Connections());
  expect(events).toHaveLength(2);
});
