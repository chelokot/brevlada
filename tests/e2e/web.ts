import { appendFileSync } from "node:fs";
import { avatar, logo } from "./corpus";

export function web(tls: { key: string; cert: string }, log: string, avatars: Map<string, string>, brands: Set<string>) {
  const image = (bytes: Uint8Array) => new Response(bytes, { headers: { "content-type": "image/png" } });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 443,
    tls,
    async fetch(request) {
      const url = new URL(request.url);
      appendFileSync(log, `${request.method} ${url.host}${url.pathname}${url.search} ${request.method === "POST" ? await request.text() : ""}\n`);
      const person = url.host === "gravatar.com" && avatars.get(url.pathname.split("/")[2] ?? "");
      if (person) return image(avatar(person));
      const domain = url.searchParams.get("domain");
      if (url.host === "www.google.com" && domain && brands.has(domain)) return image(logo(domain));
      if (/\.(png|jpg)$/.test(url.pathname)) return image(logo(url.pathname));
      if (request.method === "POST") return new Response("Unsubscribed");
      return new Response("Not found", { status: 404 });
    },
  });
  return { stop: () => server.stop(true) };
}
