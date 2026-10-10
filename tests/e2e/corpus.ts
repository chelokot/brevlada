import { mkdir, utimes } from "node:fs/promises";
import { parseArgs } from "node:util";
import { deflateSync } from "node:zlib";

export const now = Date.UTC(2026, 9, 9, 14, 0, 0);
const minutes = (count: number) => now - count * 60_000;
const hours = (count: number) => minutes(count * 60);
const days = (count: number, hour: number) => Date.UTC(2026, 9, 9 - count, hour, 17);

function encodePng(width: number, height: number, rows: Uint8Array) {
  const chunk = (type: string, data: Uint8Array) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const frame = Buffer.alloc(8);
    frame.writeUInt32BE(data.length, 0);
    frame.writeUInt32BE(Bun.hash.crc32(body), 4);
    return Buffer.concat([frame.subarray(0, 4), body, frame.subarray(4)]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return new Uint8Array(
    Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", new Uint8Array())]),
  );
}

export function png(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]) {
  const rows = new Uint8Array(height * (width * 3 + 1));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rows.set(pixel(x, y), y * (width * 3 + 1) + 1 + x * 3);
  return encodePng(width, height, rows);
}

const hue = (seed: string) => [...seed].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 360, 7);
const rgb = (h: number, s: number, l: number): [number, number, number] => {
  const channel = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [channel(0), channel(8), channel(4)];
};
export const avatar = (seed: string) =>
  png(128, 128, (x, y) =>
    (x - 64) ** 2 + (y - 52) ** 2 < 24 ** 2 || (x - 64) ** 2 + (y - 140) ** 2 < 56 ** 2 ? rgb(hue(seed), 0.35, 0.92) : rgb(hue(seed), 0.55, 0.45),
  );
export const logo = (seed: string) =>
  png(256, 256, (x, y) =>
    (x - 128) ** 2 + (y - 128) ** 2 < 80 ** 2 ? rgb(hue(seed) + (x + y) / 4, 0.7, 0.5) : (x * y) % 64 < 32 ? [255, 255, 255] : rgb(hue(seed), 0.2, 0.95),
  );
export const photo = (width: number, height: number) =>
  png(width, height, (x, y) => rgb((x / width) * 240 + (y / height) * 60, 0.65, 0.35 + (0.4 * y) / height));
const noise = (length: number, seed: number) => Uint8Array.from({ length }, () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 24);
const speckle = (side: number, seed: number) =>
  encodePng(
    side,
    side,
    noise(side * (side * 3 + 1), seed).map((byte, index) => (index % (side * 3 + 1) ? byte : 0)),
  );

function zip(name: string, data: Uint8Array) {
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(10, 4);
  local.writeUInt32LE(Bun.hash.crc32(data), 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.set(local.subarray(4, 30), 6);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + name.length, 12);
  end.writeUInt32LE(30 + name.length + data.length, 16);
  return new Uint8Array(Buffer.concat([local, Buffer.from(name), data, central, Buffer.from(name), end]));
}

export const pdf = (title: string, lines: number) =>
  new TextEncoder().encode(
    `%PDF-1.4\n1 0 obj <</Type /Catalog /Pages 2 0 R>> endobj\n2 0 obj <</Type /Pages /Kids [3 0 R] /Count 1>> endobj\n3 0 obj <</Type /Page /Parent 2 0 R /MediaBox [0 0 595 842]>> endobj\n${Array.from({ length: lines }, (_, index) => `% ${title} line ${index}\n`).join("")}trailer <</Root 1 0 R>>\n%%EOF\n`,
  );

type Charset = "utf-8" | "koi8-r" | "windows-1251" | "iso-8859-2" | "iso-2022-jp";
type Encoding = "quoted-printable" | "base64" | "8bit" | "7bit";
const binary = (data: Uint8Array) => Buffer.from(data).toString("latin1");
const legacy = new Map<Charset, Map<string, string>>();
function table(charset: Charset) {
  const known = legacy.get(charset);
  if (known) return known;
  const decoder = new TextDecoder(charset);
  const codes =
    charset === "iso-2022-jp"
      ? Array.from({ length: 94 * 94 }, (_, index) => String.fromCharCode(0x21 + Math.floor(index / 94), 0x21 + (index % 94)))
      : Array.from({ length: 128 }, (_, index) => String.fromCharCode(0x80 + index));
  const wrap = (code: string) => (charset === "iso-2022-jp" ? `\x1b$B${code}\x1b(B` : code);
  const created = new Map(codes.map((code) => [decoder.decode(Buffer.from(wrap(code), "latin1")), code]));
  legacy.set(charset, created);
  return created;
}
function bytes(text: string, charset: Charset) {
  if (charset === "utf-8") return binary(new TextEncoder().encode(text));
  const map = table(charset);
  const code = (char: string) => {
    const found = map.get(char);
    if (found === undefined) throw new Error(`"${char}" is not encodable in ${charset}`);
    return found;
  };
  if (charset !== "iso-2022-jp") return [...text].map((char) => (char < "\x80" ? char : code(char))).join("");
  let wide = false;
  const encoded = [...text].map((char) => (char < "\x80" === !wide ? "" : ((wide = !wide), wide ? "\x1b$B" : "\x1b(B")) + (wide ? code(char) : char)).join("");
  return wide ? `${encoded}\x1b(B` : encoded;
}

const base64 = (data: string) =>
  (
    Buffer.from(data, "latin1")
      .toString("base64")
      .match(/.{1,76}/g) ?? []
  ).join("\r\n");
const quoted = (data: string) =>
  data
    .split("\r\n")
    .map((line) => {
      let output = "";
      let length = 0;
      for (let index = 0; index < line.length; index++) {
        const code = line.charCodeAt(index);
        const token =
          code > 126 || code === 61 || (code === 32 && index === line.length - 1) ? `=${code.toString(16).toUpperCase().padStart(2, "0")}` : line.charAt(index);
        if (length + token.length > 75) ((output += "=\r\n"), (length = 0));
        output += token;
        length += token.length;
      }
      return output;
    })
    .join("\r\n");
