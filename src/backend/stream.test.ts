import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { Stream } from "./stream";
import { certificate } from "./testing";

const decoder = new TextDecoder();

test("keeps data a server sends immediately on connect", async () => {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open: (socket) => void socket.write("* OK ready\r\nsecond\r\npartial"), data() {} } });
  for (let attempt = 0; attempt < 100; attempt++) {
    const stream = await Stream.connect("127.0.0.1", server.port);
    expect(decoder.decode((await stream.line()) ?? new Uint8Array())).toBe("* OK ready\r\n");
    expect(decoder.decode((await stream.bytes(8)) ?? new Uint8Array())).toBe("second\r\n");
    stream.close();
    expect(decoder.decode((await stream.line()) ?? new Uint8Array())).toBe("partial");
    expect(await stream.line()).toBeNull();
  }
  server.stop(true);
});

test("reassembles large chunked payloads and applies write backpressure", async () => {
  const payload = new Uint8Array(8_000_000).map((_, index) => index % 256);
  const received: Buffer[] = [];
  const server = createServer((socket) =>
    socket.on("data", (chunk) => {
      received.push(Buffer.from(chunk));
      if (Buffer.concat(received).length === payload.length) socket.write(Buffer.concat([Buffer.from(`{${payload.length}}\r\n`), payload, Buffer.from("tail\r\n")]));
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const stream = await Stream.connect("127.0.0.1", typeof address === "object" && address ? address.port : 0);
  await stream.write(payload);
  expect(decoder.decode((await stream.line()) ?? new Uint8Array())).toBe(`{${payload.length}}\r\n`);
  expect(await stream.bytes(payload.length)).toEqual(payload);
  expect(decoder.decode((await stream.line()) ?? new Uint8Array())).toBe("tail\r\n");
  expect(Buffer.concat(received)).toEqual(Buffer.from(payload));
  stream.close();
  server.close();
});

test("upgrades to TLS after a plaintext exchange and reports refused connections", async () => {
  const { cert, key } = await certificate();
  const server = Bun.listen<{ upgraded: boolean }>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        socket.data = { upgraded: false };
        socket.write("220 ready\r\n");
      },
      data(socket) {
        if (socket.data.upgraded) return;
        socket.data.upgraded = true;
        socket.write("220 go\r\n");
        socket.upgradeTLS({ tls: { cert, key }, socket: { data: (secure, chunk) => void secure.write(`echo ${decoder.decode(chunk)}`) } });
      },
    },
  });
  const stream = await Stream.connect("127.0.0.1", server.port);
  expect(decoder.decode((await stream.line()) ?? new Uint8Array())).toBe("220 ready\r\n");
  await stream.write("STARTTLS\r\n");
  expect(decoder.decode((await stream.line()) ?? new Uint8Array())).toBe("220 go\r\n");
  await stream.upgrade("localhost");
  await stream.write("ping\r\n");
  expect(decoder.decode((await stream.line()) ?? new Uint8Array())).toBe("echo ping\r\n");
  stream.close();
  server.stop(true);
  await expect(Stream.connect("127.0.0.1", server.port)).rejects.toThrow();
});
