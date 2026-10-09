import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { message, prepareDisplay, type Account } from "../models";
import { Storage } from "./storage";
import { MailWorker, type Delivered } from "./worker";

const account = (host: string, port: number): Account => ({
  path: "me",
  email: "me@example.com",
  name: "",
  host,
  username: "me",
  port,
  ssl: true,
  tls: false,
  oauth2: false,
  smtp: null,
});

function cache() {
  const directory = mkdtempSync(join(tmpdir(), "brevlada-worker-"));
  return { path: join(directory, "cache.db"), [Symbol.dispose]: () => rmSync(directory, { recursive: true }) };
}

test("reads cached draft bodies without waiting for the network", async () => {
  using directory = cache();
  const received = message({ uid: 1, messageId: "incoming", sender: "other@example.com" });
  const draft = message({
    uid: 42,
    uidValidity: 7,
    messageId: "draft",
    references: ["incoming"],
    isDraft: true,
    bodyLoaded: true,
    bodyText: "Cached body",
    bodyHtml: "<b>Cached body</b>",
    cc: "cc@example.com",
  });
  const storage = Storage.open(directory.path);
  storage.store("me@example.com", "Drafts", draft);
  storage.close();
  const stalled = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const related = Promise.withResolvers<Delivered>();
  const worker = MailWorker.start(directory.path, (event) => event.type === "RelatedSent" && related.resolve(event));
  const mailbox = account("127.0.0.1", stalled.port);
  worker.send({ type: "Folders", account: mailbox });
  worker.send({ type: "RelatedSent", account: mailbox, folder: "INBOX", messages: [received], generation: 3, selection: 9 });
  const event = await related.promise;
  prepareDisplay(draft);
  expect(event).toMatchObject({ type: "RelatedSent", generation: 3, selection: 9, messages: [{ message: draft }] });
  worker.stop();
  stalled.stop(true);
});

test("publishes sync status to the UI handle", async () => {
  using directory = cache();
  const worker = MailWorker.start(directory.path, () => {});
  expect(worker.syncStatus()).toBeNull();
  worker.sync();
  while (!worker.syncStatus()) await Bun.sleep(10);
  expect(worker.syncStatus()).toEqual({ activity: null, active: 0, queued: 0, failed: 0, lastStarted: null });
  worker.stop();
});

test("records commands and numbers requests for UI tests", () => {
  const [worker, commands] = MailWorker.recording();
  const mailbox = account("imap.example.com", 993);
  worker.register(mailbox, true);
  worker.focus("me@example.com", "INBOX");
  worker.select(worker.nextRequest());
  worker.avatars("ada@example.com");
  expect(worker.nextRequest()).toBe(2);
  expect(commands).toEqual([
    { type: "Register", account: mailbox, expanded: true },
    { type: "Focus", account: "me@example.com", folder: "INBOX" },
    { type: "Select", selection: 1 },
    { type: "Avatar", email: "ada@example.com" },
  ]);
});
