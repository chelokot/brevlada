import { expect, test } from "bun:test";
import type { Account } from "../models";
import { AvatarQueue } from "./avatar-queue";

const account = (email: string, host: string): Account => ({
  path: "",
  email,
  name: "",
  host,
  username: "",
  port: 993,
  ssl: true,
  tls: false,
  oauth2: true,
  smtp: null,
});

test("queues each sender once until it is taken", async () => {
  const queue = new AvatarQueue();
  for (const email of ["ada@example.com", "ada@example.com", "grace@example.com", ""]) queue.push(email);
  expect([await queue.pop(), await queue.pop()]).toEqual(["ada@example.com", "grace@example.com"]);
  queue.push("ada@example.com");
  expect(await queue.pop()).toBe("ada@example.com");
  const waiting = queue.pop();
  queue.close();
  queue.push("ada@example.com");
  expect([await waiting, await queue.pop()]).toEqual([null, null]);
});

test("offers Google credentials and drops contact search when refused", () => {
  const queue = new AvatarQueue();
  queue.register(account("me@gmail.com", "imap.gmail.com"));
  queue.register(account("work@example.com", "imap.fastmail.com"));
  expect(queue.credentials().map((credential) => credential.search)).toEqual([true]);
  queue.register(account("me@gmail.com", "imap.gmail.com"));
  expect(queue.credentials()).toHaveLength(1);
  queue.unauthorized(["me@gmail.com"]);
  expect(queue.credentials().map((credential) => credential.search)).toEqual([false]);
  queue.retainAccounts([account("me@gmail.com", "imap.gmail.com")]);
  queue.retainAccounts([]);
  queue.register(account("me@gmail.com", "imap.gmail.com"));
  expect(queue.credentials().map((credential) => credential.search)).toEqual([true]);
});
