import { $, type Subprocess } from "bun";
import { dlopen } from "bun:ffi";
import { appendFileSync, existsSync, openSync } from "node:fs";
import { cp, mkdir, readdir, rm, stat, utimes } from "node:fs/promises";
import { brands, domains, messages, pdf, people, photo, writeMaildir } from "./corpus";
import type { GoaAccount, GoaConfig } from "./goa";
import { smtp } from "./smtp";
import { web } from "./web";

const root = "/tmp/brevlada-e2e";
const screen = { width: 1600, height: 1000 };
export const park = [screen.width - 1, screen.height - 1] as const;
const epoch = Date.UTC(2026, 9, 1, 10) / 1000;
const ports = [143, 993, 465, 587, 443];
const opened = ["application/pdf", "image/png", "application/zip", "text/calendar", "text/plain"];
const tls = `${root}/tls`;
const servers = ["imap", "smtp"].flatMap((service) => ["brevlada.test", "work.test"].map((domain) => `${service}.${domain}`));
const hosts = [
  ...servers,
  ...domains,
  "gravatar.com",
  "www.google.com",
  "icon.horse",
  "www.googleapis.com",
  "people.googleapis.com",
  "lh3.googleusercontent.com",
];

export type Setup = { accounts: GoaAccount[]; imap: "up" | "down" | "frozen"; config: Record<string, unknown>; large: number };

const account = (id: string, email: string, password: string, ssl: boolean): GoaAccount => ({
  id,
  identity: email,
  password,
  mail: {
    EmailAddress: email,
    ImapHost: `imap.${email.split("@")[1]}`,
    ImapUserName: email,
    ImapUseSsl: ssl,
    ImapUseTls: !ssl,
    SmtpSupported: true,
    SmtpHost: `smtp.${email.split("@")[1]}`,
    SmtpUserName: email,
    SmtpUseSsl: ssl,
    SmtpUseTls: !ssl,
    SmtpUseAuth: true,
    SmtpAuthPlain: ssl,
    SmtpAuthLogin: !ssl,
    SmtpAuthXoauth2: false,
  },
});

export const accounts = { alice: account("alice", "alice@brevlada.test", "secret", true), bob: account("bob", "bob@work.test", "secret", false) };
export const defaults: Setup = { accounts: [accounts.alice, accounts.bob], imap: "up", config: {}, large: 0 };

async function trust() {
  await mkdir(tls, { recursive: true });
  const dates = ["-not_before", "20200101000000Z", "-not_after", "20400101000000Z"];
  if (!existsSync(`${tls}/ca.pem`))
    await $`openssl req -x509 -newkey rsa:2048 -nodes -keyout ${tls}/ca.key -out ${tls}/ca.pem -subj /CN=Brevlada-E2E-CA ${dates}`.quiet();
  await $`openssl req -newkey rsa:2048 -nodes -keyout ${tls}/server.key -out ${tls}/server.csr -subj /CN=imap.brevlada.test`.quiet();
  await Bun.write(`${tls}/san.ext`, `subjectAltName=${hosts.map((host) => `DNS:${host}`).join(",")}\n`);
  await $`openssl x509 -req -in ${tls}/server.csr -CA ${tls}/ca.pem -CAkey ${tls}/ca.key -out ${tls}/server.pem ${dates} -extfile ${tls}/san.ext`.quiet();
  const anchor = "/etc/pki/ca-trust/source/anchors/brevlada-e2e.pem";
  if (!existsSync(anchor) || (await Bun.file(anchor).text()) !== (await Bun.file(`${tls}/ca.pem`).text())) {
    await cp(`${tls}/ca.pem`, anchor);
    await $`update-ca-trust`;
  }
  const mapped = (await Bun.file("/etc/hosts").text()).split("\n");
  const missing = hosts.filter((host) => !mapped.includes(`127.0.0.1 ${host}`));
  if (missing.length) appendFileSync("/etc/hosts", missing.map((host) => `127.0.0.1 ${host}\n`).join(""));
}

async function corpus(large: number) {
  const dir = `${root}/corpus-${large}`;
  await rm(dir, { recursive: true, force: true });
  await writeMaildir(dir, messages(large));
  return dir;
}

const libc = dlopen("libc.so.6", {
  prctl: { args: ["i32", "u64", "u64", "u64", "u64"], returns: "i32" },
  waitpid: { args: ["i32", "ptr", "i32"], returns: "i32" },
}).symbols;
libc.prctl(36, 1, 0, 0, 0);
const tracked = new Set<number>();

