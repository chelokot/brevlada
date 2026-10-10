import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { prepareDisplay, threads, type Message } from "../src/models";
import { groups, key } from "../src/models/senders";
import { parse } from "../src/backend/parser";
import { request, Search, type Request, type Response } from "../src/backend/search";
import { Storage } from "../src/backend/storage";
import { document } from "../src/components/html";

const ACCOUNT = "bench@brevlada.test";
const FOLDER = "INBOX";
const QUERIES = ["invoice", "meeting", "zz-no-match", "alice", "the"];
const [corpus, database] = Bun.argv.slice(2);
if (!corpus || !database) throw new Error("Usage: bun bench/storage.ts <corpus directory> <database path>");

const report = (name: string, ms: number, count: number) => console.log(JSON.stringify({ name, ms: Number(ms.toFixed(3)), count }));

function measure<T>(name: string, count: (result: T) => number, work: () => T): T {
  const started = performance.now();
  const result = work();
  report(name, performance.now() - started, count(result));
  return result;
}

async function repeat(name: string, times: number, work: () => number | Promise<number>) {
  const samples: number[] = [];
  let count = 0;
  for (let run = 0; run < times; run++) {
    const started = performance.now();
    count = await work();
    samples.push(performance.now() - started);
  }
  report(name, samples.sort((a, b) => a - b)[Math.floor(times / 2)] ?? 0, count);
}

const files = readdirSync(corpus)
  .sort()
  .map((name) => new Uint8Array(readFileSync(join(corpus, name))));
const full = measure("parse", (messages: Message[]) => messages.length, () => files.map((bytes, index) => parse(index + 1, bytes, index % 3 === 0, true)));
const headers = files.map((bytes, index) => parse(index + 1, bytes, index % 3 === 0, false));
const uids = headers.map(({ uid }) => uid);

rmSync(database, { force: true });
rmSync(`${database}-wal`, { force: true });
rmSync(`${database}-shm`, { force: true });
const storage = Storage.open(database);
measure("index_headers", () => headers.length, () => {
  storage.storeFolders(ACCOUNT, [FOLDER]);
  storage.reconcileSince(ACCOUNT, FOLDER, 1, headers, uids, storage.readRevision());
});
measure("index_bodies", () => full.length, () => full.forEach((message) => storage.storeBody(ACCOUNT, FOLDER, 1, message)));

let list: Message[] = [];
await repeat("folder_list", 5, () => (list = storage.senderHeaders(ACCOUNT, FOLDER)).length);

const senders = groups(list, "")
  .flatMap(([first, ...rest]) => (first ? [[key(first), rest.length + 1] as const] : []))
  .sort(([a, aCount], [b, bCount]) => bCount - aCount || (a < b ? -1 : a > b ? 1 : 0))
  .slice(0, 100);
await repeat("sender_pages", 3, () => senders.reduce((sum, [sender]) => sum + storage.senderPage(ACCOUNT, FOLDER, sender, null, 51).length, 0));
await repeat("message_lookup", 3, () =>
  Array.from({ length: 2000 }, (_, index) => ((index + 1) * 7919) % uids.length + 1).filter((uid) => storage.message(ACCOUNT, FOLDER, uid) !== null).length,
);

await repeat("threads", 5, () => threads(list, "").length);
await repeat("sender_groups", 5, () => groups(list, "").length);
const letters = full.filter(({ bodyHtml }) => bodyHtml).slice(0, 1000);
await repeat("render_letter", 3, () =>
  letters.reduce((sum, source) => {
    const letter = { ...source };
    prepareDisplay(letter);
    return sum + document(letter, true, false).length;
  }, 0),
);

let resolve: (response: Response) => void = () => {};
const search = Search.start((response) => {
  if (response.complete && search.accepts(response)) resolve(response);
});
const wait = (item: Request) =>
  new Promise<number>((done) => {
    resolve = (response) => done(response.groups.length);
    search.submit(item);
  });
const sequential = async (build: (query: string) => Request) => {
  let total = 0;
  for (const query of QUERIES) total += await wait(build(query));
  return total;
};
await repeat("search_memory", 3, () => sequential((query) => request(false, query, null, null, list)));
await repeat("search_cache", 3, () =>
  sequential((query) => ({ ...request(false, query, null, null, []), scope: { current: null, folder: null, accounts: [ACCOUNT], cachePath: database, revision: 1 } })),
);
search.stop();
storage.close();
