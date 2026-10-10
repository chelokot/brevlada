import type { Account, Message } from "../models";
import { sameAscii } from "../models/text";
import { MESSAGE_LIMIT } from "../theme";
import { password, token } from "./accounts";
import { Session } from "./imap";
import * as mailHeaders from "./mail-headers";
import { applyFlags } from "./mail-sync";
import { trim } from "./mime";
import { parse } from "./parser";
import { Stream } from "./stream";

export class Mail {
  draftsFolder: string | null = null;

  constructor(readonly session: Session) {}

  static async connect(account: Account, watch = (_stream: Stream) => {}): Promise<Mail> {
    if (!account.ssl && !account.tls) throw new Error("This account needs SSL or STARTTLS enabled in Online Accounts");
    const stream = await Stream.connect(account.host, account.port).catch(() => {
      throw new Error("Could not connect to the mail server");
    });
    try {
      watch(stream);
      const session = new Session(stream);
      if (account.ssl) await stream.upgrade(account.host);
      await session.greeting();
      if (!account.ssl) await session.startTls(account.host);
      if (account.oauth2) await session.authenticate("XOAUTH2", `user=${account.username}\x01auth=Bearer ${token(account)}\x01\x01`);
      else await session.login(account.username, password(account));
      return new Mail(session);
    } catch (error) {
      stream.close();
      throw error;
    }
  }

  async folders(): Promise<string[]> {
    const folders = await this.session.list(null, "*");
    return folders.filter((folder) => !folder.attributes.includes("\\Noselect")).map((folder) => folder.name).sort();
  }

  async hasUnread(folder: string): Promise<boolean> {
    let count: number | null = null;
    for (const { mailbox, attributes } of await this.session.status(folder, "(UNSEEN)")) {
      const unseen = attributes.get("UNSEEN");
      if (unseen !== undefined && (mailbox === folder || (sameAscii(mailbox, "INBOX") && sameAscii(folder, "INBOX")))) count = unseen;
    }
    if (count === null) throw new Error("Mail server did not return an unread count for the requested folder");
    return count > 0;
  }

  async deliveryUids(folder: string, validity: number | null, sender: string, order: string): Promise<number[]> {
    const query = deliveryQuery(sender, order);
    const mailbox = await this.session.examine(folder);
    if (validity !== null && mailbox.uidValidity !== validity) throw new Error("Mailbox changed while searching delivery updates");
    return (await this.session.uidSearch(query)).sort((a, b) => a - b);
  }

  async headers(folder: string): Promise<[validity: number, messages: Message[], uids: number[]]> {
    const validity = (await this.session.select(folder)).uidValidity;
    if (validity === null) throw new Error("Mail server did not provide UIDVALIDITY");
    const uids = (await this.session.uidSearch("ALL")).sort((a, b) => a - b);
    const recent = uids.slice(Math.max(uids.length - MESSAGE_LIMIT, 0));
    if (!recent.length) return [validity, [], uids];
    return [validity, await mailHeaders.fetch(this.session, folder, this.draftsFolder, validity, recent), uids];
  }

  async bodyWithValidity(folder: string, uid: number, validity: number | null, inline: boolean): Promise<Message> {
    const mailbox = await this.session.select(folder);
    if (validity !== null && mailbox.uidValidity !== validity) throw new Error("Mailbox changed while loading message");
    const item = (await this.session.uidFetch(String(uid), "(UID FLAGS BODY.PEEK[])")).find((item) => item.uid === uid && item.body);
    if (!item || !item.body) throw new Error("Message is no longer on the server");
    const message = parse(uid, item.body, item.flags.includes("\\Seen"), true, inline);
    message.uidValidity = mailbox.uidValidity;
    applyFlags(message, folder, item.flags, this.draftsFolder);
    return message;
  }

  async headerWithValidity(folder: string, uid: number, validity: number | null): Promise<Message> {
    const mailbox = await this.session.examine(folder);
    if (validity !== null && mailbox.uidValidity !== validity) throw new Error("Mailbox changed while loading unsubscribe headers");
    const item = (await this.session.uidFetch(String(uid), "(UID FLAGS BODY.PEEK[HEADER])")).find((item) => item.uid === uid && item.header);
    if (!item || !item.header) throw new Error("Message is no longer on the server");
    return parse(uid, item.header, item.flags.includes("\\Seen"), false);
  }

  async markRead(folder: string, uid: number, validity: number | null) {
    const mailbox = await this.session.select(folder);
    if (validity !== null && mailbox.uidValidity !== validity) throw new Error("Mailbox changed while marking message read");
    await this.session.uidStore(String(uid), "+FLAGS.SILENT (\\Seen)");
  }

  async logout() {
    await this.session.logout().catch(() => {});
    this.session.stream.close();
  }

  [Symbol.asyncDispose]() {
    return this.logout();
  }
}

export function deliveryQuery(sender: string, order: string) {
  const quote = (value: string) => {
    if (!trim(value) || /\p{Cc}/u.test(value)) throw new Error("Invalid delivery search value");
    return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  };
  return `FROM ${quote(sender)} TEXT ${quote(order)}`;
}
