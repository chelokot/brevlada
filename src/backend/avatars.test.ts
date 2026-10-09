import { expect, test } from "bun:test";
import Gdk from "gi://Gdk?version=4.0";
import GLib from "gi://GLib?version=2.0";
import type { Account } from "../models";
import {
  background,
  decode,
  detail,
  faviconDomains,
  faviconUrls,
  gravatarUrl,
  isFresh,
  isGoogle,
  isImage,
  MISS_TTL,
  photoUrl,
  pictureUrl,
  plate,
  sized,
  TTL,
} from "./avatars";

type Rgba = [number, number, number, number];

const account = (host: string, oauth2: boolean): Account => ({
  path: "",
  email: "me@gmail.com",
  name: "",
  host,
  username: "",
  port: 993,
  ssl: true,
  tls: false,
  oauth2,
  smtp: null,
});
const encoder = new TextEncoder();

function image(side: number, alpha: boolean, paint: (x: number, y: number) => Rgba | null) {
  const channels = alpha ? 4 : 3;
  const data = new Uint8Array(side * side * channels);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const colour = paint(x, y);
      if (colour) data.set(colour.slice(0, channels), (y * side + x) * channels);
    }
  }
  const format = alpha ? Gdk.MemoryFormat.R8G8B8A8 : Gdk.MemoryFormat.R8G8B8;
  return certain(
    Gdk.MemoryTexture.new(side, side, format, new GLib.Bytes(data), side * channels)
      .save_to_png_bytes()
      .get_data(),
  );
}

function certain<T>(value: T | null): T {
  if (value === null) throw new Error("Missing value");
  return value;
}

const solid = (side: number, alpha: boolean, colour: Rgba) => image(side, alpha, () => colour);
const enlarged = (side: number, scale: number) =>
  image(side * scale, false, (x, y) => [(Math.trunc(x / scale) * 40) % 256, (Math.trunc(y / scale) * 40) % 256, 90, 255]);
const drawn = (side: number, shape: (x: number, y: number) => [number, number, number] | null) =>
  image(side, true, (x, y) => {
    const colour = shape(x, y);
    return colour && [...colour, 255];
  });
const loaded = (bytes: Uint8Array | null) => certain(decode(certain(bytes)));
const first = (bytes: Uint8Array | null) => {
  const { pixels } = loaded(bytes);
  return [pixels.getUint8(0), pixels.getUint8(1), pixels.getUint8(2)];
};
const disc = drawn(128, (x, y) => ((x - 64) ** 2 + (y - 64) ** 2 <= 64 ** 2 ? [230, 2, 2] : null));
const quadrants = drawn(128, (x, y) => {
  if (Math.abs(x - 64) < 6 || Math.abs(y - 64) < 6) return null;
  return x < 64 ? (y < 64 ? [242, 80, 34] : [0, 164, 239]) : y < 64 ? [127, 186, 0] : [255, 185, 0];
});

test("hashes gravatar addresses the way gravatar documents", () => {
  const url = gravatarUrl("  MyEmailAddress@example.com ");
  expect(url.startsWith("https://gravatar.com/avatar/84059b07d4be67b806386c0aad8070a23f18836bbaae342275dc0a83414c32ee?")).toBeTrue();
  expect(url.endsWith("&d=404")).toBeTrue();
  expect(gravatarUrl("<MyEmailAddress@example.com>")).toBe(url);
});

test("only Google OAuth accounts offer a people credential", () => {
  expect([account("imap.gmail.com", true), account("IMAP.GOOGLEMAIL.COM", true), account("imap.google.com", true)].every(isGoogle)).toBeTrue();
  expect([account("imap.gmail.com", false), account("imap.notgmail.com", true), account("imap.fastmail.com", true)].some(isGoogle)).toBeFalse();
});

test("takes the matching contact photo and ignores generated ones", () => {
  const body = `{"results":[
    {"person":{"emailAddresses":[{"value":"other@example.com"}],"photos":[{"url":"https://lh3.googleusercontent.com/other=s100"}]}},
    {"person":{"emailAddresses":[{"value":"Ada@Example.com"}],"photos":[{"url":"https://lh3.googleusercontent.com/blank=s100","default":true},
      {"url":"https://lh3.googleusercontent.com/ada=s100"}]}}]}`;
  expect(photoUrl(body, "ada@example.com")).toBe("https://lh3.googleusercontent.com/ada=s128-c");
  expect(photoUrl(body, "nobody@example.com")).toBeNull();
  const onlyDefault = `{"results":[{"person":{"emailAddresses":[{"value":"ada@example.com"}],"photos":[{"url":"https://lh3.googleusercontent.com/blank","default":true}]}}]}`;
  expect(photoUrl(onlyDefault, "ada@example.com")).toBeNull();
  expect(photoUrl(`{"results":[]}`, "ada@example.com")).toBeNull();
  expect(photoUrl("not json", "ada@example.com")).toBeNull();
});

test("reads the account's own photo from its OpenID profile", () => {
  expect(pictureUrl(`{"sub":"1","email":"me@gmail.com","picture":"https://lh3.googleusercontent.com/a/ACg8oc=s96-c"}`)).toBe(
    "https://lh3.googleusercontent.com/a/ACg8oc=s128-c",
  );
  expect(pictureUrl(`{"sub":"1"}`)).toBeNull();
  expect(pictureUrl("not json")).toBeNull();
});

