import { expect, test } from "bun:test";
import { AvatarQueue } from "./avatar-queue";
import { resolve } from "./avatar-worker";
import { Storage } from "./storage";

test("serves cached images and cached misses without the network", async () => {
  const storage = Storage.open(":memory:");
  const queue = new AvatarQueue();
  const png = Uint8Array.from("\x89PNG\r\n\x1a\n", (char) => char.charCodeAt(0));
  storage.storeAvatar("ada@example.com", "google", png);
  expect(await resolve(storage, queue, "ada@example.com")).toEqual(png);
  storage.storeAvatar("grace@example.com", "none", null);
  expect(await resolve(storage, queue, "grace@example.com")).toBeNull();
});
