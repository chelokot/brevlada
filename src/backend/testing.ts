import { $ } from "bun";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session } from "./imap";
import { certificates, Stream } from "./stream";

const decoder = new TextDecoder();

export async function scripted(responses: string) {
  let commands = "";
  const closed = Promise.withResolvers<void>();
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { open: (socket) => void socket.write(`a1 OK login\r\n${responses}`), data: (_, data) => void (commands += decoder.decode(data)), close: () => closed.resolve() },
  });
  const session = new Session(await Stream.connect("127.0.0.1", server.port));
  await session.login("test", "test");
  const sent = async () => {
    session.stream.close();
    await closed.promise;
    server.stop(true);
    return commands;
  };
  return { session, sent };
}

export async function certificate() {
  const directory = mkdtempSync(join(tmpdir(), "brevlada-tls-"));
  await $`openssl req -x509 -newkey rsa:2048 -nodes -keyout ${directory}/key.pem -out ${directory}/cert.pem -days 1 -subj /CN=localhost -addext subjectAltName=DNS:localhost,IP:127.0.0.1`.quiet();
  const [cert, key] = await Promise.all([Bun.file(`${directory}/cert.pem`).text(), Bun.file(`${directory}/key.pem`).text()]);
  rmSync(directory, { recursive: true });
  certificates().push(cert);
  return { cert, key };
}

const freePort = () => {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  server.stop(true);
  return server.port;
};

export async function dovecot() {
  const directory = mkdtempSync(join(tmpdir(), "brevlada-dovecot-"));
  chmodSync(directory, 0o755);
  const { cert, key } = await certificate();
  await Promise.all([Bun.write(`${directory}/cert.pem`, cert), Bun.write(`${directory}/key.pem`, key)]);
  const [imap, imaps] = [freePort(), freePort()];
  const user = (await $`id -u dovecot`.text()).trim();
  const config = `${directory}/dovecot.conf`;
  await Bun.write(
    config,
    `dovecot_config_version = 2.4.0
dovecot_storage_version = 2.4.0
base_dir = ${directory}/run
state_dir = ${directory}/state
log_path = ${directory}/log
protocols = imap
listen = 127.0.0.1
ssl = yes
ssl_server_cert_file = ${directory}/cert.pem
ssl_server_key_file = ${directory}/key.pem
auth_allow_cleartext = yes
first_valid_uid = ${user}
mail_driver = maildir
mail_path = ${directory}/mail/%{user}
mail_inbox_path = ${directory}/mail/%{user}
passdb static {
  password = secret
}
userdb static {
  fields {
    uid = ${user}
    gid = ${user}
    home = ${directory}/home/%{user}
  }
}
namespace inbox {
  inbox = yes
  separator = /
  mailbox Drafts {
    special_use = \\Drafts
    auto = create
  }
  mailbox Sent {
    special_use = \\Sent
    auto = create
  }
  mailbox Trash {
    special_use = \\Trash
    auto = create
  }
}
service imap-login {
  inet_listener imap {
    port = ${imap}
  }
  inet_listener imaps {
    port = ${imaps}
    ssl = yes
  }
}
`,
  );
  await $`mkdir -p ${directory}/mail ${directory}/home && chown ${user}:${user} ${directory}/mail ${directory}/home`.quiet();
  await Bun.spawn(["dovecot", "-c", config], { stdio: ["ignore", "ignore", "ignore"] }).exited;
  for (let attempt = 0; attempt < 100; attempt++) {
    const ready = await Stream.connect("127.0.0.1", imaps).then(
      (stream) => (stream.close(), true),
      () => false,
    );
    if (ready) break;
    await Bun.sleep(50);
  }
  const login = async (password = "secret", secure = true) => {
    const stream = await Stream.connect("127.0.0.1", secure ? imaps : imap);
    const session = new Session(stream);
    if (secure) await stream.upgrade("localhost");
    await session.greeting();
    if (!secure) await session.startTls("localhost");
    await session.login("test", password);
    return session;
  };
  const stop = async () => {
    process.kill(Number(await Bun.file(`${directory}/run/master.pid`).text()));
    rmSync(directory, { recursive: true });
  };
  return { login, stop, imap, imaps };
}