const kill = (group: number, signal: NodeJS.Signals) => {
  try {
    process.kill(-group, signal);
  } catch {}
};

async function reap() {
  for (const entry of await readdir("/proc")) {
    const stat = await Bun.file(`/proc/${entry}/stat`)
      .text()
      .catch(() => "");
    const [state, parent] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (state === "Z" && Number(parent) === process.pid && !tracked.has(Number(entry))) libc.waitpid(Number(entry), null, 1);
  }
}

let trusted: Promise<void> | undefined;
const corpora: Record<number, Promise<string>> = {};

const dovecotConfig = (dir: string, mail: string) => `dovecot_config_version = 2.4.5
dovecot_storage_version = 2.4.5
base_dir = ${dir}/run
state_dir = ${dir}/state
log_path = ${dir}/dovecot.log
listen = 127.0.0.1
protocols {
  imap = yes
}
default_internal_user = dovecot
default_internal_group = dovecot
default_login_user = dovenull
mail_driver = maildir
mail_path = ${mail}/%{user}
mail_home = ${mail}/%{user}
namespace inbox {
  inbox = yes
  separator = /
${["Sent", "Drafts", "Archive", "Junk", "Trash"].map((name) => `  mailbox ${name} {\n    special_use = \\${name}\n  }\n`).join("")}}
auth_failure_delay = 0
passdb static {
  password = secret
}
userdb static {
  fields {
    uid = nobody
    gid = nobody
  }
}
ssl = yes
ssl_server {
  cert_file = ${tls}/server.pem
  key_file = ${tls}/server.key
}
service imap-login {
  inet_listener imap {
    port = 143
  }
  inet_listener imaps {
    port = 993
    ssl = yes
  }
}
`;

const bus = (
  socket: string,
) => `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:path=${socket}</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
`;

const settings = `[Settings]
gtk-enable-animations=false
gtk-cursor-blink=false
gtk-overlay-scrolling=false
gtk-font-name=Adwaita Sans 11
gtk-icon-theme-name=Adwaita
gtk-decoration-layout=:close
gtk-xft-antialias=1
gtk-xft-hinting=1
gtk-xft-hintstyle=hintslight
gtk-xft-rgba=none
gtk-xft-dpi=98304
`;

async function line(process: Subprocess<"ignore", "pipe", number>) {
  const reader = process.stdout.getReader();
  let text = "";
  while (!text.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`Process ${process.pid} exited before becoming ready, see services.log`);
    text += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  return text.trim();
}

async function until(condition: () => Promise<boolean>, what: string, timeout = 30_000) {
  for (const deadline = Date.now() + timeout; !(await condition()); await Bun.sleep(50))
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
}

const reachable = (port: number) =>
  Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {} } }).then(
    (socket) => (socket.end(), true),
    () => false,
  );

