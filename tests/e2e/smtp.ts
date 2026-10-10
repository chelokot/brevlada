import { writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { TLSSocket } from "node:tls";

export type Credentials = { key: string; cert: string; password: string };

export function smtp(directory: string, { key, cert, password }: Credentials) {
  let stored = 0;
  const session = (socket: Socket, secure: boolean) => {
    let pending = "";
    let envelope: string[] = [];
    let data: string[] | null = null;
    let login: string[] | null = null;
    const reply = (...lines: string[]) =>
      socket.write(lines.map((line, index) => `${line.slice(0, 3)}${index < lines.length - 1 ? "-" : " "}${line.slice(4)}\r\n`).join(""));
    const authenticate = (payload: string) => {
      const [, user, secret] = Buffer.from(payload, "base64").toString().split("\0");
      envelope.push(`AUTH ${user}`);
      reply(secret === password ? "235 Authentication successful" : "535 Authentication failed");
    };
    const command = (line: string) => {
      if (data) {
        if (line !== ".") return data.push(line.startsWith(".") ? line.slice(1) : line);
        writeFileSync(
          `${directory}/${String(++stored).padStart(3, "0")}.eml`,
          `${envelope.map((entry) => `X-Envelope: ${entry}\r\n`).join("")}${data.join("\r\n")}\r\n`,
        );
        data = null;
        envelope = envelope.filter((entry) => entry.startsWith("AUTH"));
        return reply("250 Queued");
      }
      if (login) {
        login.push(Buffer.from(line, "base64").toString());
        if (login.length === 1) return reply("334 UGFzc3dvcmQ6");
        const [user = "", secret = ""] = login;
        login = null;
        return authenticate(Buffer.from(`\0${user}\0${secret}`).toString("base64"));
      }
      const [verb = "", ...rest] = line.split(" ");
      const argument = rest.join(" ");
      switch (verb.toUpperCase()) {
        case "EHLO":
        case "HELO":
          return reply("250 smtp.brevlada.test", "250 AUTH PLAIN LOGIN", ...(secure ? [] : ["250 STARTTLS"]), "250 8BITMIME");
        case "STARTTLS":
          reply("220 Ready to start TLS");
          socket.removeAllListeners("data");
          return session(new TLSSocket(socket, { isServer: true, key, cert }), true);
        case "AUTH":
          if (argument.toUpperCase() === "LOGIN") {
            login = [];
            return reply("334 VXNlcm5hbWU6");
          }
          return authenticate(argument.split(" ")[1] ?? "");
        case "MAIL":
        case "RCPT":
          envelope.push(argument);
          return reply("250 OK");
        case "DATA":
          data = [];
          return reply("354 End data with <CR><LF>.<CR><LF>");
        case "QUIT":
          reply("221 Bye");
          return socket.end();
        default:
          return reply("250 OK");
      }
    };
    socket.on("data", (chunk: Buffer) => {
      pending += chunk.toString("latin1");
      for (let end = pending.indexOf("\r\n"); end >= 0; end = pending.indexOf("\r\n")) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 2);
        command(line);
      }
    });
    socket.on("error", () => socket.destroy());
  };
  const listen = (port: number, implicit: boolean) =>
    createServer((socket) => {
      const stream = implicit ? new TLSSocket(socket, { isServer: true, key, cert }) : socket;
      session(stream, implicit);
      stream.write("220 smtp.brevlada.test ESMTP\r\n");
    }).listen(port, "127.0.0.1");
  const servers = [listen(465, true), listen(587, false)];
  return { stop: () => servers.forEach((server) => server.close()) };
}
