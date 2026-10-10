import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { message, type Message } from "../models";
import { preview } from "../models/senders";
import { request, Search, type Request, type Response, type Scope } from "./search";
import { Entry, pairs } from "./search/senders";
import { Storage } from "./storage";

function start() {
  const queue: Response[] = [];
  let wake = () => {};
  const search = Search.start((response) => {
    queue.push(response);
    wake();
  });
  const next = async (): Promise<Response> => {
    for (;;) {
      const response = queue.shift();
      if (response) return response;
      await new Promise<void>((resolve) => (wake = resolve));
    }
  };
  const finished = async () => {
    for (;;) {
      const response = await next();
      if (response.complete) return response;
    }
  };
  const run = (item: Request) => {
    search.submit(item);
    return finished();
  };
  return { search, next, finished, run };
}

const sample = (): [Message, Message, Message] => [
  message({ uid: 1, sender: "Alice <alice@example.com>", recipients: "Receiver <receiver@example.com>", subject: "Old", bodyText: "Needle" }),
  message({ uid: 2, timestamp: 2, sender: "alice@example.com", subject: "Latest" }),
  message({ uid: 3, sender: "bob@example.com", bodyText: "Needle" }),
];

const uids = (response: Response) => response.groups.flat().map(({ uid }) => uid);

test("changing sources and dates reuses the index without reusing results", async () => {
  const { search, run } = start();
  const messages = sample();
  const withoutBody = request(false, "needle", null, null, messages);
  withoutBody.filters.sources[5] = false;
  expect((await run(withoutBody)).groups).toEqual([]);
  const later = request(false, "needle", null, null, messages);
  later.filters.from = "2026-10-02";
  expect((await run(later)).groups).toEqual([]);
  expect((await run(request(false, "needle", null, null, messages))).groups).toHaveLength(2);
  search.stop();
});

test("account scope keeps overlapping UIDs separate and reads other accounts from the cache", async () => {
  const directory = mkdtempSync(join(tmpdir(), "brevlada-search-"));
  const cachePath = join(directory, "cache.db");
  const storage = Storage.open(cachePath);
  const original = message({ uid: 1, sender: "shared@example.com", bodyText: "Current needle" });
  const other = { ...original, bodyText: "Other needle" };
  storage.store("a", "INBOX", original);
  storage.store("b", "INBOX", other);
  storage.store("b", "Archive", { ...other, bodyText: "Wrong folder" });
  const messages = [original];
  const { search, run } = start();
  const scope: Scope = { current: { account: "a", folder: "INBOX" }, folder: "INBOX", accounts: ["a", "b"], cachePath, revision: 0 };
  const scoped = async (query: string) => {
    const item = request(false, query, null, null, messages);
    item.scope = scope;
    const response = await run(item);
    expect(response.error).toBeNull();
    return response;
  };
  let result = await scoped("needle");
  expect(result.groups).toHaveLength(2);
  expect(new Set(result.locations.map((location) => location?.account))).toEqual(new Set(["a", "b"]));
  result = await scoped("other needle");
  expect([result.groups.length, result.locations[0]?.account]).toEqual([1, "b"]);
  expect((await scoped("wrong folder")).groups).toEqual([]);
  scope.folder = null;
  const archive = await scoped("wrong folder");
  expect([archive.groups.length, archive.locations[0]]).toEqual([1, { account: "b", folder: "Archive" }]);
  expect((await scoped("")).groups).toHaveLength(3);
  scope.folder = "Archive";
  expect((await scoped("")).groups).toHaveLength(1);
  expect((await scoped("current needle")).groups).toEqual([]);
  scope.current = null;
  scope.folder = null;
  expect((await scoped("")).groups).toHaveLength(3);
  scope.folder = "Missing";
  expect((await scoped("")).groups).toEqual([]);
  scope.folder = "INBOX";
  scope.accounts = ["b"];
  expect((await scoped("other needle")).groups).toHaveLength(1);
  expect((await scoped("current needle")).groups).toEqual([]);
  scope.accounts = ["a", "b"];
  expect((await scoped("needle")).groups).toHaveLength(2);
  scope.accounts = ["b"];
  expect((await scoped("other needle")).groups).toHaveLength(1);
  expect((await scoped("current needle")).groups).toEqual([]);
  storage.store("b", "INBOX", { ...other, bodyText: "New cached body" });
  expect((await scoped("new cached body")).groups).toHaveLength(1);
  scope.accounts = [];
  expect((await scoped("")).groups).toEqual([]);
  search.stop();
  storage.close();
  rmSync(directory, { recursive: true });
});