export async function launch(name: string, app: string[], setup: Setup) {
  const busy = (await Promise.all(ports.map(async (port) => (await reachable(port)) && port))).filter(Boolean);
  if (busy.length) throw new Error(`Ports ${busy.join(", ")} are in use: is another e2e environment running?`);
  await (trusted ??= trust());
  const maildir = await (corpora[setup.large] ??= corpus(setup.large));
  const dir = `${root}/run/${name}`;
  const home = `${dir}/home`;
  await rm(dir, { recursive: true, force: true });
  await mkdir(`${dir}/smtp`, { recursive: true });
  await mkdir(`${dir}/xdg`, { mode: 0o700 });
  await mkdir(`${dir}/bin`, { recursive: true });
  await Bun.write(`${home}/.config/gtk-4.0/settings.ini`, settings);
  for (const [file, content] of Object.entries(setup.config)) await Bun.write(`${home}/.config/brevlada/${file}`, JSON.stringify(content));
  await Bun.write(`${dir}/bin/xdg-open`, `#!/bin/sh\necho "$@" >> ${dir}/opened.log\n`);
  await $`chmod +x ${dir}/bin/xdg-open`;
  await Bun.write(
    `${home}/.local/share/applications/opener.desktop`,
    `[Desktop Entry]\nType=Application\nName=Opener\nExec=${dir}/bin/xdg-open %f\nMimeType=${opened.join(";")};\n`,
  );
  await Bun.write(`${home}/.config/mimeapps.list`, `[Default Applications]\n${opened.map((type) => `${type}=opener.desktop\n`).join("")}`);
  await Bun.write(`${home}/Documents/trip-photo.png`, photo(640, 360));
  await Bun.write(`${home}/Documents/meeting-notes.txt`, "Agenda\n- Release 0.2\n- Offsite\n");
  await Bun.write(`${home}/Documents/invoice-2026-10.pdf`, pdf("Invoice", 200));
  for (const path of [...(await readdir(`${home}/Documents`)).map((file) => `${home}/Documents/${file}`), `${home}/Documents`, home])
    await utimes(path, epoch, epoch);
  if (setup.imap !== "down") {
    await cp(maildir, `${dir}/mail`, { recursive: true });
    await $`chown -R nobody:nobody ${dir}/mail`;
    await Bun.write(`${dir}/dovecot/dovecot.conf`, dovecotConfig(`${dir}/dovecot`, `${dir}/mail`));
  }
  const services = openSync(`${dir}/services.log`, "w");
  const cleanup: (() => unknown)[] = [];
  const teardown = async () => {
    for (const step of cleanup.reverse()) await step();
    await Bun.sleep(200);
    await reap();
  };
  const track = <T extends Subprocess>(child: T) => {
    tracked.add(child.pid);
    child.exited.then(() => tracked.delete(child.pid));
    return child;
  };
  const spawn = <T extends Subprocess>(child: T) => (cleanup.push(() => (child.kill("SIGTERM"), child.exited)), track(child));
  try {
    const xvfb = spawn(
      Bun.spawn(["Xvfb", "-displayfd", "1", "-screen", "0", `${screen.width}x${screen.height}x24`, "-nolisten", "tcp", "-noreset", "-dpi", "96"], {
        stdout: "pipe",
        stderr: services,
      }),
    );
    const display = `:${await line(xvfb)}`;
    await Bun.write(`${dir}/bus.conf`, bus(`${dir}/bus`));
    const daemon = spawn(
      Bun.spawn(["dbus-daemon", `--config-file=${dir}/bus.conf`, "--nofork", "--nopidfile", "--print-address=1"], {
        stdout: "pipe",
        stderr: services,
      }),
    );
    const session = { DISPLAY: display, DBUS_SESSION_BUS_ADDRESS: await line(daemon), HOME: home, PATH: `${dir}/bin:${process.env.PATH}` };
    spawn(Bun.spawn(["openbox", "--sm-disable"], { env: { ...process.env, ...session }, stdout: "ignore", stderr: services }));
    const goa: GoaConfig = { accounts: setup.accounts, notifications: `${dir}/notifications.jsonl` };
    await Bun.write(`${dir}/goa.json`, JSON.stringify(goa));
    await line(
      spawn(
        Bun.spawn(["bun", `${import.meta.dir}/goa.ts`, `${dir}/goa.json`], {
          cwd: `${import.meta.dir}/../..`,
          env: { ...process.env, ...session },
          stdout: "pipe",
          stderr: services,
        }),
      ),
    );
    const credentials = { key: await Bun.file(`${tls}/server.key`).text(), cert: await Bun.file(`${tls}/server.pem`).text() };
    cleanup.push(smtp(`${dir}/smtp`, { ...credentials, password: "secret" }).stop);
    cleanup.push(
      web(credentials, `${dir}/web.log`, new Map(people.map((person) => [new Bun.CryptoHasher("sha256").update(person).digest("hex"), person])), brands).stop,
    );
    const dovecot =
      setup.imap === "down"
        ? null
        : track(Bun.spawn(["dovecot", "-F", "-c", `${dir}/dovecot/dovecot.conf`], { detached: true, stdout: "ignore", stderr: services }));
    if (dovecot) {
      cleanup.push(async () => {
        kill(dovecot.pid, "SIGCONT");
        dovecot.kill("SIGTERM");
        await dovecot.exited;
        kill(dovecot.pid, "SIGKILL");
      });
      await until(() => reachable(993), "dovecot");
      if (setup.imap === "frozen") process.kill(-dovecot.pid, "SIGSTOP");
    }
    await until(
      async () =>
        (
          await $`xprop -root _NET_SUPPORTING_WM_CHECK`
            .env({ ...process.env, ...session })
            .nothrow()
            .text()
        ).includes("window id"),
      "openbox",
    );
    const environment = {
      ...process.env,
      ...session,
      XDG_CONFIG_HOME: `${home}/.config`,
      XDG_DATA_HOME: `${home}/.local/share`,
      XDG_CACHE_HOME: `${home}/.cache`,
      XDG_STATE_HOME: `${home}/.local/state`,
      XDG_RUNTIME_DIR: `${dir}/xdg`,
      GDK_BACKEND: "x11",
      GSK_RENDERER: "cairo",
      GSK_DEBUG: "full-redraw",
      GTK_A11Y: "none",
      NO_AT_BRIDGE: "1",
      GSETTINGS_BACKEND: "memory",
      ADW_DEBUG_COLOR_SCHEME: "prefer-light",
      WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS: "1",
      NODE_EXTRA_CA_CERTS: `${tls}/ca.pem`,
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      TZ: "UTC",
      LD_PRELOAD: "/usr/lib64/libfaketime.so.1",
      FAKETIME: "@2026-10-09 14:00:00",
      FAKETIME_DONT_FAKE_MONOTONIC: "1",
      FAKETIME_DONT_RESET: "1",
    };
    const x = (...args: (string | number)[]) => $`xdotool ${args.map(String)}`.env(environment).quiet();
    const activity = async () =>
      (
        await Promise.all(
          ["emails.db", "emails.db-wal"].map((file) =>
            stat(`${home}/.local/share/brevlada/${file}`).then(
              ({ mtimeMs, size }) => `${mtimeMs}:${size}`,
              () => "",
            ),
          ),
        )
      ).join();
    const capture = async () => new Uint8Array(await $`magick import -silent -window root png:-`.env(environment).arrayBuffer());
    await x("mousemove", ...park);
    const started = performance.now();
    const log = openSync(`${dir}/app.log`, "w");
    const application = track(Bun.spawn(app, { cwd: `${home}/Documents`, env: environment, detached: true, stdout: log, stderr: log }));
    cleanup.push(async () => {
      await $`xdotool key ctrl+q`.env(environment).nothrow().quiet();
      await Promise.race([application.exited, Bun.sleep(5000)]);
      kill(application.pid, "SIGKILL");
      await application.exited;
    });
    return {
      dir,
      display,
      environment,
      started,
      application,
      x,
      capture,
      key: (...keys: string[]) => x("key", "--clearmodifiers", "--delay", 40, ...keys),
      type: (text: string) => $`xdotool type --delay 15 ${text}`.env(environment).quiet(),
      click: (left: number, top: number, button = 1) => x("mousemove", left, top, "click", button, "mousemove", ...park),
      window: (title: string, timeout = 30_000) =>
        until(
          async () => (await $`xdotool search --onlyvisible --name ${`^${title}$`}`.env(environment).nothrow().quiet()).exitCode === 0,
          `window "${title}"`,
          timeout,
        ),
      async settle(quiet = 1000, timeout = 60_000) {
        let previous = { screen: await capture(), cache: await activity() };
        let stable = performance.now();
        for (const deadline = Date.now() + timeout; Date.now() < deadline; ) {
          await Bun.sleep(100);
          const current = { screen: await capture(), cache: await activity() };
          if (Buffer.compare(current.screen, previous.screen) !== 0 || current.cache !== previous.cache) stable = performance.now();
          else if (performance.now() - stable >= quiet) return current.screen;
          previous = current;
        }
        throw new Error(`Screen and mail cache did not settle within ${timeout}ms`);
      },
      deliver: (user: string, file: string, raw: string) =>
        Bun.write(`${dir}/mail/${user}/new/${file}`, Buffer.from(raw, "latin1")).then(() => $`chown -R nobody:nobody ${dir}/mail/${user}/new`),
      thaw: () => dovecot && process.kill(-dovecot.pid, "SIGCONT"),
      lines: async (file: string) =>
        (await Bun.file(`${dir}/${file}`).exists()) ? (await Bun.file(`${dir}/${file}`).text()).replaceAll(dir, "$RUN").trim().split("\n") : [],
      smtp: async () => Promise.all((await readdir(`${dir}/smtp`)).sort().map((file) => Bun.file(`${dir}/smtp/${file}`).text())),
      stop: teardown,
    };
  } catch (error) {
    await teardown();
    throw error;
  }
}

export type Desktop = Awaited<ReturnType<typeof launch>>;

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flags = args.slice(
    0,
    args.findIndex((arg) => !arg.startsWith("--")),
  );
  const imap = flags.includes("--down") ? "down" : flags.includes("--frozen") ? "frozen" : "up";
  const desktop = await launch("manual", args.slice(flags.length), { ...defaults, imap });
  console.log(`DISPLAY=${desktop.display} DBUS_SESSION_BUS_ADDRESS=${desktop.environment.DBUS_SESSION_BUS_ADDRESS} (state in ${desktop.dir})`);
  process.on("SIGINT", () => desktop.stop().then(() => process.exit(0)));
  await desktop.application.exited;
  await desktop.stop();
}
