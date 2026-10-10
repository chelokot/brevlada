import Gdk from "gi://Gdk?version=4.0";
import GLib from "gi://GLib?version=2.0";
import type { Account } from "../models";
import { address as normalize } from "../models/senders";
import { AVATAR_PIXELS, ICON_PIXELS } from "../theme";
import * as accounts from "./accounts";
import * as http from "./http";
import { type Source } from "./avatar-cache";
import { brandOf, isConsumer } from "./sender-domains";

const USERINFO = "https://www.googleapis.com/oauth2/v3/userinfo";
const PEOPLE = "https://people.googleapis.com/v1";
const READ_MASK = "emailAddresses,photos";
const FAVICONS = "https://www.google.com/s2/favicons";
const ICON_HORSE = "https://icon.horse/icon";
const MIN_ICON = 32;
const GOOD_ICON = 128;
const WHITE: Colour = [255, 255, 255];


export interface Credential {
  account: Account;
  search: boolean;
}

export interface Fetched {
  source: Source;
  image: Uint8Array | null;
  unauthorized: string[];
}

type Outcome = { kind: "Found"; url: string } | { kind: "Missing" } | { kind: "Denied" } | { kind: "Failed" };

type Colour = [red: number, green: number, blue: number];

interface Icon {
  width: number;
  height: number;
  stride: number;
  pixels: DataView;
}

interface People {
  results?: { person?: { emailAddresses?: { value?: unknown }[]; photos?: { url?: unknown; default?: unknown }[] } }[];
}

export function isGoogle({ host, oauth2 }: Account) {
  const server = host.trim().toLowerCase();
  return oauth2 && ["gmail.com", "googlemail.com", "google.com"].some((domain) => server === domain || server.endsWith(`.${domain}`));
}

export function gravatarUrl(email: string) {
  return `https://gravatar.com/avatar/${new Bun.CryptoHasher("sha256").update(normalize(email)).digest("hex")}?s=${AVATAR_PIXELS}&d=404`;
}

export function domain(email: string) {
  const address = normalize(email);
  const at = address.lastIndexOf("@");
  return at < 0 ? "" : address.slice(at + 1);
}

export function faviconDomains(email: string) {
  const host = domain(email);
  if (!host.includes(".") || isConsumer(host)) return [];
  const labels = host.split(".");
  return [...new Set([labels.length, 3, 2].filter((take) => take <= labels.length).map((take) => labels.slice(-take).join(".")))];
}

export function faviconUrls(domain: string) {
  const brand = http.encode(brandOf(domain));
  return [`${FAVICONS}?domain=${brand}&sz=${ICON_PIXELS}`, `${ICON_HORSE}/${brand}`];
}

export async function lookup(credentials: Credential[], email: string): Promise<Fetched> {
  const sender = normalize(email);
  const unauthorized: string[] = [];
  let transient = false;
  for (const { account, search } of credentials) {
    const own = normalize(account.email) === sender;
    if (!own && !search) continue;
    let token: string;
    try {
      token = accounts.token(account);
    } catch {
      transient = true;
      continue;
    }
    const outcome = own ? await ownPhoto(token) : await contactPhoto(token, sender);
    if (outcome.kind === "Found") {
      try {
        const image = await download(outcome.url);
        if (image) return { source: "google", image, unauthorized };
      } catch {
        transient = true;
      }
    } else if (outcome.kind === "Denied" && !own) unauthorized.push(account.email);
    else if (outcome.kind === "Failed") transient = true;
  }
  try {
    const image = await download(gravatarUrl(sender));
    if (image) return { source: "gravatar", image, unauthorized };
  } catch {
    transient = true;
  }
  try {
    const image = await brandIcon(faviconDomains(sender));
    if (image) return { source: "favicon", image: plate(image) ?? image, unauthorized };
  } catch {
    transient = true;
  }
  if (transient) throw new Error("Could not reach the avatar services");
  return { source: "none", image: null, unauthorized };
}

async function ownPhoto(token: string): Promise<Outcome> {
  const response = await http.get(USERINFO, token).catch(() => null);
  if (!response) return { kind: "Failed" };
  if (response.status === 401 || response.status === 403) return { kind: "Denied" };
  if (response.status !== 200) return { kind: "Failed" };
  const url = pictureUrl(response.text());
  return url === null ? { kind: "Missing" } : { kind: "Found", url };
}