test("requests display sized images without corrupting URLs", () => {
  expect(
    ["https://host/photo=s100", "https://host/photo=s100-c-k", "https://host/photo", "https://host/a=b", "https://host/p?sz=50"].map((url) => sized(url, 128)),
  ).toEqual(["https://host/photo=s128-c", "https://host/photo=s128-c", "https://host/photo=s128-c", "https://host/a=b=s128-c", "https://host/p?sz=50"]);
});

test("asks for brand icons only where the domain identifies the sender", () => {
  expect(faviconUrls("github.com")).toEqual(["https://www.google.com/s2/favicons?domain=github.com&sz=256", "https://icon.horse/icon/github.com"]);
  expect(faviconUrls("redditmail.com")[0]).toBe("https://www.google.com/s2/favicons?domain=reddit.com&sz=256");
  expect(faviconDomains("noreply@github.com")).toEqual(["github.com"]);
  expect(faviconDomains("Sluzebnicek <sluzebnicek@ALZA.CZ>")).toEqual(["alza.cz"]);
  expect(faviconDomains("zed@mail.zed.dev")).toEqual(["mail.zed.dev", "zed.dev"]);
  expect(faviconDomains("a@deep.sub.example.co.uk")).toEqual(["deep.sub.example.co.uk", "example.co.uk", "co.uk"]);
  expect(faviconDomains("no-reply@offers.proton.me")).toEqual(["offers.proton.me", "proton.me"]);
  for (const email of ["someone@gmail.com", "someone@seznam.cz", "not-an-address", "root@localhost", ""]) expect(faviconDomains(email)).toEqual([]);
});

test("scores an enlarged favicon by the detail it actually has", () => {
  const stretched = enlarged(16, 16);
  const decoded = loaded(stretched);
  expect([decoded.width, decoded.height]).toEqual([256, 256]);
  expect(detail(stretched)).toBe(16);
  expect(detail(enlarged(64, 1))).toBe(64);
  expect(detail(enlarged(48, 2))).toBe(48);
  expect(detail(solid(64, false, [0x22, 0x33, 0x44, 0xff]))).toBe(1);
  expect(detail(encoder.encode("<!DOCTYPE html>"))).toBe(0);
});

test("rejects the grey letter tile services invent for unknown domains", () => {
  const square = (colour: Rgba) => image(64, false, (x, y) => (x >= 20 && x < 40 && y >= 20 && y < 40 ? colour : [226, 226, 226, 255]));
  expect(detail(square([120, 120, 120, 255]))).toBe(0);
  expect(detail(square([230, 0, 0, 255]))).toBeGreaterThanOrEqual(32);
});

test("plates a solid logo in its own colour so no bezel shows", () => {
  expect(background(loaded(disc))).toEqual([0xe6, 0x02, 0x02]);
  expect(background(loaded(quadrants))).toEqual([255, 255, 255]);
  const padded = drawn(128, (x, y) => (x >= 48 && x < 80 && y >= 48 && y < 80 ? [10, 10, 10] : null));
  expect(background(loaded(padded))).toEqual([255, 255, 255]);
});

test("pads only when the circle would cut into the logo", () => {
  const width = (bytes: Uint8Array) => loaded(plate(bytes)).width;
  expect(width(disc)).toBe(128);
  expect(width(quadrants)).toBeGreaterThanOrEqual(128 * Math.SQRT2 * 1.14);
  expect(width(drawn(128, (x, y) => (x >= 40 && x < 88 && y >= 40 && y < 88 ? [20, 20, 20] : [255, 255, 255])))).toBe(128);
  expect(width(drawn(128, () => [17, 71, 109]))).toBe(128);
});

test("plates brand icons opaquely and edge to edge", () => {
  const plated = certain(plate(solid(32, true, [0, 0, 0, 0])));
  const texture = Gdk.Texture.new_from_bytes(new GLib.Bytes(plated));
  expect([texture.get_width(), texture.get_height(), texture.get_format()]).toEqual([32, 32, Gdk.MemoryFormat.R8G8B8]);
  expect(first(plated)).toEqual([0xff, 0xff, 0xff]);
  const opaque = plate(solid(64, false, [0x10, 0x20, 0x30, 0xff]));
  expect(first(opaque)).toEqual([0x10, 0x20, 0x30]);
  expect(loaded(opaque).width).toBe(64);
  expect(first(plate(solid(48, true, [0xf2, 0x50, 0x22, 0xff])))).toEqual([0xf2, 0x50, 0x22]);
  expect(loaded(plate(solid(256, true, [0, 0, 0, 0]))).width).toBe(256);
  expect(plate(encoder.encode("<!DOCTYPE html>"))).toBeNull();
});

test("accepts image payloads and rejects error pages", () => {
  const raw = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0));
  for (const data of ["\x89PNG\r\n\x1a\n\x00", "\xff\xd8\xff\xe0", "GIF89a.....", "RIFF\0\0\0\0WEBPVP8 "]) expect(isImage(raw(data))).toBeTrue();
  for (const data of ["<!DOCTYPE html><html>", "", "RIFF\0\0\0\0WEBP"]) expect(isImage(raw(data))).toBeFalse();
});

test("keeps avatars longer than misses and distrusts future timestamps", () => {
  const now = 1_000_000_000;
  expect(isFresh(true, now - TTL + 1, now)).toBeTrue();
  expect(isFresh(true, now - TTL, now)).toBeFalse();
  expect(isFresh(false, now - MISS_TTL + 1, now)).toBeTrue();
  expect(isFresh(false, now - MISS_TTL, now)).toBeFalse();
  expect(isFresh(true, now + 60, now)).toBeFalse();
});