test("sender search previews the match and message search stays in the sender", async () => {
  const { search, run } = start();
  const messages = sample();
  const result = await run(request(false, "receiver", null, null, messages));
  expect(search.accepts(result)).toBe(true);
  const [group, ...rest] = result.groups;
  expect(rest).toEqual([]);
  expect([group?.[0]?.uid, group?.[0]?.searchMatch, group && preview(group)?.uid]).toEqual([1, true, 1]);
  expect(uids(await run(request(true, "needle", "alice@example.com", null, messages)))).toEqual([1]);
  search.stop();
});

test("superseded and cleared queries cannot publish old results", async () => {
  const { search, run, finished } = start();
  const old = await run(request(false, "needle", null, null, sample()));
  search.submit(request(false, "missing", null, null, sample()));
  expect(search.accepts(old)).toBe(false);
  const latest = await finished();
  expect(latest.groups).toEqual([]);
  search.cancel(false);
  expect(search.accepts(latest)).toBe(false);
  search.stop();
});

test("refreshing the snapshot and sender page replaces searchable fields without duplicates", async () => {
  const { search, run } = start();
  const original = sample();
  expect((await run(request(false, "needle", null, null, original))).groups).toHaveLength(2);
  const [first, ...rest] = original;
  const updated = [{ ...first, bodyText: "Changed body", cc: "New recipient" }, ...rest];
  expect(uids(await run(request(false, "needle", null, null, updated)))).toEqual([3]);
  const threads = request(true, "new recipient", "alice@example.com", null, original);
  threads.senderMessages = updated;
  expect(uids(await run(threads))).toEqual([1]);
  search.stop();
});

test("previews the newest matching message even when non-matches are unread", async () => {
  const messages = [
    message({ uid: 4, timestamp: 4, sender: "sender@example.com", subject: "Unrelated" }),
    message({ uid: 3, timestamp: 3, sender: "sender@example.com", subject: "Needle newest", isRead: true }),
    message({ uid: 2, timestamp: 2, sender: "sender@example.com", subject: "Needle older" }),
  ];
  const { search, run } = start();
  for (const query of ["needle", "older", "needle"]) {
    const [group = []] = (await run(request(false, query, null, null, messages))).groups;
    const expected = query === "older" ? 2 : 3;
    expect([group.length, group[0]?.uid, preview(group)?.uid]).toEqual([query === "older" ? 1 : 2, expected, expected]);
    expect(group.every(({ searchMatch }) => searchMatch)).toBe(true);
  }
  search.stop();
});

test("header matches and a disabled body do not decode HTML", () => {
  const source = message({ subject: "Delivery", bodyHtml: "<style>hidden</style><p>Visible &amp; searchable</p>" });
  const entry = Entry.memory(source);
  const query = request(false, "delivery", null, null, []);
  expect(entry.matches(query, pairs(query.query))).toBe(true);
  expect(entry.fields[6]).toBeUndefined();
  query.query = "visible & searchable";
  query.filters.sources[5] = false;
  expect(entry.matches(query, pairs(query.query))).toBe(false);
  expect(entry.fields[6]).toBeUndefined();
  query.filters.sources[5] = true;
  expect(entry.matches(query, pairs(query.query))).toBe(true);
  query.query = "hidden";
  expect(entry.matches(query, pairs(query.query))).toBe(false);
});