async function contactPhoto(token: string, email: string): Promise<Outcome> {
  let outcome: Outcome = { kind: "Missing" };
  for (const collection of ["people:searchContacts", "otherContacts:search"]) {
    const response = await http.get(`${PEOPLE}/${collection}?readMask=${READ_MASK}&pageSize=10&query=${http.encode(email)}`, token).catch(() => null);
    if (response && (response.status === 401 || response.status === 403)) return { kind: "Denied" };
    if (!response || response.status !== 200) {
      outcome = { kind: "Failed" };
      continue;
    }
    const url = photoUrl(response.text(), email);
    if (url !== null) return { kind: "Found", url };
  }
  return outcome;
}

function json<T>(body: string): T | null {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

export function pictureUrl(body: string) {
  const picture = json<{ picture?: unknown }>(body)?.picture;
  return typeof picture === "string" ? sized(picture, AVATAR_PIXELS) : null;
}

export function photoUrl(body: string, email: string) {
  try {
    const person = json<People>(body)
      ?.results?.map((result) => result.person)
      .find((person) => person?.emailAddresses?.some(({ value }) => typeof value === "string" && normalize(value) === email));
    const url = person?.photos?.find((photo) => photo.default !== true)?.url;
    return typeof url === "string" ? sized(url, AVATAR_PIXELS) : null;
  } catch {
    return null;
  }
}

export function sized(url: string, pixels: number) {
  if (url.includes("?")) return url;
  const options = url.lastIndexOf("=");
  const base = options >= 0 && /^s\d/.test(url.slice(options + 1)) ? url.slice(0, options) : url;
  return `${base}=s${pixels}-c`;
}

async function brandIcon(domains: string[]) {
  let best: { pixels: number; image: Uint8Array } | null = null;
  let transient = false;
  for (const domain of domains) {
    for (const result of await Promise.allSettled(faviconUrls(domain).map(download))) {
      if (result.status === "rejected") transient = true;
      else if (result.value) {
        const pixels = detail(result.value);
        if (pixels >= MIN_ICON && (!best || pixels > best.pixels)) best = { pixels, image: result.value };
      }
    }
    if (best && best.pixels >= GOOD_ICON) break;
  }
  if (best) return best.image;
  if (transient) throw new Error("Could not reach the icon services");
  return null;
}

export function detail(image: Uint8Array) {
  const icon = decode(image);
  return icon && !isGenerated(icon) ? effectivePixels(icon) : 0;
}

export function decode(image: Uint8Array): Icon | null {
  try {
    const texture = Gdk.Texture.new_from_bytes(new GLib.Bytes(image));
    const downloader = Gdk.TextureDownloader.new(texture);
    downloader.set_format(Gdk.MemoryFormat.R8G8B8A8);
    const [bytes, stride] = downloader.download_bytes();
    const data = bytes.get_data();
    return data && { width: texture.get_width(), height: texture.get_height(), stride, pixels: new DataView(data.buffer, data.byteOffset, data.byteLength) };
  } catch {
    return null;
  }
}

function effectivePixels({ width, height, stride, pixels }: Icon) {
  const pixel = (x: number, y: number) => pixels.getUint32(y * stride + x * 4);
  let columns = 0;
  for (let x = 1; x < width; x++) {
    for (let y = 0; y < height; y++) {
      if (pixel(x, y) !== pixel(x - 1, y)) {
        columns = gcd(columns, x);
        break;
      }
    }
  }
  let rows = 0;
  for (let y = 1; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (pixel(x, y) !== pixel(x, y - 1)) {
        rows = gcd(rows, y);
        break;
      }
    }
  }
  const block = (stride: number, side: number) => (stride === 0 ? side : side % stride === 0 ? stride : 1);
  return Math.min(Math.trunc(width / block(columns, width)), Math.trunc(height / block(rows, height)));
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

function isGenerated({ width, height, stride, pixels }: Icon) {
  if (pixels.getUint8(0) !== 226 || pixels.getUint8(1) !== 226 || pixels.getUint8(2) !== 226) return false;
  for (let y = 0; y < height; y += 4) {
    for (let x = 0; x < width; x += 4) {
      const at = y * stride + x * 4;
      if (pixels.getUint8(at) !== pixels.getUint8(at + 1) || pixels.getUint8(at + 1) !== pixels.getUint8(at + 2)) return false;
    }
  }
  return true;
}

export function plate(image: Uint8Array) {
  const icon = decode(image);
  if (!icon) return null;
  const { width, height, stride, pixels } = icon;
  const colour = background(icon);
  const original = Math.max(width, height);
  const fitted = 2 * reach(icon, colour);
  const side = fitted > original ? Math.ceil(fitted * 1.15) : original;
  const canvas = new Uint8Array(side * side * 3);
  for (let at = 0; at < canvas.length; at += 3) canvas.set(colour, at);
  const [left, top] = [Math.trunc((side - width) / 2), Math.trunc((side - height) / 2)];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const from = y * stride + x * 4;
      const to = ((top + y) * side + left + x) * 3;
      const alpha = pixels.getUint8(from + 3);
      colour.forEach((plate, channel) => (canvas[to + channel] = Math.round((pixels.getUint8(from + channel) * alpha + plate * (255 - alpha)) / 255)));
    }
  }
  return Gdk.MemoryTexture.new(side, side, Gdk.MemoryFormat.R8G8B8, new GLib.Bytes(canvas), side * 3)
    .save_to_png_bytes()
    .get_data();
}

