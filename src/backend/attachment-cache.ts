import GLib from "gi://GLib?version=2.0";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Account, Message } from "../models";
import { safeName } from "../models/attachment";
import { available, migrate } from "./attachment-cache/filenames";

export type Index = Map<string, string>;

export interface Location {
  directory: string;
  identity: string;
  name: string;
}

const downloads = () => GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD) ?? join(GLib.get_home_dir(), "Downloads");

export function path(account: Account, folder: string, message: Message, index: number) {
  const target = location(downloads(), account.email, folder, message, index);
  return filename(target, readIndex(target.directory));
}

export function location(downloads: string, account: string, folder: string, message: Message, index: number): Location {
  const name = message.attachments[index];
  if (name === undefined) throw new Error("Attachment is no longer available");
  const source = message.messageId || JSON.stringify([folder, message.uidValidity, message.uid]);
  const identity = new Bun.CryptoHasher("sha256").update(JSON.stringify([account.toLowerCase(), source, index, name])).digest("hex");
  return { directory: join(downloads, "Brevlada"), identity, name: safeName(name) };
}

export const load = (account: Account, folder: string, message: Message, index: number, download: () => Promise<Uint8Array>) =>
  loadAt(location(downloads(), account.email, folder, message, index), download);

export async function loadAt(location: Location, download: () => Promise<Uint8Array>): Promise<string> {
  const cached = readIndex(location.directory);
  migrate(location.directory, cached);
  if (cached.has(location.identity)) {
    const path = filename(location, cached);
    if (isFile(path)) return path;
  }
  const bytes = await download();
  const index = readIndex(location.directory);
  const path = filename(location, index);
  if (index.has(location.identity) && isFile(path)) return path;
  mkdirSync(location.directory, { recursive: true });
  index.set(location.identity, basename(path));
  writeIndex(location.directory, index);
  write(path, bytes);
  return path;
}

export function invalidName(name: string) {
  return safeName(name) !== name || name === ".attachments.json";
}

function filename(location: Location, index: Index) {
  const saved = index.get(location.identity);
  if (saved !== undefined && invalidName(saved)) throw new Error("Invalid saved attachment filename");
  return join(location.directory, saved ?? available(location.directory, location.name, index));
}

function readIndex(directory: string): Index {
  let bytes: Buffer;
  try {
    bytes = readFileSync(join(directory, ".attachments.json"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return new Map();
    throw error;
  }
  const parsed: unknown = JSON.parse(bytes.toString());
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("invalid type: expected a map");
  const index: Index = new Map();
  for (const [identity, name] of Object.entries(parsed)) {
    if (typeof name !== "string") throw new Error("invalid type: expected a string");
    index.set(identity, name);
  }
  return index;
}

export function writeIndex(directory: string, index: Index) {
  write(join(directory, ".attachments.json"), JSON.stringify(Object.fromEntries([...index].sort(([a], [b]) => (a < b ? -1 : 1)))));
}

export const stat = (path: string) => statSync(path, { throwIfNoEntry: false });

const isFile = (path: string) => stat(path)?.isFile() === true;

function write(path: string, bytes: Uint8Array | string) {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  writeFileSync(temporary, bytes, { mode: 0o600 });
  renameSync(temporary, path);
}
