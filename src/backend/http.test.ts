import { expect, test } from "bun:test";
import { encode, get, unsubscribe, unsubscribeWith } from "./http";
import { certificate } from "./testing";

function unsubscribeServer(status: string, headers = "") {
  const request = Promise.withResolvers<string>();
  let received = "";
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket, chunk) {
        received += chunk.toString();
        const end = received.indexOf("\r\n\r\n");
        const length = Number(/^content-length: *(\d+)/im.exec(received.slice(0, end))?.[1] ?? 0);
        if (end < 0 || received.length < end + 4 + length) return;
        socket.end(`HTTP/1.1 ${status}\r\nContent-Length: 0\r\nConnection: close\r\n${headers}\r\n`);
        request.resolve(received);
      },
    },
  });
  return { url: `http://127.0.0.1:${server.port}/unsubscribe?token=opaque`, request: request.promise.finally(() => server.stop(true)) };
}

test("sends one-click post with form body and no browser credentials", async () => {
  const { url, request } = unsubscribeServer("204 No Content");
  expect(await unsubscribeWith(url, 5000)).toBe("Done");
  const [headers = "", body] = (await request).split("\r\n\r\n");
  expect(headers.startsWith("POST /unsubscribe?token=opaque HTTP/1.1\r\n")).toBe(true);
  expect(headers.toLowerCase()).toContain("content-type: application/x-www-form-urlencoded");
  expect(body).toBe("List-Unsubscribe=One-Click");
  for (const forbidden of ["cookie:", "authorization:", "referer:"]) expect(headers.toLowerCase()).not.toContain(forbidden);
});

test("reports http errors", async () => {
  for (const status of ["405 Method Not Allowed", "500 Internal Server Error"]) {
    const { url, request } = unsubscribeServer(status);
    await expect(unsubscribeWith(url, 5000)).rejects.toThrow(`Unsubscribe server returned HTTP ${status.slice(0, 3)}`);
    await request;
  }
});

test("redirects require browser completion without following the post", async () => {
  for (const status of ["301 Moved Permanently", "302 Found", "303 See Other", "307 Temporary Redirect", "308 Permanent Redirect"]) {
    const { url, request } = unsubscribeServer(status, "Location: http://127.0.0.1:1/should-not-be-contacted\r\n");
    expect(await unsubscribeWith(url, 5000)).toBe("UseBrowser");
    expect((await request).startsWith("POST ")).toBe(true);
  }
});

test("refuses non-https one-click endpoints", async () => {
  await expect(unsubscribe("http://127.0.0.1:1/unsubscribe")).rejects.toThrow("requires HTTPS");
});

test("encodes every reserved character in an address", () => {
  expect(encode("a.b-c_d~e")).toBe("a.b-c_d~e");
  expect(encode("first+tag@example.com")).toBe("first%2Btag%40example.com");
  expect(encode("a b&c=d?e/f")).toBe("a%20b%26c%3Dd%3Fe%2Ff");
  expect(encode("é!'()*")).toBe("%C3%A9%21%27%28%29%2A");
});

test("gets over trusted https with bounded bodies and a strict redirect policy", async () => {
  const { cert, key } = await certificate();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { cert, key },
    fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === "/moved") return Response.redirect("/final", 302);
      if (pathname === "/loop") return Response.redirect("/loop", 307);
      if (pathname === "/insecure") return Response.redirect("http://127.0.0.1:1/", 301);
      if (pathname === "/large") return new Response(new Uint8Array(4 * 1024 * 1024 + 1));
      return Response.json({ authorization: request.headers.get("authorization"), agent: request.headers.get("user-agent") }, { status: pathname === "/missing" ? 404 : 200 });
    },
  });
  const base = `https://127.0.0.1:${server.port}`;
  const direct = await get(`${base}/final`, "token");
  expect([direct.status, JSON.parse(direct.text())]).toEqual([200, { authorization: "Bearer token", agent: "Brevlada/0.1.0" }]);
  const moved = await get(`${base}/moved`, "token");
  expect([moved.status, JSON.parse(moved.text())]).toEqual([200, { authorization: null, agent: "Brevlada/0.1.0" }]);
  expect((await get(`${base}/missing`, null)).status).toBe(404);
  await expect(get(`${base}/loop`, null)).rejects.toThrow("too many redirects");
  await expect(get(`${base}/insecure`, null)).rejects.toThrow("configured for https only: http://127.0.0.1:1/");
  await expect(get(`${base}/large`, null)).rejects.toThrow("the response body is larger than request limit: 4194304");
  await expect(get(`http://127.0.0.1:${server.port}/final`, null)).rejects.toThrow("configured for https only");
  server.stop(true);
});
