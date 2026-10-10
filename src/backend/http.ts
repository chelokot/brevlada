import { version } from "../../package.json";
import { certificates } from "./stream";

const LIMIT = 4 * 1024 * 1024;
const TIMEOUT = 20_000;
const REDIRECTS = [301, 302, 303, 307, 308];
const AGENT = `Brevlada/${version}`;
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

export class Response {
  constructor(
    readonly status: number,
    readonly body: Uint8Array,
  ) {}

  text() {
    return decoder.decode(this.body);
  }
}

export async function get(url: string, token: string | null): Promise<Response> {
  const signal = AbortSignal.timeout(TIMEOUT);
  const headers = new Headers({ "User-Agent": AGENT });
  if (token !== null) headers.set("Authorization", `Bearer ${token}`);
  for (let redirects = 0; ; redirects++) {
    if (!url.startsWith("https://")) throw new Error(`configured for https only: ${url}`);
    const response = await fetch(url, { headers, redirect: "manual", signal, tls: { ca: certificates() } });
    const location = response.headers.get("Location");
    if (location === null || !REDIRECTS.includes(response.status)) return new Response(response.status, await read(response));
    if (redirects === 10) throw new Error("too many redirects");
    headers.delete("Authorization");
    url = new URL(location, url).href;
  }
}

async function read(response: globalThis.Response) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (response.body) {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > LIMIT) throw new Error(`the response body is larger than request limit: ${LIMIT}`);
      chunks.push(chunk);
    }
  }
  return Buffer.concat(chunks, size);
}

export type UnsubscribeResponse = "Done" | "UseBrowser";

export async function unsubscribe(url: string): Promise<UnsubscribeResponse> {
  if (!url.startsWith("https://")) throw new Error("One-click unsubscribe requires HTTPS");
  return unsubscribeWith(url, TIMEOUT);
}

export async function unsubscribeWith(url: string, timeout: number): Promise<UnsubscribeResponse> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "User-Agent": AGENT, "Content-Type": "application/x-www-form-urlencoded" },
    body: "List-Unsubscribe=One-Click",
    redirect: "manual",
    signal: AbortSignal.timeout(timeout),
    tls: { ca: certificates() },
  });
  if (REDIRECTS.includes(response.status)) return "UseBrowser";
  if (!response.ok) throw new Error(`Unsubscribe server returned HTTP ${response.status}`);
  return "Done";
}

export const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
