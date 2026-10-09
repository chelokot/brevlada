import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { message } from "../models";
import { loadAt, location } from "./attachment-cache";

const bytes = (...values: number[]) => new Uint8Array(values);
const failing = () => Promise.reject(new Error("Must reuse existing file"));

test("reuses saved files and downloads again after deletion", async () => {
  const directory = mkdtempSync(join(tmpdir(), "brevlada-attachment-cache-"));
  const source = message({ messageId: "one@example.com", attachments: ["../../résumé.txt", "../../résumé.txt"] });
  const first = location(directory, "me@example.com", "INBOX", source, 0);
  let calls = 0;
  const download = async () => (calls++, bytes(0, 255, 10));
  const path = await loadAt(first, download);
  expect(path).toBe(join(directory, "Brevlada/résumé.txt"));
  expect(await loadAt(first, download)).toBe(path);
  expect(calls).toBe(1);
  expect(readFileSync(path)).toEqual(Buffer.from([0, 255, 10]));
  expect(statSync(path).mode & 0o777).toBe(0o600);
  const duplicate = await loadAt(location(directory, "me@example.com", "INBOX", source, 1), async () => bytes(1, 2));
  expect(duplicate).toBe(join(directory, "Brevlada/résumé (2).txt"));
  expect(readFileSync(duplicate)).toEqual(Buffer.from([1, 2]));
  const existing = join(directory, "Brevlada/résumé (3).txt");
  writeFileSync(existing, "User's file");
  expect(await loadAt(location(directory, "other@example.com", "INBOX", source, 0), async () => bytes(3))).toBe(join(directory, "Brevlada/résumé (4).txt"));
  expect(readFileSync(existing, "utf8")).toBe("User's file");
  const synced = location(directory, "me@example.com", "Sent", { ...source, uid: 42, uidValidity: 7 }, 0);
  expect(await loadAt(synced, download)).toBe(path);
  expect(calls).toBe(1);
  rmSync(path);
  expect(await loadAt(first, download)).toBe(path);
  expect(calls).toBe(2);
  rmSync(path);
  await expect(loadAt(first, () => Promise.reject(new Error("Network failed")))).rejects.toThrow("Network failed");
  expect(existsSync(path)).toBe(false);
  expect(readFileSync(duplicate)).toEqual(Buffer.from([1, 2]));
  expect(JSON.parse(readFileSync(join(directory, "Brevlada/.attachments.json"), "utf8"))).toEqual({
    [first.identity]: "résumé.txt",
    [location(directory, "me@example.com", "INBOX", source, 1).identity]: "résumé (2).txt",
    [location(directory, "other@example.com", "INBOX", source, 0).identity]: "résumé (4).txt",
  });
  rmSync(directory, { recursive: true });
});

test("migrates hash folders without downloading or overwriting files", async () => {
  const directory = mkdtempSync(join(tmpdir(), "brevlada-attachment-migration-"));
  const source = message({ messageId: "one@example.com", attachments: ["notes.txt", "notes.txt", ".attachments.json"] });
  const [first, second, hidden] = [0, 1, 2].map((index) => location(directory, "me@example.com", "INBOX", source, index));
  if (!first || !second || !hidden) throw new Error("missing locations");
  for (const [target, text] of [
    [first, "First"],
    [second, "Second"],
  ] as const) {
    mkdirSync(join(target.directory, target.identity), { recursive: true });
    writeFileSync(join(target.directory, target.identity, target.name), text);
  }
  writeFileSync(join(first.directory, "notes.txt"), "User's file");
  const path = await loadAt(first, failing);
  const other = await loadAt(second, failing);
  expect([readFileSync(path, "utf8"), readFileSync(other, "utf8")]).toEqual(["First", "Second"]);
  expect(path).not.toBe(other);
  expect([dirname(path), dirname(other)]).toEqual([first.directory, first.directory]);
  expect([existsSync(join(first.directory, first.identity)), existsSync(join(second.directory, second.identity))]).toEqual([false, false]);
  expect(readFileSync(join(first.directory, "notes.txt"), "utf8")).toBe("User's file");
  expect(basename(await loadAt(hidden, async () => new TextEncoder().encode("Attachment contents")))).toBe(".attachments (2).json");
  expect(await loadAt(first, failing)).toBe(path);
  rmSync(directory, { recursive: true });
});