function reach({ width, height, stride, pixels }: Icon, [red, green, blue]: Colour) {
  const TOLERANCE = 24;
  const VISIBLE = 24;
  let furthest = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = y * stride + x * 4;
      if (pixels.getUint8(at + 3) < VISIBLE) continue;
      const differs = [red, green, blue].some((plate, channel) => Math.abs(pixels.getUint8(at + channel) - plate) > TOLERANCE);
      if (differs) furthest = Math.max(furthest, Math.hypot(x + 0.5 - width / 2, y + 0.5 - height / 2));
    }
  }
  return Math.ceil(furthest);
}

export function background({ width, height, stride, pixels }: Icon): Colour {
  const SAMPLES = 96;
  const RADIUS = 0.47;
  const UNIFORM = 48;
  const at = (x: number, y: number) => y * stride + x * 4;
  const opaque = (offset: number) => pixels.getUint8(offset + 3) === 255;
  const colour = (offset: number): Colour => [pixels.getUint8(offset), pixels.getUint8(offset + 1), pixels.getUint8(offset + 2)];
  const side = Math.min(width, height);
  const ring: Colour[] = [];
  for (let step = 0; step < SAMPLES; step++) {
    const angle = (step * 2 * Math.PI) / SAMPLES;
    const x = Math.round(width / 2 + Math.cos(angle) * side * RADIUS);
    const y = Math.round(height / 2 + Math.sin(angle) * side * RADIUS);
    const offset = at(Math.min(Math.max(x, 0), width - 1), Math.min(Math.max(y, 0), height - 1));
    if (opaque(offset)) ring.push(colour(offset));
  }
  if (ring.length * 10 >= SAMPLES * 9) {
    const sum = ring.reduce<Colour>((total, [red, green, blue]) => [total[0] + red, total[1] + green, total[2] + blue], [0, 0, 0]);
    const mean: Colour = [sum[0] / ring.length, sum[1] / ring.length, sum[2] / ring.length];
    const deviation =
      ring.reduce((total, [red, green, blue]) => total + (Math.abs(red - mean[0]) + Math.abs(green - mean[1]) + Math.abs(blue - mean[2])) / 3, 0) / ring.length;
    if (deviation <= UNIFORM) return [Math.trunc(mean[0]), Math.trunc(mean[1]), Math.trunc(mean[2])];
  }
  for (let y = 0; y < height; y += 2) for (let x = 0; x < width; x += 2) if (!opaque(at(x, y))) return WHITE;
  return colour(0);
}

async function download(url: string) {
  const response = await http.get(url, null);
  if (response.status === 404 || response.status === 403) return null;
  if (response.status !== 200) throw new Error(`Avatar request failed with status ${response.status}`);
  return isImage(response.body) ? response.body : null;
}

export function isImage(data: Uint8Array) {
  const head = String.fromCharCode(...data.subarray(0, 12));
  return (
    ["\x89PNG\r\n\x1a\n", "\xff\xd8\xff", "GIF87a", "GIF89a"].some((magic) => head.startsWith(magic)) ||
    (data.length > 12 && head.startsWith("RIFF") && head.slice(8, 12) === "WEBP")
  );
}