test("streams partial results and finishes with matching previews", async () => {
  const messages = Array.from({ length: 256 }, (_, index) =>
    message({
      uid: index + 1,
      timestamp: index + 1,
      sender: `sender${(index + 1) % 32}@example.com`,
      subject: index < 32 ? "needle" : "Latest",
      bodyHtml: "<p>Large body</p>".repeat(64),
    }),
  );
  const { search, next, finished } = start();
  search.submit(request(false, "needle", null, null, messages));
  const first = await next();
  expect([first.complete, first.groups.length]).toEqual([false, 1]);
  expect([(first.groups[0]?.[0]?.uid ?? 0) <= 32, first.groups[0]?.[0]?.searchMatch]).toEqual([true, true]);
  expect(first.groups.flat().every(({ bodyHtml }) => bodyHtml === "")).toBe(true);
  const final = await finished();
  expect(search.accepts(final)).toBe(true);
  expect(final.groups).toHaveLength(32);
  expect(final.groups.every((group) => group.length === 1 && (group[0]?.uid ?? 0) <= 32 && group[0]?.searchMatch)).toBe(true);
  search.submit(request(false, "missing", null, null, []));
  const empty = await next();
  expect([empty.complete, empty.groups]).toEqual([true, []]);
  search.stop();
});

test("repeated responses reuse sent headers without sharing message objects", async () => {
  const { search, run } = start();
  const messages = sample();
  const first = await run(request(false, "needle", null, null, messages));
  const [group] = first.groups;
  const [header] = group ?? [];
  if (!header) throw new Error("Missing search result");
  header.isRead = true;
  await run(request(false, "missing", null, null, messages));
  const again = await run(request(false, "needle", null, null, messages));
  expect(again.groups).toEqual((await run(request(false, "needle", null, null, messages))).groups);
  expect(again.groups[0]?.[0]?.isRead).toBe(false);
  search.stop();
});

test("the in-memory prefilter never drops a matching message", async () => {
  const texts = ["Invoice 42 from ACME", "Ünïcödé Straße", "ΟΔΟΣ αγάπης", "🎉 party tonight", "meeting at noon", "zz top", "i̇stanbul", "x"];
  const messages = texts.flatMap((text, index) => [
    message({ uid: index * 3 + 1, timestamp: index, sender: `s${index}@example.com`, subject: text }),
    message({ uid: index * 3 + 2, timestamp: index, sender: `t${index}@example.com`, bodyText: `Body: ${text}` }),
    message({ uid: index * 3 + 3, timestamp: index, sender: `u${index}@example.com`, cc: text.toUpperCase() }),
  ]);
  const { search, run } = start();
  for (const query of ["invoice", "42 f", "ünï", "straße", "οδος", "γάπ", "🎉", "party", "noon", "zz", "i̇st", "x", "acme", "body: z", "missing"]) {
    const expected = messages
      .filter(({ subject, sender, replyTo, recipients, cc, bodyText }) => [subject, sender, replyTo, recipients, cc, bodyText].some((field) => field.toLowerCase().includes(query)))
      .map(({ uid }) => uid)
      .sort((a, b) => a - b);
    expect([query, uids(await run(request(false, query, null, null, messages))).sort((a, b) => a - b)]).toEqual([query, expected]);
  }
  search.stop();
});

test("unread-first ordering counts deferred reads only in the current mailbox", async () => {
  const messages = [
    message({ uid: 1, timestamp: 1, sender: "first@example.com", subject: "needle", isRead: true }),
    message({ uid: 2, timestamp: 2, sender: "second@example.com", subject: "needle", isRead: true }),
  ];
  const { search, run } = start();
  const item = request(false, "needle", null, null, messages);
  expect(uids(await run(item))).toEqual([2, 1]);
  item.deferredRead = new Set([1]);
  expect(uids(await run(item))).toEqual([1, 2]);
  item.unreadFirst = false;
  expect(uids(await run(item))).toEqual([2, 1]);
  search.stop();
});
