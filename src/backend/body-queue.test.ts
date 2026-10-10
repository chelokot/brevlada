import { expect, test } from "bun:test";
import type { Account } from "../models";
import { BodyQueue } from "./body-queue";
import type { BodyRequest } from "./protocol";

const account: Account = { path: "", email: "", name: "", host: "", username: "", port: 993, ssl: true, tls: false, oauth2: true, smtp: null };
const request = (selection: number, uid: number, markRead = false): BodyRequest => ({ account, folder: "INBOX", uid, generation: 1, selection, markRead });

test("new selection discards old queue and rejects late requests", async () => {
  const queue = new BodyQueue();
  queue.select(1);
  queue.push(request(1, 10));
  queue.push(request(1, 11));
  queue.select(2);
  queue.push(request(1, 12));
  queue.push(request(2, 20));
  expect((await queue.pop())?.uid).toBe(20);
  const waiting = queue.pop();
  queue.close();
  expect(await waiting).toBeNull();
  expect(await queue.pop()).toBeNull();
});

test("opens messages before queued previews", async () => {
  const queue = new BodyQueue();
  queue.select(1);
  queue.push(request(1, 10));
  queue.push(request(1, 11));
  queue.push(request(1, 12, true));
  const order = [await queue.pop(), await queue.pop(), await queue.pop()].map((item) => item?.uid);
  expect(order).toEqual([12, 10, 11]);
});

test("switching selection interrupts an active socket", async () => {
  const closed = Promise.withResolvers<void>();
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {}, close: () => closed.resolve() } });
  const socket = await Bun.connect({ hostname: "127.0.0.1", port: server.port, socket: { data() {} } });
  const queue = new BodyQueue();
  queue.select(1);
  using active = queue.watch(1, () => socket.end());
  expect(active).not.toBeNull();
  queue.select(2);
  await closed.promise;
  let cancelled = false;
  expect(queue.watch(1, () => (cancelled = true))).toBeNull();
  expect(cancelled).toBeTrue();
  server.stop(true);
});