const transfer = (data: string, encoding: Encoding) => (encoding === "base64" ? base64(data) : encoding === "quoted-printable" ? quoted(data) : data);
const crlf = (text: string) => text.replace(/\r?\n/g, "\r\n");
const word = (value: string, charset: Charset = "utf-8", mode: "B" | "Q" = "B") =>
  `=?${charset}?${mode}?${mode === "B" ? Buffer.from(bytes(value, charset), "latin1").toString("base64") : [...bytes(value, charset)].map((char) => (/[A-Za-z0-9]/.test(char) ? char : char === " " ? "_" : `=${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`)).join("")}?=`;

const entity = (headers: string[], body: string) => `${headers.join("\r\n")}\r\n\r\n${body}`;
const multipart = (subtype: string, ...parts: string[]) => {
  const boundary = `brevlada-${subtype}-${Bun.hash(parts.join("")).toString(36)}`;
  return entity(
    [`Content-Type: multipart/${subtype}; boundary="${boundary}"`],
    `${parts.map((part) => `--${boundary}\r\n${part}\r\n`).join("")}--${boundary}--`,
  );
};
const content = (type: string, body: string, charset: Charset, encoding: Encoding) =>
  entity([`Content-Type: ${type}; charset=${charset}`, `Content-Transfer-Encoding: ${encoding}`], transfer(bytes(crlf(body), charset), encoding));
const text = (body: string, charset: Charset = "utf-8", encoding: Encoding = "quoted-printable") => content("text/plain", body, charset, encoding);
const html = (body: string, charset: Charset = "utf-8", encoding: Encoding = "quoted-printable") =>
  content("text/html", `<!DOCTYPE html>\n<html><head><meta charset="${charset}"></head><body>\n${body}\n</body></html>`, charset, encoding);
const file = (name: string, type: string, data: Uint8Array, ...headers: string[]) =>
  entity([`Content-Type: ${type}; name="${name}"`, "Content-Transfer-Encoding: base64", ...headers], base64(binary(data)));
const attachment = (name: string, type: string, data: Uint8Array) => file(name, type, data, `Content-Disposition: attachment; filename="${name}"`);
const inline = (id: string, name: string, data: Uint8Array) =>
  file(name, "image/png", data, `Content-ID: <${id}>`, `Content-Disposition: inline; filename="${name}"`);
const ics = (method: string, ...events: string[][]) =>
  [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Brevlada//E2E//EN",
    `METHOD:${method}`,
    ...events.flatMap((event) => ["BEGIN:VEVENT", ...event, "END:VEVENT"]),
    "END:VCALENDAR",
  ].join("\r\n");
const calendar = (method: string, body: string) =>
  entity([`Content-Type: text/calendar; charset=utf-8; method=${method}`, "Content-Transfer-Encoding: 8bit"], bytes(body, "utf-8"));
const jsonld = (value: object) =>
  `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", ...(Array.isArray(value) ? { "@graph": value } : value) })}</script>`;

type Person = { name: string; email: string };
const person = (name: string, email: string): Person => ({ name, email });
const ascii = (value: string) => /^[\x20-\x7e]*$/.test(value);
const address = ({ name, email }: Person) => (name ? `${/^[A-Za-z0-9 ]+$/.test(name) ? name : ascii(name) ? `"${name}"` : word(name)} <${email}>` : email);

type Thread = { id: string; references: string[] };
export type Message = Thread & { user: string; folder: string; date: number; flags: string; subject: string; raw: string };
type Mail = {
  user: Person;
  folder: string;
  flags: string;
  date: number;
  from: Person;
  to: Person[];
  cc: Person[];
  subject: string;
  id: string;
  parent: Thread | null;
  headers: string[];
};

function mail(header: Mail, body: string): Message {
  const references = header.parent ? [...header.parent.references, header.parent.id] : [];
  const lines = [
    `From: ${address(header.from)}`,
    `To: ${header.to.map(address).join(", ")}`,
    ...(header.cc.length ? [`Cc: ${header.cc.map(address).join(", ")}`] : []),
    `Subject: ${ascii(header.subject) ? header.subject : word(header.subject)}`,
    `Date: ${new Date(header.date).toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${header.id}>`,
    ...(header.parent ? [`In-Reply-To: <${header.parent.id}>`, `References: ${references.map((id) => `<${id}>`).join(" ")}`] : []),
    "MIME-Version: 1.0",
    ...header.headers,
  ];
  return {
    user: header.user.email,
    folder: header.folder,
    date: header.date,
    flags: header.flags,
    id: header.id,
    subject: header.subject,
    references,
    raw: `${lines.join("\r\n")}\r\n${body}`,
  };
}

export const alice = person("Alice Lindqvist", "alice@brevlada.test");
const bob = person("Bob Ekström", "bob@work.test");
const carol = person("Carol Svensson", "carol@brevlada.test");
const erik = person("Erik Nilsson", "erik@brevlada.test");
const gustav = person("Gustav Holm", "gustav@brevlada.test");
const frida = person("Frida Berg", "frida@kontor.test");
const dmitri = person("Дмитрий Волков", "dmitri@pochta.test");
const haruki = person("佐藤 春樹", "haruki@yubin.test");
const northwind = person("Northwind Weekly", "news@northwind.test");
const hemma = person("Hemma", "orders@hemma.test");
const rail = person("Nordic Rail", "tickets@nordrail.test");
const skylark = person("SkyLark Air", "booking@skylark.test");
const aurora = person("Aurora Hall", "tickets@aurorahall.test");
const fjordbus = person("Fjord Bus", "noreply@fjordbus.test");
const lucky = person("Prize Center", "winner@lucky.test");
const meetup = person("Stockholm JS", "events@meetup.test");
const ci = person("CI", "ci@builds.work.test");
const hr = person("People Team", "hr@work.test");
const dana = person("Dana Whitfield", "dana@acme.test");

export const users = [alice.email, bob.email];
export const standard = ["INBOX", "Sent", "Drafts", "Archive", "Junk", "Trash"];
export const people = [carol.email, erik.email, frida.email];
export const brands = new Set(["northwind.test", "hemma.test", "skylark.test", "nordrail.test"]);
export const domains = [
  "brevlada.test",
  "work.test",
  "northwind.test",
  "cdn.northwind.test",
  "hemma.test",
  "parcelo.test",
  "nordrail.test",
  "skylark.test",
  "aurorahall.test",
  "fjordbus.test",
  "kontor.test",
  "lucky.test",
  "meet.brevlada.test",
  "meetup.test",
];

const received = (user: Person) => ({ user, folder: "INBOX", flags: "S", to: [user], cc: [] as Person[], parent: null, headers: [] as string[] });
const sent = (user: Person, to: Person[]) => ({ ...received(user), folder: "Sent", from: user, to });
const stamp = (date: number) => new Date(date).toUTCString().replace(":00 GMT", " UTC");
const quote = (parent: Message, author: Person, body: string) =>
  `On ${stamp(parent.date)}, ${author.name} <${author.email}> wrote:\n${body
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n")}`;

function aliceMail(): Message[] {
  const inbox = received(alice);
  const planning = [
    "Hi Alice,\n\nI drafted the scope for Brevlada 0.2. The big items are the new compose window,\nparcel tracking cards and faster search across accounts.\n\nCould you check whether we can ship by the end of October?\n\nCarol",
    "Thanks Carol! The scope looks right. Search is the riskiest part, I would\nstart there and keep parcel cards as a stretch goal.",
    "<p>Agreed. I moved search to the first sprint and asked Erik to review the compose mockups.</p><p>Do you want a design review this week or next?</p>",
    "Next week works better, the mockups need another pass.",
    "Perfect, I will book it. Also: the release notes draft is in the shared folder.\nPlease add the keyboard shortcuts section.\n\nCarol",
    "Done, shortcuts are documented. I also listed the known issues with IMAP IDLE.",
    "<p>Great work! The notes read well. One small thing: can we mention the new <b>Archive</b> shortcut?</p>",
    "Release candidate is tagged, the build is green on all runners.\nShall we announce it on Monday?",
  ];
  const thread: Message[] = [];
  planning.forEach((body, index) => {
    const own = index % 2 === 1 && index < 7;
    const parent = thread.at(-1) ?? null;
    const subject = `${parent ? "Re: " : ""}Release planning for 0.2`;
    const date = [days(6, 9), days(6, 11), days(5, 10), days(5, 14), days(3, 9), days(2, 16), hours(20), minutes(35)][index]!;
    const header = own
      ? { ...sent(alice, [carol]), date, subject, id: `planning-${index + 1}@brevlada.test`, parent }
      : {
          ...inbox,
          flags: index === 7 ? "" : index === 6 ? "S" : "RS",
          cc: index === 7 ? [erik] : [],
          date,
          from: carol,
          subject,
          id: `planning-${index + 1}@brevlada.test`,
          parent,
        };
    const quoted = parent ? `\n\n${quote(parent, own ? carol : alice, planning[index - 1]!.replace(/<[^>]+>/g, ""))}` : "";
    const part = body.startsWith("<")
      ? multipart(
          "alternative",
          text(body.replace(/<[^>]+>/g, "")),
          html(
            `${body}\n<div class="gmail_quote"><div>${parent ? stamp(parent.date) : ""}, ${alice.name} wrote:</div><blockquote type="cite">${planning[index - 1]!.replace(/\n/g, "<br>")}</blockquote></div>`,
          ),
        )
      : text(body + quoted);
    thread.push(mail(header, part));
  });
  const designReview = [
    "UID:design-review-2026-10-14@brevlada.test",
    "SEQUENCE:0",
    "DTSTAMP:20261008T081700Z",
    "DTSTART:20261014T130000Z",
    "DTEND:20261014T140000Z",
    "SUMMARY:Design review: compose window",
    "LOCATION:Room Ekorren",
    "DESCRIPTION:Walkthrough of the new compose window mockups.",
    "URL:https://meet.brevlada.test/design-review",
    "ORGANIZER;CN=Erik Nilsson:mailto:erik@brevlada.test",
    "ATTENDEE;CN=Alice Lindqvist;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:alice@brevlada.test",
    "ATTENDEE;CN=Carol Svensson;PARTSTAT=ACCEPTED:mailto:carol@brevlada.test",
    "ATTENDEE;CN=Frida Berg;PARTSTAT=TENTATIVE:mailto:frida@kontor.test",
    "ATTENDEE;CN=Gustav Holm;PARTSTAT=DECLINED:mailto:gustav@brevlada.test",
  ];
  const offsite = (attendees: string[], stampedAt: string) => [
    "UID:team-offsite-2026@brevlada.test",
    "SEQUENCE:0",
    `DTSTAMP:${stampedAt}`,
    "DTSTART;VALUE=DATE:20261022",
    "DTEND;VALUE=DATE:20261024",
    "SUMMARY:Team offsite",
    "LOCATION:Fjällstugan\\, Åre",
    "ORGANIZER;CN=Alice Lindqvist:mailto:alice@brevlada.test",
    ...attendees,
  ];
  const invitation = mail(
    { ...sent(alice, [carol, erik, frida]), date: days(4, 10), subject: "Invitation: Team offsite", id: "offsite-invite@brevlada.test" },
    multipart(
      "alternative",
      text("You are invited to the team offsite in Åre, October 22–24."),
      calendar(
        "REQUEST",
        ics(
          "REQUEST",
          offsite(
            [carol, erik, frida].map(({ name, email }) => `ATTENDEE;CN=${name};PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${email}`),
            "20261005T101700Z",
          ),
        ),
      ),
    ),
  );
  const response = (from: Person, status: string, date: number, stampedAt: string) =>
    mail(
      {
        ...inbox,
        flags: status === "ACCEPTED" ? "S" : "",
        date,
        from,
        subject: `${status === "ACCEPTED" ? "Accepted" : "Declined"}: Team offsite`,
        id: `offsite-${from.email}`,
        parent: invitation,
      },
      multipart(
        "alternative",
        text(`${from.name} has ${status.toLowerCase()} this invitation.`),
        calendar("REPLY", ics("REPLY", offsite([`ATTENDEE;CN=${from.name};PARTSTAT=${status}:mailto:${from.email}`], stampedAt))),
      ),
    );
  const photos = mail(
    { ...inbox, flags: "F", date: hours(3), from: frida, cc: [carol], subject: "Photos from the workshop", id: "workshop-photos@kontor.test" },
    multipart(
      "mixed",
      multipart(
        "related",
        html(
          `<p>Hi Alice,</p><p>here are the photos and materials from Tuesday's workshop. The whiteboard turned out great:</p><p><img src="cid:team-photo@kontor.test" width="480" alt="Team photo"></p><p>Frida</p>`,
        ),
        inline("team-photo@kontor.test", "team.png", photo(480, 270)),
      ),
      attachment("agenda.pdf", "application/pdf", pdf("Workshop agenda", 1600)),
      attachment("whiteboard.png", "image/png", photo(1200, 800)),
      attachment("slides-source.zip", "application/zip", zip("slides.key", noise(1_300_000, 42))),
      attachment(
        "follow-up.ics",
        "text/calendar",
        new TextEncoder().encode(
          ics("PUBLISH", [
            "UID:workshop-follow-up@kontor.test",
            "DTSTAMP:20261009T110000Z",
            "DTSTART:20261020T080000Z",
            "DTEND:20261020T090000Z",
            "SUMMARY:Workshop follow-up",
            "LOCATION:Kontor, floor 3",
          ]),
        ),
      ),
    ),
  );
  const newsletter = (issue: number, date: number, flags: string, oneClick: boolean) =>
    mail(
      {
        ...inbox,
        flags,
        date,
        from: northwind,
        subject: `Northwind Weekly #${issue}: ${["Trail running", "Rain gear", "Autumn hiking"][issue - 41]}`,
        id: `weekly-${issue}@northwind.test`,
        headers: oneClick
          ? [
              "List-Unsubscribe: <https://northwind.test/unsubscribe/alice?list=weekly>, <mailto:unsubscribe@northwind.test?subject=unsubscribe>",
              "List-Unsubscribe-Post: List-Unsubscribe=One-Click",
            ]
          : ["List-Unsubscribe: <mailto:unsubscribe@northwind.test?subject=unsubscribe>"],
      },
      multipart(
        "alternative",
        text(`Northwind Weekly #${issue}\n\nThis week's picks for the outdoors. View online: https://northwind.test/weekly/${issue}`),
        html(
          `<table width="600" align="center" style="font-family:sans-serif"><tr><td><img src="https://cdn.northwind.test/weekly/${issue}/hero.png" width="600" height="200" alt="Northwind"></td></tr>` +
            `<tr><td><h1 style="color:#1c5d3a">Issue #${issue}</h1><p>Fresh gear for shorter days. Members save 15% until Sunday.</p></td></tr>` +
            `<tr><td><img src="https://cdn.northwind.test/weekly/${issue}/jacket.png" width="180" height="120"> <img src="https://cdn.northwind.test/weekly/${issue}/boots.png" width="180" height="120"></td></tr>` +
            `<tr><td><a href="https://northwind.test/weekly/${issue}">Read online</a> · <a href="https://northwind.test/unsubscribe/alice">Unsubscribe</a></td></tr></table>`,
        ),
      ),
    );
  const order = { "@type": "Order", orderNumber: "HM-48213", merchant: { "@type": "Organization", name: "Hemma" } };
  const parcel = (status: object) => ({
    "@type": "ParcelDelivery",
    trackingNumber: "PX48213SE",
    carrier: { "@type": "Organization", name: "Parcelo" },
    itemShipped: { "@type": "Product", name: "Oak desk lamp" },
    deliveryAddress: { "@type": "PostalAddress", streetAddress: "Vasagatan 12", addressLocality: "Stockholm" },
    expectedArrivalFrom: "2026-10-09",
    expectedArrivalUntil: "2026-10-10",
    trackingUrl: "https://parcelo.test/track/PX48213SE",
    partOfOrder: order,
    deliveryStatus: status,
  });
  const shipment = (subject: string, date: number, flags: string, markup: string, line: string) =>
    mail(
      { ...inbox, flags, date, from: hemma, subject, id: `${subject.toLowerCase().replace(/\W+/g, "-")}@hemma.test` },
      html(`${markup}<h2>${subject}</h2><p>${line}</p><p>Order HM-48213 · Oak desk lamp</p>`),
    );
  const reservation = (type: string, number: string, status: string, trip: object, tickets: object[], extra: object = {}) =>
    tickets.map((ticket) => ({
      "@type": type,
      reservationNumber: number,
      reservationStatus: `https://schema.org/Reservation${status}`,
      reservationFor: trip,
      ...ticket,
      ...extra,
    }));
  const passenger = (name: string, number: string, token: string, seat: object) => ({
    underName: { "@type": "Person", name },
    reservedTicket: { "@type": "Ticket", ticketNumber: number, ticketToken: token, ticketedSeat: { "@type": "Seat", ...seat } },
  });
  const train = {
    "@type": "TrainTrip",
    trainNumber: "SJ 421",
    trainCompany: { "@type": "Organization", name: "Nordic Rail" },
    departureStation: { "@type": "TrainStation", name: "Stockholm Central" },
    arrivalStation: { "@type": "TrainStation", name: "Göteborg Central" },
    departureTime: "2026-10-16T07:05:00+02:00",
    arrivalTime: "2026-10-16T10:12:00+02:00",
  };
  const flight = (number: string, from: [string, string], to: [string, string], departure: string, arrival: string) => ({
    "@type": "Flight",
    flightNumber: number,
    airline: { "@type": "Airline", name: "SkyLark Air", iataCode: "SK" },
    departureAirport: { "@type": "Airport", name: from[0], iataCode: from[1] },
    arrivalAirport: { "@type": "Airport", name: to[0], iataCode: to[1] },
    departureTime: departure,
    arrivalTime: arrival,
  });
  const concert = {
    "@type": "MusicEvent",
    name: "Aurora Strings: Autumn Concert",
    startDate: "2026-10-24T19:30:00+02:00",
    endDate: "2026-10-24T21:45:00+02:00",
    organizer: { "@type": "Organization", name: "Aurora Hall" },
    location: {
      "@type": "Place",
      name: "Aurora Hall",
      address: { "@type": "PostalAddress", streetAddress: "Kungsgatan 8", addressLocality: "Uppsala", addressCountry: "SE" },
    },
  };
  const bus = {
    "@type": "BusTrip",
    busNumber: "430",
    busCompany: { "@type": "Organization", name: "Fjord Bus" },
    departureBusStop: { "@type": "BusStop", name: "Bergen Busstasjon" },
    arrivalBusStop: { "@type": "BusStop", name: "Voss Stasjon" },
    departureTime: "2026-10-19T08:30:00+02:00",
    arrivalTime: "2026-10-19T10:05:00+02:00",
  };
  const booking = (from: Person, subject: string, date: number, data: object[], body: string) =>
    mail(
      { ...inbox, date, from, subject, id: `${subject.toLowerCase().replace(/\W+/g, "-")}@${from.email.split("@")[1]}` },
      html(`${jsonld(data)}<h2>${subject}</h2>${body}`),
    );
  const standup = Array.from(
    { length: 30 },
    (_, index) => `Standup ${index + 1}: ${["deploys", "search index", "compose bugs"][index % 3]} on track, no blockers.`,
  ).reduce<Message[]>((list, body, index) => {
    const header = {
      date: days(15 - Math.floor(index / 2), 9 + (index % 2)),
      subject: `${index ? "Re: " : ""}Daily standup`,
      id: `standup-${index + 1}@brevlada.test`,
      parent: list.at(-1) ?? null,
    };
    return [...list, mail(index % 2 ? { ...sent(alice, [gustav]), ...header } : { ...inbox, ...header, from: gustav }, text(body))];
  }, []);
  return [
    ...thread,
    ...standup,
    mail(
      { ...inbox, flags: "", date: minutes(90), from: carol, subject: "Fika on Friday? ☕", id: "fika@brevlada.test" },
      text(
        "Cinnamon buns are on me this time. 15:00 in the kitchen?\n\nCarol\n\nOn Thu, 08 Oct 2026 16:05 UTC, Alice Lindqvist <alice@brevlada.test> wrote:\n> Who brings the buns this week?\n> I brought them last Friday.",
      ),
    ),
    mail(
      { ...inbox, flags: "F", date: days(1, 8), from: erik, subject: "Invitation: Design review: compose window", id: "design-review@brevlada.test" },
      multipart(
        "alternative",
        text("Erik Nilsson invites you to Design review: compose window on Wednesday, October 14 at 13:00 UTC."),
        calendar("REQUEST", ics("REQUEST", designReview)),
      ),
    ),
    invitation,
    response(carol, "ACCEPTED", days(4, 12), "20261005T121700Z"),
    response(erik, "DECLINED", days(3, 15), "20261006T151700Z"),
    photos,
    mail(
      {
        ...sent(alice, [frida]),
        folder: "Drafts",
        flags: "DS",
        date: minutes(50),
        subject: "Re: Photos from the workshop",
        id: "draft-photos@brevlada.test",
        parent: photos,
      },
      multipart(
        "mixed",
        text(
          `Thanks Frida! I picked my favourites, see the attachment.\n\n${quote(photos, frida, "here are the photos and materials from Tuesday's workshop.")}`,
        ),
        attachment("favourites.png", "image/png", photo(320, 200)),
      ),
    ),
    mail(
      { ...inbox, date: days(5, 13), from: erik, subject: "Cancelled: Friday demo", id: "friday-demo-cancel@brevlada.test" },
      multipart(
        "alternative",
        text("The Friday demo is cancelled, we will show the new compose window at the design review instead."),
        calendar(
          "CANCEL",
          ics("CANCEL", [
            "UID:friday-demo@brevlada.test",
            "SEQUENCE:1",
            "DTSTAMP:20261004T131700Z",
            "DTSTART:20261009T150000Z",
            "DTEND:20261009T153000Z",
            "SUMMARY:Friday demo",
            "STATUS:CANCELLED",
            "ORGANIZER;CN=Erik Nilsson:mailto:erik@brevlada.test",
            "ATTENDEE;CN=Alice Lindqvist;PARTSTAT=NEEDS-ACTION:mailto:alice@brevlada.test",
          ]),
        ),
      ),
    ),
    mail(
      { ...inbox, date: days(16, 12), from: meetup, subject: "Stockholm JS Meetup: Autumn edition", id: "autumn-2026@meetup.test" },
      html(
        jsonld({
          "@type": "Event",
          "@id": "https://meetup.test/events/autumn-2026",
          name: "Stockholm JS Meetup: Autumn edition",
          startDate: "2026-10-21T18:00:00+02:00",
          endDate: "2026-10-21T21:00:00+02:00",
          location: { "@type": "Place", name: "Kontoret, Sveavägen 44, Stockholm" },
          organizer: { "@type": "Organization", name: "Stockholm JS" },
          potentialAction: ["Yes", "Maybe", "No"].map((answer) => ({
            "@type": "RsvpAction",
            rsvpResponse: `https://schema.org/RsvpResponse${answer}`,
            target: `https://meetup.test/rsvp/autumn-2026?answer=${answer.toLowerCase()}`,
          })),
        }) + "<h2>Autumn edition</h2><p>Talks about Bun, GTK and building mail clients. Pizza included.</p>",
      ),
    ),
    mail(
      { ...inbox, flags: "FRS", date: days(2, 7), from: gustav, subject: "Parking spots next week", id: "parking@brevlada.test" },
      text("The garage is closed Monday to Wednesday. Use the visitor spots behind building B.\n\nGustav"),
    ),
    mail(
      { ...inbox, date: days(1, 16), from: dmitri, subject: word("Отчёт за сентябрь", "koi8-r"), id: "report-september@pochta.test" },
      text(
        "Алиса, добрый день!\n\nОтчёт за сентябрь готов: выручка выросла на 12%, расходы в пределах плана.\nПодробности во вложении к следующему письму.\n\nС уважением,\nДмитрий",
        "koi8-r",
        "8bit",
      ),
    ),
    mail(
      {
        ...inbox,
        flags: "",
        date: hours(26),
        from: dmitri,
        subject: word("Приглашение на конференцию «Почта 2026»", "windows-1251", "Q"),
        id: "conference@pochta.test",
      },
      html(
        "<h2>Приглашение</h2><p>Уважаемая Алиса, приглашаем вас выступить на конференции <b>«Почта 2026»</b> в Санкт-Петербурге.</p><blockquote>Тема доклада: «Быстрый поиск по почте»</blockquote>",
        "windows-1251",
      ),
    ),
    mail(
      { ...inbox, date: days(3, 3), from: haruki, subject: word("来週の打ち合わせについて", "iso-2022-jp"), id: "meeting@yubin.test" },
      text("アリスさん\n\n来週の打ち合わせは水曜日の午後三時からでお願いします。\n資料は前日までに送ります。\n\n佐藤", "iso-2022-jp", "7bit"),
    ),
    newsletter(41, days(14, 7), "S", true),
    newsletter(42, days(7, 7), "S", false),
    newsletter(43, hours(5), "", true),
    shipment(
      "Your Hemma order HM-48213 has shipped",
      days(3, 11),
      "S",
      jsonld(parcel({ "@type": "DeliveryEvent", name: "Shipped", startDate: "2026-10-06T11:20:00+02:00", location: "Malmö" })),
      "Good news! Your order is on its way.",
    ),
    shipment(
      "Your parcel is on its way",
      days(1, 7),
      "S",
      `<div itemscope itemtype="https://schema.org/ParcelDelivery"><meta itemprop="trackingNumber" content="PX48213SE"><div itemprop="carrier" itemscope itemtype="https://schema.org/Organization"><meta itemprop="name" content="Parcelo"></div><div itemprop="itemShipped" itemscope itemtype="https://schema.org/Product"><meta itemprop="name" content="Oak desk lamp"></div><meta itemprop="expectedArrivalUntil" content="2026-10-10"><meta itemprop="trackingUrl" content="https://parcelo.test/track/PX48213SE"><div itemprop="partOfOrder" itemscope itemtype="https://schema.org/Order"><meta itemprop="orderNumber" content="HM-48213"></div><div itemprop="deliveryStatus" itemscope itemtype="https://schema.org/DeliveryEvent"><meta itemprop="name" content="Arrived at sorting centre"><meta itemprop="startDate" content="2026-10-08T06:40:00+02:00"><meta itemprop="location" content="Jönköping"></div></div>`,
      "Your parcel arrived at the sorting centre.",
    ),
    shipment(
      "Out for delivery: HM-48213",
      hours(4),
      "",
      jsonld(parcel([{ "@type": "DeliveryEvent", name: "Out for delivery", startDate: "2026-10-09T08:05:00+02:00", location: "Stockholm" }])),
      "Your parcel will be delivered today between 14:00 and 18:00.",
    ),
    booking(
      rail,
      "Your tickets: Stockholm Central → Göteborg Central",
      days(2, 12),
      reservation(
        "TrainReservation",
        "NR-58213",
        "Confirmed",
        train,
        [
          passenger("Alice Lindqvist", "NR-58213-1", "qrCode:NR5821301", { seatSection: "Car 4", seatNumber: "12" }),
          passenger("Carol Svensson", "NR-58213-2", "qrCode:NR5821302", { seatSection: "Car 4", seatNumber: "13" }),
        ],
        { url: "https://nordrail.test/booking/NR-58213" },
      ),
      "<p>Have a pleasant journey!</p>",
    ),
    booking(
      skylark,
      "Booking confirmation SKL7Q2",
      days(8, 15),
      [
        ...reservation(
          "FlightReservation",
          "SKL7Q2",
          "Confirmed",
          flight("SK 1427", ["Stockholm Arlanda", "ARN"], ["Reykjavík Keflavík", "KEF"], "2026-10-23T09:40:00+02:00", "2026-10-23T11:05:00+00:00"),
          [passenger("Alice Lindqvist", "0742158833401", "barcode:M1LINDQVIST/ALICE ESKL7Q2", { seatNumber: "14A" })],
          { checkinUrl: "https://skylark.test/checkin/SKL7Q2" },
        ),
        ...reservation(
          "FlightReservation",
          "SKL7Q2",
          "Confirmed",
          flight("SK 1428", ["Reykjavík Keflavík", "KEF"], ["Stockholm Arlanda", "ARN"], "2026-10-27T13:15:00+00:00", "2026-10-27T18:30:00+01:00"),
          [passenger("Alice Lindqvist", "0742158833402", "barcode:M1LINDQVIST/ALICE ESKL7Q2R", { seatNumber: "9C" })],
          { checkinUrl: "https://skylark.test/checkin/SKL7Q2" },
        ),
      ],
      "<p>Your trip to Reykjavík is confirmed.</p>",
    ),
    booking(
      aurora,
      "Your tickets for Aurora Strings",
      days(10, 18),
      reservation("EventReservation", "AH-2210", "Confirmed", concert, [
        passenger("Alice Lindqvist", "AH-2210-14", "aztecCode:AH221014", { seatSection: "Parterre", seatRow: "7", seatNumber: "14" }),
        passenger("Alice Lindqvist", "AH-2210-15", "aztecCode:AH221015", { seatSection: "Parterre", seatRow: "7", seatNumber: "15" }),
      ]),
      "<p>Doors open at 19:00.</p>",
    ),
    booking(
      fjordbus,
      "Cancelled: Bergen → Voss",
      days(12, 10),
      reservation("BusReservation", "FB-1093", "Cancelled", bus, [
        passenger("Alice Lindqvist", "FB-1093-1", "https://fjordbus.test/ticket/FB-1093", { seatNumber: "22" }),
      ]),
      "<p>Your booking has been cancelled and refunded.</p>",
    ),
    mail(
      { ...inbox, folder: "Archive", date: days(400, 9), from: erik, subject: "Onboarding checklist", id: "onboarding@brevlada.test" },
      text("Welcome aboard! Here is your onboarding checklist:\n\n1. Laptop\n2. Accounts\n3. Fika"),
    ),
    mail(
      { ...inbox, folder: "Archive", date: days(120, 13), from: carol, subject: "Q2 retrospective notes", id: "retro-q2@brevlada.test" },
      text("Notes from the Q2 retrospective are attached to the wiki page."),
    ),
    mail(
      { ...inbox, folder: "Junk", flags: "", date: days(1, 4), from: lucky, subject: "Congratulations! You have been selected", id: "prize@lucky.test" },
      html('<h1>You won!</h1><p><img src="https://lucky.test/prize.png" width="300"></p><p>Claim your prize now.</p>'),
    ),
    mail({ ...inbox, folder: "Trash", date: days(30, 12), from: gustav, subject: "Lunch order", id: "lunch@brevlada.test" }, text("Pizza or sushi on Friday?")),
    mail(
      { ...inbox, folder: "Projects/Brevlada", date: days(9, 10), from: carol, subject: "Icon drafts for the toolbar", id: "icons@brevlada.test" },
      multipart("mixed", text("First drafts of the toolbar icons, feedback welcome."), attachment("icons.png", "image/png", logo("icons"))),
    ),
    mail(
      { ...inbox, folder: "Projects/Website", flags: "", date: days(15, 14), from: frida, subject: "Website copy review", id: "website-copy@kontor.test" },
      text("Could you review the landing page copy by Friday?"),
    ),
  ];
}

export const arrival = mail(
  { ...received(alice), flags: "", date: now, from: carol, subject: "Demo moved to 15:30", id: "demo-moved@brevlada.test" },
  text("Heads up: the demo moved to 15:30 because the projector is busy until then.\n\nCarol"),
);

function bobMail(): Message[] {
  const inbox = received(bob);
  const lunch = mail(
    { ...inbox, date: hours(26), from: carol, subject: "Lunch on Thursday?", id: "lunch-thursday@brevlada.test" },
    text("Hi Bob, are you free for lunch on Thursday? There is a new ramen place near the office.\n\nCarol"),
  );
  return [
    lunch,
    mail(
      { ...sent(bob, [carol]), date: hours(25), subject: "Re: Lunch on Thursday?", id: "lunch-reply@work.test", parent: lunch },
      text(`Sounds great, 12:00?\n\n${quote(lunch, carol, "Hi Bob, are you free for lunch on Thursday?")}`),
    ),
    mail(
      { ...inbox, flags: "", date: minutes(15), from: ci, subject: "Build #1287 failed on main", id: "build-1287@builds.work.test" },
      text("Pipeline #1287 failed at stage test.\n\nFailed jobs:\n  - unit (search::senders)\n\nhttps://ci.work.test/pipelines/1287"),
    ),
    mail(
      { ...inbox, date: hours(2), from: ci, subject: "Build #1286 passed on main", id: "build-1286@builds.work.test" },
      text("Pipeline #1286 passed in 6m 12s."),
    ),
    mail(
      {
        ...inbox,
        flags: "",
        date: hours(5),
        from: northwind,
        subject: "Northwind Weekly #43: Autumn hiking",
        id: "weekly-43-bob@northwind.test",
        headers: ["List-Unsubscribe: <https://northwind.test/unsubscribe/bob?list=weekly>", "List-Unsubscribe-Post: List-Unsubscribe=One-Click"],
      },
      html('<h1>Issue #43</h1><p>Autumn hiking essentials.</p><img src="https://cdn.northwind.test/weekly/43/hero.png" width="600" height="200">'),
    ),
    mail(
      { ...inbox, date: days(20, 9), from: hr, subject: "Holiday schedule 2027", id: "holidays-2027@work.test" },
      multipart(
        "mixed",
        text("Please find the 2027 holiday schedule attached."),
        attachment("holidays-2027.pdf", "application/pdf", pdf("Holidays 2027", 300)),
      ),
    ),
    mail(
      { ...inbox, folder: "Clients/Acme", date: days(6, 15), from: dana, subject: "Acme kickoff notes", id: "kickoff@acme.test" },
      text("Thanks for the kickoff! Notes and next steps are below.\n\n- Weekly sync on Tuesdays\n- First milestone: November 6"),
    ),
  ];
}

const filler = (
  "the of and to in for on with as at by from about this that it is was be are we you they our your their have has had will would could should can " +
  "not all more some any other new first last next good great small large early late again also just still only very well here there when where how " +
  "time day week month year work team people group part place point way case fact thing idea question answer note list item change result"
).split(" ");
const keywords = (
  "invoice meeting alice budget deadline report schedule project review release contract payment delivery order travel conference " +
  "update proposal agenda quarterly feedback design draft client customer support server backup migration launch training holiday"
).split(" ");
const legacyText: Record<"koi8-r" | "windows-1251" | "iso-8859-2", string[]> = {
  "koi8-r": [
    "Добрый день, Алиса!",
    "Счёт за услуги во вложении.",
    "Встреча перенесена на четверг.",
    "Пожалуйста, подтвердите получение.",
    "Отчёт будет готов к пятнице.",
  ],
  "windows-1251": [
    "Здравствуйте, коллеги!",
    "Совещание по бюджету в среду в 10:00.",
    "Прошу проверить договор до конца недели.",
    "Счёт оплачен, спасибо.",
    "Повестка встречи ниже.",
  ],
  "iso-8859-2": [
    "Dobrý den, Alice!",
    "Faktura je v příloze.",
    "Schůzka bude ve čtvrtek ráno.",
    "Prosimy o potwierdzenie spotkania.",
    "Zażółć gęślą jaźń, proszę o fakturę.",
  ],
};

export function* generated(count: number): Generator<Message> {
  let state = 20261009;
  const random = () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
  const between = (low: number, high: number) => low + Math.floor(random() * (high - low));
  const pick = <T>(items: readonly T[]) => items[between(0, items.length)]!;
  const zipf = (size: number) => {
    const cumulative: number[] = [];
    let total = 0;
    for (let rank = 1; rank <= size; rank++) cumulative.push((total += 1 / rank ** 0.9));
    return () => {
      const target = random() * total;
      return cumulative.findIndex((value) => value >= target);
    };
  };
  const first =
    "Anna Erik Lars Karin Johan Maria Per Eva Nils Sara Olof Ingrid Mikael Emma Henrik Lena Oskar Elin Viktor Maja Jonas Hanna Peter Sofia Daniel Julia Magnus Linnea Fredrik Klara".split(
      " ",
    );
  const last =
    "Andersson Johansson Karlsson Nilsson Eriksson Larsson Olsson Persson Svensson Gustafsson Pettersson Jonsson Jansson Hansson Bengtsson Lindberg Berg Lund Holm Strand".split(
      " ",
    );
  const humans = Array.from({ length: 240 }, (_, index) => {
    const name = `${first[index % first.length]} ${last[(index * 7 + Math.floor(index / 30)) % last.length]}`;
    return person(name, `${name.toLowerCase().replace(" ", ".")}${index}@${pick(["mail.test", "post.test", "kontor.test", "firma.test", "inbox.test"])}`);
  });
  const companies = Array.from({ length: 60 }, (_, index) => {
    const name = `${"North Blue Green Silver Bright Swift Polar Urban Nordic Iron Golden Fjord".split(" ")[index % 12]}${"wind peak line market works post hub field stream craft".split(" ")[Math.floor(index / 12)]}`;
    return person(name, `news@${name.toLowerCase()}.test`);
  });
  const human = zipf(humans.length);
  const company = zipf(companies.length);
  const sentence = () => {
    const words = Array.from({ length: between(6, 16) }, () => pick(random() < 0.004 ? keywords : filler));
    return `${words.join(" ").replace(/^./, (char) => char.toUpperCase())}${pick([".", ".", ".", "?", "!"])}`;
  };
  const prose = (size: number) => {
    const paragraphs: string[] = [];
    for (let length = 0; length < size; length += paragraphs.at(-1)!.length)
      paragraphs.push(
        Array.from({ length: between(2, 6) }, sentence)
          .join(" ")
          .replace(/(.{1,72})(\s+|$)/g, "$1\n"),
      );
    return paragraphs.join("\n");
  };
  const attachments = (index: number) =>
    Array.from({ length: between(1, 3) }, (_, position) =>
      random() < 0.5
        ? attachment(`invoice-${index}-${position}.pdf`, "application/pdf", pdf(`Invoice ${index}`, between(700, 7000)))
        : attachment(`photo-${index}-${position}.png`, "image/png", speckle(between(80, 258), index * 7 + position)),
    );
  const markup = (index: number, from: Person) =>
    [
      jsonld({
        "@type": "ParcelDelivery",
        trackingNumber: `TR${index}`,
        carrier: { name: "Parcelo" },
        itemShipped: { name: sentence().slice(0, 30) },
        partOfOrder: { "@type": "Order", orderNumber: `${from.name.toUpperCase()}-${index % 40}` },
        deliveryStatus: {
          "@type": "DeliveryEvent",
          name: pick(["Shipped", "In transit", "Out for delivery"]),
          startDate: new Date(minutes(index)).toISOString(),
        },
      }),
      jsonld({
        "@type": "FlightReservation",
        reservationNumber: `F${index}`,
        reservationFor: {
          "@type": "Flight",
          flightNumber: `SK ${index % 900}`,
          airline: { name: "SkyLark Air" },
          departureAirport: { name: "Stockholm Arlanda", iataCode: "ARN" },
          arrivalAirport: { name: "Oslo Gardermoen", iataCode: "OSL" },
          departureTime: "2026-11-02T08:00:00+01:00",
        },
        reservedTicket: { ticketNumber: `T${index}`, ticketToken: `qrCode:T${index}` },
      }),
      jsonld({
        "@type": "EventReservation",
        reservationNumber: `E${index}`,
        reservationFor: { "@type": "Event", name: `${from.name} live`, startDate: "2026-12-01T19:00:00+01:00", location: { name: "Aurora Hall" } },
        reservedTicket: { ticketNumber: `E${index}`, ticketedSeat: { seatRow: "4", seatNumber: String(index % 30) } },
      }),
    ][index % 3]!;
  const newsletter = (index: number, from: Person) => {
    const domain = from.email.split("@")[1]!;
    const link = (path: string) => `https://${domain}/${path}?utm_source=newsletter&amp;utm_medium=email&amp;utm_campaign=${index}`;
    const cards: string[] = [];
    for (let size = 0, target = between(15_000, 60_000); size < target; size += cards.at(-1)!.length)
      cards.push(
        `<tr><td style="padding:12px;border-bottom:1px solid #e4e4e4"><a href="${link(`p/${cards.length}`)}"><img src="https://cdn.${domain}/img/${index}-${cards.length}.jpg" width="160" height="120" style="display:block;border:0" alt=""></a></td>` +
          `<td style="padding:12px;font:14px/1.5 Helvetica,Arial,sans-serif;color:#333"><h3 style="margin:0 0 6px;font-size:16px;color:#111">${sentence()}</h3><p style="margin:0 0 8px">${sentence()} ${sentence()}</p><a href="${link(`buy/${cards.length}`)}" style="color:#1a73e8;text-decoration:none">Shop now →</a></td></tr>`,
      );
    return html(
      `${random() < 0.15 ? markup(index, from) : ""}<table width="640" align="center" cellpadding="0" cellspacing="0" style="background:#fff;border-collapse:collapse">` +
        `<tr><td colspan="2" style="padding:24px;background:#1c3d5a"><img src="https://cdn.${domain}/logo.png" width="180" height="48" alt="${from.name}"></td></tr>${cards.join("")}` +
        `<tr><td colspan="2" style="padding:24px;font:12px Helvetica,Arial,sans-serif;color:#888">${["About", "Stores", "Help", "Privacy", "Preferences"].map((label) => `<a href="${link(label.toLowerCase())}" style="color:#888">${label}</a>`).join(" · ")}` +
        `<br>You receive this because alice@brevlada.test subscribed. <a href="https://${domain}/unsubscribe?u=${index}">Unsubscribe</a></td></tr></table>`,
    );
  };
  const threads: { thread: Thread; subject: string; partner: Person }[] = [];
  for (let index = 0; index < count; index++) {
    const date = minutes((count - index) * 37 + between(0, 30));
    const kind = random();
    const base = { ...received(alice), flags: random() < 0.7 ? (random() < 0.06 ? "FS" : "S") : "", date, id: `generated-${index}@brevlada.test` };
    if (kind < 0.45) {
      const from = companies[company()]!;
      const domain = from.email.split("@")[1]!;
      const unsubscribe = [
        `List-Unsubscribe: <https://${domain}/unsubscribe?u=${index}>, <mailto:unsubscribe@${domain}>`,
        "List-Unsubscribe-Post: List-Unsubscribe=One-Click",
      ];
      yield mail({ ...base, from, subject: `${from.name}: ${sentence().slice(0, 60)}`, headers: random() < 0.85 ? unsubscribe : [] }, newsletter(index, from));
      continue;
    }
    const reply = threads.length > 0 && random() < 0.55 ? threads[Math.max(0, threads.length - between(1, 200))]! : null;
    const partner = reply ? reply.partner : humans[human()]!;
    const own = reply !== null && random() < 0.35;
    const subject = reply
      ? reply.subject.startsWith("Re: ")
        ? reply.subject
        : `Re: ${reply.subject}`
      : pick([
          `Invoice ${index} for ${pick(["October", "November", "September"])}`,
          `Meeting notes: ${pick(keywords)}`,
          `${pick(keywords)} update`,
          `Question about the ${pick(keywords)}`,
          `Agenda for the ${pick(keywords)} meeting`,
          "Lunch with Alice?",
        ]);
    const legacy = kind < 0.8 && random() < 0.18 ? pick(["koi8-r", "windows-1251", "iso-8859-2"] as const) : null;
    const quotedText = reply ? `\n\nOn ${stamp(date - 3_600_000)}, ${(own ? partner : alice).name} wrote:\n> ${sentence()}\n> ${sentence()}` : "";
    const body = legacy
      ? text(
          Array.from({ length: between(8, 60) }, () => pick(legacyText[legacy]))
            .join(" ")
            .replace(/(.{1,72})(\s+|$)/g, "$1\n"),
          legacy,
          pick(["base64", "quoted-printable", "8bit"] as const),
        )
      : kind < 0.8
        ? text(prose(between(1_000, 8_000)) + quotedText, "utf-8", pick(["quoted-printable", "8bit"] as const))
        : multipart(
            "alternative",
            text(prose(between(400, 2_000)) + quotedText),
            html(`<div style="font-family:sans-serif"><p>${sentence()}</p><p>${sentence()} ${sentence()}</p></div>`),
          );
    const message = mail(
      {
        ...base,
        ...(own ? { folder: "Sent", flags: "S", from: alice, to: [partner] } : { from: partner }),
        subject: legacy ? word(subject.replace(/^Re: /, "") === subject ? pick(legacyText[legacy]) : `Re: ${pick(legacyText[legacy])}`, legacy) : subject,
        parent: reply ? reply.thread : null,
      },
      random() < 0.27 ? multipart("mixed", body, ...attachments(index)) : body,
    );
    threads.push({ thread: message, subject: message.subject, partner });
    yield message;
  }
}

export const messages = (large: number): Iterable<Message> => (large ? generated(large) : [...aliceMail(), ...bobMail()]);

export async function writeMaildir(root: string, list: Iterable<Message>) {
  const folders = new Map<string, { date: number; name: string }[]>(
    [...users.flatMap((user) => standard.map((folder) => `${user}/${folder}`)), `${alice.email}/Projects`].map((key) => [key, []]),
  );
  let counter = 0;
  for (const { user, folder, date, flags, raw } of list) {
    const key = `${user}/${folder}`;
    const dir = `${root}/${user}${folder === "INBOX" ? "" : `/.${folder.replaceAll("/", ".")}`}`;
    const name = `${date / 1000}.M${++counter}P1.brevlada`;
    const path = `${dir}/cur/${name}:2,${[...flags].sort().join("")}`;
    folders.set(key, [...(folders.get(key) ?? []), { date, name }]);
    await Bun.write(path, Buffer.from(raw, "latin1"));
    await utimes(path, date / 1000, date / 1000);
  }
  for (const [key, entries] of folders) {
    const [user, ...path] = key.split("/");
    const folder = path.join("/");
    const dir = `${root}/${user}${folder === "INBOX" ? "" : `/.${folder.replaceAll("/", ".")}`}`;
    await Promise.all(["cur", "new", "tmp"].map((sub) => mkdir(`${dir}/${sub}`, { recursive: true })));
    const sorted = entries.toSorted((a, b) => a.date - b.date);
    await Bun.write(`${dir}/dovecot-uidlist`, `3 V1760000000 N${sorted.length + 1}\n${sorted.map(({ name }, index) => `${index + 1} :${name}\n`).join("")}`);
  }
  return counter;
}

export async function writeEml(dir: string, list: Iterable<Message>) {
  await mkdir(dir, { recursive: true });
  let counter = 0;
  for (const { raw } of list) await Bun.write(`${dir}/${String(++counter).padStart(6, "0")}.eml`, Buffer.from(raw, "latin1"));
  return counter;
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { large: { type: "string", default: "0" }, eml: { type: "string" }, maildir: { type: "string" } } });
  const list = messages(Number(values.large));
  const written = values.eml ? await writeEml(values.eml, list) : values.maildir ? await writeMaildir(values.maildir, list) : 0;
  if (!written) throw new Error("Usage: bun tests/e2e/corpus.ts [--large N] (--eml <dir> | --maildir <dir>)");
  console.log(`Wrote ${written} messages to ${values.eml ?? values.maildir}`);
}
