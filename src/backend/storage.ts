import { Database, SQLiteError, type SQLQueryBindings } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { prepareDisplay, type Message, message as blank, type SentMessage } from "../models";
import { related } from "../models/conversation";
import type { Target } from "../models/draft";
import { htmlText } from "../models/search";
import { flaggedState, readState, type SenderAction } from "../models/sender-action";
import { key } from "../models/senders";
import { parse as parseTickets } from "../models/ticket";
import { MESSAGE_LIMIT } from "../theme";
import { now, SOURCES, type Source } from "./avatar-cache";
import { ensureDraftId, type Flags } from "./mail-sync";
import { normalizeMessageId } from "./parser";

export interface Cached {
  image: Uint8Array | null;
  fetchedAt: number;
}

const VERSION = 1;
const INDEX_BATCH = 64;
const TRIGRAMS = "fts5(text, content='', contentless_delete=1, detail=none, tokenize='trigram case_sensitive 1')";
const SCHEMA = `
CREATE TABLE IF NOT EXISTS headers (id INTEGER PRIMARY KEY, account TEXT NOT NULL, folder TEXT, uid INTEGER NOT NULL, uidValidity INTEGER,
  messageId TEXT NOT NULL, subject TEXT NOT NULL, sender TEXT NOT NULL, senderKey TEXT NOT NULL, replyTo TEXT NOT NULL, recipients TEXT NOT NULL,
  cc TEXT NOT NULL, inReplyTo TEXT, date TEXT NOT NULL, timestamp INTEGER NOT NULL, "references" TEXT NOT NULL, isRead INTEGER NOT NULL,
  readRevision INTEGER NOT NULL, isDraft INTEGER NOT NULL, isFlagged INTEGER NOT NULL, isSpam INTEGER NOT NULL, flagRevision INTEGER NOT NULL,
  unsubscribe TEXT NOT NULL, bodyLoaded INTEGER NOT NULL, inlineMediaLoaded INTEGER NOT NULL, attachments TEXT NOT NULL,
  attachmentDetails TEXT NOT NULL, parcels TEXT NOT NULL, calendarEvents TEXT NOT NULL, tickets TEXT NOT NULL, UNIQUE (account, folder, uid));
CREATE UNIQUE INDEX IF NOT EXISTS headersSent ON headers (account, messageId) WHERE folder IS NULL;
CREATE INDEX IF NOT EXISTS headersDate ON headers (account, folder, timestamp DESC, uid DESC);
CREATE INDEX IF NOT EXISTS headersSender ON headers (account, senderKey, folder, timestamp DESC, uid DESC);
CREATE TABLE IF NOT EXISTS bodies (id INTEGER PRIMARY KEY, htmlTickets TEXT NOT NULL, bodyText TEXT NOT NULL, htmlText TEXT NOT NULL,
  bodyHtml TEXT NOT NULL, inlineMedia TEXT NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS headerSearch USING ${TRIGRAMS};
CREATE VIRTUAL TABLE IF NOT EXISTS bodySearch USING ${TRIGRAMS};
CREATE TABLE IF NOT EXISTS unindexed (id INTEGER PRIMARY KEY, header INTEGER NOT NULL, body INTEGER NOT NULL);
CREATE TRIGGER IF NOT EXISTS headersRemoved AFTER DELETE ON headers BEGIN
  DELETE FROM bodies WHERE id=old.id; DELETE FROM unindexed WHERE id=old.id;
  DELETE FROM headerSearch WHERE rowid=old.id; DELETE FROM bodySearch WHERE rowid=old.id;
END;
CREATE TABLE IF NOT EXISTS folders (account TEXT NOT NULL, folder TEXT NOT NULL, uidValidity INTEGER, PRIMARY KEY (account, folder)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS removedMessages (account TEXT NOT NULL, folder TEXT NOT NULL, uidValidity INTEGER NOT NULL, uid INTEGER NOT NULL,
  PRIMARY KEY (account, folder, uidValidity, uid)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS notificationFolders (account TEXT NOT NULL, folder TEXT NOT NULL, uidValidity INTEGER NOT NULL, lastUid INTEGER NOT NULL,
  PRIMARY KEY (account, folder)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS notificationPending (account TEXT NOT NULL, folder TEXT NOT NULL, uidValidity INTEGER NOT NULL, uid INTEGER NOT NULL,
  PRIMARY KEY (account, folder, uidValidity, uid)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS readChanges (account TEXT NOT NULL, folder TEXT NOT NULL, uid INTEGER NOT NULL, uidValidity INTEGER,
  revision INTEGER NOT NULL, PRIMARY KEY (account, folder, uid)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS syncSettings (account TEXT PRIMARY KEY, folders TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS avatars (email TEXT PRIMARY KEY, source TEXT NOT NULL, image BLOB, fetchedAt INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS unread (account TEXT NOT NULL, folder TEXT NOT NULL, unread INTEGER NOT NULL, PRIMARY KEY (account, folder)) WITHOUT ROWID;`;

const RUST_TABLES = "folders removed_messages metadata notification_folders notification_pending read_changes sync_settings avatars unread".split(" ");
const RUST_RENAMES = "one_click calendar_rendered content_id arrival_from arrival_until tracking_url order_url order_number recurrence_id organizer_email".split(" ");
const camel = (name: string) => name.replace(/_(.)/g, (_, letter: string) => letter.toUpperCase());
const rust = (field: string, fallback = "NULL") => `coalesce(json_extract(data, '$.${field}'), ${fallback})`;
const rustJson = (field: string, fallback = "'[]'") =>
  RUST_RENAMES.reduce((sql, name) => `replace(${sql}, '"${name}":', '"${camel(name)}":')`, rust(field, fallback));
const RUST_MESSAGE = `SELECT account_id AS account, ${rust("uid")} AS uid, ${rust("uid_validity")} AS uidValidity, ${rust("message_id")} AS messageId,
  ${rust("subject")} AS subject, ${rust("sender")} AS sender, ${rust("reply_to", "''")} AS replyTo, ${rust("recipients")} AS recipients,
  ${rust("cc", "''")} AS cc, ${rust("in_reply_to")} AS inReplyTo, ${rust("date")} AS date, ${rust("timestamp")} AS timestamp,
  ${rust("references")} AS "references", ${rust("is_read")} AS isRead, ${rust("read_revision", "0")} AS readRevision,
  ${rust("is_draft", "0")} AS isDraft, ${rust("is_flagged", "0")} AS isFlagged, ${rust("is_spam", "0")} AS isSpam,
  ${rust("flag_revision", "0")} AS flagRevision, ${rustJson("unsubscribe", "'null'")} AS unsubscribe,
  ${rust("body_loaded", "0")} AND json_type(data, '$.reply_to') IS NOT NULL
    AND NOT (${rust("is_draft", "0")} AND json_type(data, '$.cc') IS NULL) AS bodyLoaded,
  ${rust("inline_media_loaded", "0")} AS inlineMediaLoaded, ${rust("attachments")} AS attachments, ${rustJson("attachment_details")} AS attachmentDetails,
  ${rustJson("parcels")} AS parcels, ${rustJson("calendar_events")} AS calendarEvents, ${rust("tickets", "'[]'")} AS tickets,
  ${rust("body_text")} AS bodyText, ${rust("body_html")} AS bodyHtml, ${rustJson("inline_media")} AS inlineMedia`;

const REFRESHED = ["uidValidity", "messageId", "subject", "sender", "replyTo", "recipients", "cc", "inReplyTo", "date", "timestamp", "references", "isRead",
  "readRevision", "isDraft", "isFlagged", "isSpam", "flagRevision", "unsubscribe"];
const HEADER = ["uid", ...REFRESHED, "bodyLoaded", "inlineMediaLoaded", "attachments", "attachmentDetails", "parcels", "calendarEvents", "tickets"];
const quote = (column: string) => `"${column}"`;
const assign = (columns: string[], value: (column: string) => string) => columns.map((column) => `${quote(column)}=${value(column)}`).join(", ");
const INSERT = `INSERT INTO headers (account, folder, senderKey, ${HEADER.map(quote).join(", ")})
  VALUES ($account, $folder, $senderKey, ${HEADER.map((column) => `$${column}`).join(", ")})`;
const REPLACED = assign(["senderKey", ...HEADER], (column) => `excluded.${quote(column)}`);
const PUT = `${INSERT} ON CONFLICT (account, folder, uid) DO UPDATE SET ${REPLACED}
  ON CONFLICT (account, messageId) WHERE folder IS NULL DO UPDATE SET ${REPLACED} RETURNING id`;
const ADD = `${INSERT} ON CONFLICT DO NOTHING RETURNING id`;
const REFRESH = `UPDATE headers SET ${assign(["senderKey", ...REFRESHED], (column) => `$${column}`)}
  WHERE account=$account AND folder=$folder AND uid=$uid RETURNING id`;
const columns = (bodyText: string, bodyHtml: string, inlineMedia: string) =>
  `${HEADER.map((column) => `h.${quote(column)}`).join(", ")}, ${bodyText} AS bodyText, ${bodyHtml} AS bodyHtml, ${inlineMedia} AS inlineMedia`;
const FROM = "FROM headers h JOIN bodies b ON b.id=h.id";
const FULL = `SELECT ${columns("b.bodyText", "b.bodyHtml", "b.inlineMedia")} ${FROM}`;
const NEWEST = "ORDER BY h.timestamp DESC, h.uid DESC";
const VALIDITY = "(SELECT uidValidity FROM folders WHERE account=h.account AND folder=h.folder)";
const NOTIFIED = "DELETE FROM notificationPending WHERE account=? AND folder=? AND uidValidity=? AND uid=?";

type JsonField = "references" | "unsubscribe" | "attachments" | "attachmentDetails" | "parcels" | "calendarEvents" | "tickets" | "inlineMedia";
type FlagField = "isRead" | "isDraft" | "isFlagged" | "isSpam" | "bodyLoaded" | "inlineMediaLoaded";
type Stored = Omit<Message, JsonField | FlagField | "listPreview" | "displayPrepared" | "remoteMedia" | "searchMatch"> &
  Record<JsonField, string> &
  Record<FlagField, number>;
type SearchRow = Pick<Message, "uid" | "uidValidity" | "messageId" | "subject" | "sender" | "replyTo" | "recipients" | "cc" | "timestamp" | "date" |
  "readRevision" | "flagRevision"> & Record<"id" | "isRead" | "isFlagged", number>;

const decode = (row: Stored): Message => ({
  ...row,
  references: JSON.parse(row.references),
  unsubscribe: JSON.parse(row.unsubscribe),
  attachments: JSON.parse(row.attachments),
  attachmentDetails: JSON.parse(row.attachmentDetails),
  parcels: JSON.parse(row.parcels),
  calendarEvents: JSON.parse(row.calendarEvents),
  tickets: JSON.parse(row.tickets),
  inlineMedia: JSON.parse(row.inlineMedia),
  isRead: row.isRead === 1,
  isDraft: row.isDraft === 1,
  isFlagged: row.isFlagged === 1,
  isSpam: row.isSpam === 1,
  bodyLoaded: row.bodyLoaded === 1,
  inlineMediaLoaded: row.inlineMediaLoaded === 1,
  listPreview: null,
  displayPrepared: false,
  remoteMedia: null,
  searchMatch: false,
});

const encode = (account: string, folder: string | null, message: Message) => {
  const { references, unsubscribe, attachments, attachmentDetails, parcels, calendarEvents, tickets, inlineMedia, ...fields } = message;
  return {
    ...fields,
    account,
    folder,
    senderKey: key(message),
    references: JSON.stringify(references),
    unsubscribe: JSON.stringify(unsubscribe),
    attachments: JSON.stringify(attachments),
    attachmentDetails: JSON.stringify(attachmentDetails),
    parcels: JSON.stringify(parcels),
    calendarEvents: JSON.stringify(calendarEvents),
    tickets: JSON.stringify(tickets),
  };
};

type Searchable = Pick<Message, "subject" | "sender" | "replyTo" | "recipients" | "cc">;

const searchable = ({ subject, sender, replyTo, recipients, cc }: Searchable) => [subject, sender, replyTo, recipients, cc].join("\n");

const trigrams = (query: string) => {
  const characters = [...query];
  const tokens = new Set(characters.slice(2).map((_, index) => characters.slice(index, index + 3).join("")));
  return [...tokens].map((token) => `"${token.replaceAll('"', '""')}"`).join(" ");
};

function current(database: Database) {
  const version = database.query<{ user_version: number }, []>("PRAGMA user_version").get();
  return version?.user_version === VERSION && database.query("SELECT 1 FROM metadata WHERE key='avatar_sources' AND value=?").get(SOURCES) !== null;
}

export class Storage {
  readonly #database: Database;

  private constructor(database: Database) {
    this.#database = database;
    database.run("PRAGMA busy_timeout=5000");
  }

  static open(path: string): Storage {
    mkdirSync(dirname(path), { recursive: true });
    const storage = new Storage(new Database(path, { strict: true }));
    storage.#journal(performance.now());
    storage.#run("PRAGMA synchronous=NORMAL");
    if (!current(storage.#database)) storage.#write(() => storage.#initialize());
    return storage;
  }

  static openReadOnly(path: string): Storage {
    const storage = new Storage(new Database(path, { readonly: true, strict: true }));
    if (!current(storage.#database)) Storage.open(path).close();
    return storage;
  }

  #journal(started: number) {
    try {
      this.#run("PRAGMA journal_mode=WAL");
    } catch (error) {
      if (!(error instanceof SQLiteError && error.code === "SQLITE_BUSY") || performance.now() - started > 5000) throw error;
      Bun.sleepSync(1);
      this.#journal(started);
    }
  }

  close(): void {
    this.#database.close();
  }

  #initialize() {
    this.#database.run(SCHEMA);
    if (this.#get("SELECT 1 FROM sqlite_master WHERE name='rust_messages'") && !this.#get("SELECT 1 FROM metadata WHERE key='rust_import'")) {
      for (const table of RUST_TABLES) this.#run(`INSERT OR IGNORE INTO ${camel(table)} SELECT * FROM rust_${table}`);
      const rows = this.#database.query<Stored & { account: string; folder: string | null }, []>(
        `${RUST_MESSAGE}, folder FROM rust_messages UNION ALL ${RUST_MESSAGE}, NULL FROM rust_sent_local`,
      );
      for (const { account, folder, ...row } of rows.iterate()) this.#put(account, folder, decode(row), PUT, null);
      this.#run("INSERT INTO metadata VALUES ('rust_import', '1')");
    }
    if (!this.#get("SELECT 1 FROM metadata WHERE key='avatar_sources' AND value=?", SOURCES)) {
      this.#run("DELETE FROM avatars");
      this.#run("INSERT OR REPLACE INTO metadata VALUES ('avatar_sources', ?)", SOURCES);
    }
    this.#run(`PRAGMA user_version=${VERSION}`);
  }

  #all<T>(sql: string, ...params: SQLQueryBindings[]): T[] {
    return this.#database.query<T, SQLQueryBindings[]>(sql).all(...params);
  }

  #get<T>(sql: string, ...params: SQLQueryBindings[]): T | null {
    return this.#database.query<T, SQLQueryBindings[]>(sql).get(...params);
  }

  #one<T>(sql: string, ...params: SQLQueryBindings[]): T {
    const row = this.#get<T>(sql, ...params);
    if (row === null) throw new Error("Query returned no rows");
    return row;
  }

  #run(sql: string, ...params: SQLQueryBindings[]): number {
    return this.#database.query<unknown, SQLQueryBindings[]>(sql).run(...params).changes;
  }

  #write<T>(work: () => T): T {
    const write = () => {
      const result = work();
      if (this.#one<{ count: number }>("SELECT count(*) AS count FROM unindexed").count >= INDEX_BATCH) this.#index();
      return result;
    };
    return this.#database.transaction(write).immediate();
  }

  #put(account: string, folder: string | null, message: Message, sql: string, previous: Message | null) {
    for (const { id } of this.#all<{ id: number }>(sql, encode(account, folder, message))) {
      const html = message.bodyHtml && htmlText(message.bodyHtml);
      const tickets = JSON.stringify(parseTickets(message.bodyHtml));
      const media = JSON.stringify(message.inlineMedia);
      this.#run("INSERT OR REPLACE INTO bodies VALUES (?, ?, ?, ?, ?, ?)", id, tickets, message.bodyText, html, message.bodyHtml, media);
      const body = previous === null || previous.bodyText !== message.bodyText || previous.bodyHtml !== message.bodyHtml;
      this.#reindex(id, previous === null || searchable(previous) !== searchable(message), body);
    }
  }

  #reindex(id: number, header: boolean, body: boolean) {
    if (!header && !body) return;
    const sql = "INSERT INTO unindexed VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET header=max(header, excluded.header), body=max(body, excluded.body)";
    this.#run(sql, id, header, body);
  }

  #index() {
    const rows = this.#database.query<Searchable & Record<"id" | "header" | "body", number> & Record<"bodyText" | "htmlText", string>, []>(
      `SELECT u.*, h.subject, h.sender, h.replyTo, h.recipients, h.cc, b.bodyText, b.htmlText
       FROM unindexed u JOIN headers h ON h.id=u.id JOIN bodies b ON b.id=u.id`,
    );
    for (const row of rows.iterate()) {
      if (row.header) this.#run("INSERT OR REPLACE INTO headerSearch (rowid, text) VALUES (?, ?)", row.id, searchable(row).toLowerCase());
      if (row.body && (row.bodyText || row.htmlText)) {
        this.#run("INSERT OR REPLACE INTO bodySearch (rowid, text) VALUES (?, ?)", row.id, `${row.bodyText}\n${row.htmlText}`.toLowerCase());
      }
    }
    this.#run("DELETE FROM unindexed");
  }

  message(account: string, folder: string, uid: number): Message | null {
    const row = this.#get<Stored>(`${FULL} WHERE h.account=? AND h.folder=? AND h.uid=?`, account, folder, uid);
    return row && decode(row);
  }

  store(account: string, folder: string, message: Message): void {
    this.#write(() => this.#put(account, folder, message, PUT, null));
  }

  messages(account: string, folder: string, limit = MESSAGE_LIMIT): Message[] {
    return this.#all<Stored>(`${FULL} WHERE h.account=? AND h.folder=? ${NEWEST} LIMIT ?`, account, folder, limit).map(decode);
  }

  deleteDraft(account: string, target: Target): void {
    if (target.validity !== null && target.uid !== 0) {
      this.confirmAction(account, target.folder, [blank({ uid: target.uid, uidValidity: target.validity, isDraft: true })], { kind: "Archive" });
    } else {
      this.#run("DELETE FROM headers WHERE account=? AND folder=? AND messageId=? AND isDraft", account, target.folder, target.messageId);
    }
  }

  storeSavedDraft(account: string, folder: string, message: Message): void {
    const validity = message.uidValidity;
    if (validity === null) throw new Error("Saved draft needs UIDVALIDITY");
    if (message.uid === 0 || !message.isDraft || !message.bodyLoaded) throw new Error("Saved draft is incomplete");
    this.#write(() => {
      const current = this.validity(account, folder);
      if (current !== null && current !== validity) throw new Error("Draft mailbox changed while caching");
      if (this.#removedIn(account, folder, validity).has(message.uid)) throw new Error("Draft was already removed");
      this.#run("INSERT OR REPLACE INTO folders VALUES (?, ?, ?)", account, folder, validity);
      this.#put(account, folder, message, PUT, null);
    });
  }

  storeSent(account: string, message: Message): void {
    this.#write(() => this.#put(account, null, message, PUT, null));
  }

  relatedSent(account: string, folder: string, received: Message[]): SentMessage[] {
    const local = this.#all<Stored>(`${FULL} WHERE h.account=? AND h.folder IS NULL ORDER BY h.messageId`, account);
    const cached = this.#all<Stored & { folder: string; folderValidity: number | null }>(
      `SELECT ${columns("b.bodyText", "b.bodyHtml", "b.inlineMedia")}, h.folder, ${VALIDITY} AS folderValidity ${FROM}
       WHERE h.account=? AND h.folder<>? AND (h.isDraft OR h.senderKey=lower(?)) ORDER BY h.timestamp DESC`,
      account,
      folder,
      account,
    );
    return related(received, [
      ...local.map((row) => ({ folder: "", message: decode(row) })),
      ...cached.map(({ folder, folderValidity, ...row }) => {
        const message = decode(row);
        message.uidValidity ??= folderValidity;
        ensureDraftId(message, folder);
        return { folder, message };
      }),
    ]);
  }

  folders(account: string): string[] {
    return this.#all<{ folder: string }>("SELECT folder FROM folders WHERE account=? ORDER BY folder", account).map(({ folder }) => folder);
  }

  unread(account: string): [folder: string, unread: boolean][] {
    return this.#all<{ folder: string; unread: number }>(
      `SELECT folder, unread FROM unread WHERE account=?1 UNION ALL
       SELECT folder, MAX(NOT isRead) FROM headers WHERE account=?1 AND folder IS NOT NULL AND folder NOT IN (SELECT folder FROM unread WHERE account=?1)
       GROUP BY folder`,
      account,
    ).map(({ folder, unread }) => [folder, unread === 1]);
  }

  storeUnread(account: string, folder: string, unread: boolean): void {
    this.#run("INSERT OR REPLACE INTO unread VALUES (?, ?, ?)", account, folder, unread);
  }

  storeFolders(account: string, folders: string[]): void {
    this.#write(() => folders.forEach((folder) => this.#run("INSERT OR IGNORE INTO folders (account, folder) VALUES (?, ?)", account, folder)));
  }

  reconcile(account: string, folder: string, validity: number, messages: Message[], live: number[]): void {
    this.reconcileSince(account, folder, validity, messages, live, this.readRevision());
  }

  reconcileSince(account: string, folder: string, validity: number, messages: Message[], live: number[], snapshotRevision: number): void {
    this.#write(() => {
      const revision = this.#nextReadRevision();
      const reads = this.#readsSince(account, folder, validity, snapshotRevision);
      const starred = this.#flagsSince(account, folder, validity, snapshotRevision);
      const reset = this.validity(account, folder) !== validity;
      if (reset) this.#run("DELETE FROM headers WHERE account=? AND folder=?", account, folder);
      const removed = this.#removedIn(account, folder, validity);
      const incoming = messages.filter(({ uid }) => !removed.has(uid));
      const kept = new Set([...live, ...incoming.map(({ uid }) => uid)].filter((uid) => !removed.has(uid)));
      const existing = new Map(
        this.#all<Searchable & { uid: number }>(
          "SELECT uid, subject, sender, replyTo, recipients, cc FROM headers WHERE account=? AND folder=?",
          account,
          folder,
        ).map((row) => [row.uid, searchable(row)]),
      );
      for (const uid of existing.keys()) if (!kept.has(uid)) this.#run("DELETE FROM headers WHERE account=? AND folder=? AND uid=?", account, folder, uid);
      for (const message of incoming) {
        const updated = {
          ...message,
          uidValidity: validity,
          isRead: reads.get(message.uid) ?? message.isRead,
          isFlagged: starred.get(message.uid) ?? message.isFlagged,
          readRevision: revision,
          flagRevision: revision,
        };
        const previous = existing.get(message.uid);
        if (previous === undefined) this.#put(account, folder, updated, PUT, null);
        else {
          const changed = previous !== searchable(updated);
          for (const { id } of this.#all<{ id: number }>(REFRESH, encode(account, folder, updated))) this.#reindex(id, changed, false);
        }
      }
      this.#run("INSERT OR REPLACE INTO folders VALUES (?, ?, ?)", account, folder, validity);
    });
  }

  confirmAction(account: string, folder: string, messages: Message[], action: SenderAction): void {
    this.#write(() => {
      const read = readState(action);
      const flagged = flaggedState(action);
      for (const message of messages) {
        const validity = message.uidValidity;
        if (validity === null) throw new Error("Missing message UIDVALIDITY");
        if (read !== null) {
          this.#recordReadState(account, folder, validity, message.uid, read);
        } else if (flagged !== null) {
          this.#run(
            `UPDATE headers AS h SET isFlagged=?, flagRevision=? WHERE account=? AND folder=? AND uid=? AND ${VALIDITY}=?`,
            flagged,
            this.#nextReadRevision(),
            account,
            folder,
            message.uid,
            validity,
          );
        } else {
          this.#run("INSERT OR IGNORE INTO removedMessages VALUES (?, ?, ?, ?)", account, folder, validity, message.uid);
          this.#run(`DELETE FROM headers AS h WHERE account=? AND folder=? AND uid=? AND ${VALIDITY}=?`, account, folder, message.uid, validity);
        }
      }
    });
  }

  #flagsSince(account: string, folder: string, validity: number, revision: number): Map<number, boolean> {
    const rows = this.#all<{ uid: number; isFlagged: number }>(
      `SELECT uid, isFlagged FROM headers h WHERE account=? AND folder=? AND ${VALIDITY}=? AND flagRevision>?`,
      account,
      folder,
      validity,
      revision,
    );
    return new Map(rows.map(({ uid, isFlagged }) => [uid, isFlagged === 1]));
  }

  #removedIn(account: string, folder: string, validity: number): Set<number> {
    const rows = this.#all<{ uid: number }>("SELECT uid FROM removedMessages WHERE account=? AND folder=? AND uidValidity=?", account, folder, validity);
    return new Set(rows.map(({ uid }) => uid));
  }

  avatar(email: string): Cached | null {
    return this.#get<Cached>("SELECT image, fetchedAt FROM avatars WHERE email=?", email);
  }

  storeAvatar(email: string, source: Source, image: Uint8Array | null): void {
    this.#run("INSERT OR REPLACE INTO avatars VALUES (?, ?, ?, ?)", email, source, image, now());
  }

  calendarMessages(account: string, eventUid: string): Message[] {
    return this.#all<Stored>(
      `${FULL} WHERE h.account=? AND h.calendarEvents<>'[]'
       AND EXISTS (SELECT 1 FROM json_each(h.calendarEvents) WHERE json_extract(value, '$.uid')=?) ORDER BY h.folder IS NULL`,
      account,
      eventUid,
    ).map(decode);
  }

  notificationFolders(): [account: string, folder: string, validity: number][] {
    return this.#all<{ account: string; folder: string; uidValidity: number }>("SELECT DISTINCT account, folder, uidValidity FROM notificationPending").map(
      ({ account, folder, uidValidity }) => [account, folder, uidValidity],
    );
  }

  #observeNotifications(account: string, folder: string, validity: number, previous: number | null, flags: [uid: number, unread: boolean][]) {
    if (!/^inbox$/i.test(folder)) return;
    const checkpoint = this.#get<{ uidValidity: number; lastUid: number }>(
      "SELECT uidValidity, lastUid FROM notificationFolders WHERE account=? AND folder=?",
      account,
      folder,
    );
    const baseline = checkpoint
      ? checkpoint.uidValidity === validity
        ? checkpoint.lastUid
        : null
      : previous === validity
        ? this.#one<{ uid: number | null }>("SELECT max(uid) AS uid FROM headers WHERE account=? AND folder=?", account, folder).uid
        : null;
    const unread = new Set(flags.filter(([, unread]) => unread).map(([uid]) => uid));
    const pending = this.#all<{ uidValidity: number; uid: number }>("SELECT uidValidity, uid FROM notificationPending WHERE account=? AND folder=?", account, folder);
    for (const { uidValidity, uid } of pending) if (uidValidity !== validity || !unread.has(uid)) this.#run(NOTIFIED, account, folder, uidValidity, uid);
    if (baseline !== null) {
      for (const uid of unread) if (uid > baseline) this.#run("INSERT OR IGNORE INTO notificationPending VALUES (?, ?, ?, ?)", account, folder, validity, uid);
    }
    const lastUid = flags.reduce((last, [uid]) => Math.max(last, uid), baseline ?? 0);
    this.#run("INSERT OR REPLACE INTO notificationFolders VALUES (?, ?, ?, ?)", account, folder, validity, lastUid);
  }

  pendingNotifications(account: string, folder: string, validity: number): Message[] {
    return this.#all<Stored>(
      `${FULL} JOIN notificationPending n ON n.account=h.account AND n.folder=h.folder AND n.uid=h.uid
       JOIN folders f ON f.account=n.account AND f.folder=n.folder AND f.uidValidity=n.uidValidity
       WHERE n.account=? AND n.folder=? AND n.uidValidity=? AND NOT h.isRead AND NOT h.isDraft ORDER BY n.uid DESC`,
      account,
      folder,
      validity,
    ).map(decode);
  }

  acknowledgeNotifications(account: string, folder: string, validity: number, uids: number[]): void {
    this.#write(() =>
      uids.forEach((uid) => this.#run(NOTIFIED, account, folder, validity, uid)),
    );
  }

  readRevision(): number {
    return this.#get<{ revision: number }>("SELECT CAST(value AS INTEGER) AS revision FROM metadata WHERE key='read_revision'")?.revision ?? 0;
  }

  #nextReadRevision(): number {
    this.#run("INSERT INTO metadata VALUES ('read_revision', '1') ON CONFLICT (key) DO UPDATE SET value=CAST(value AS INTEGER)+1");
    return this.readRevision();
  }

  #readsSince(account: string, folder: string, validity: number, revision: number): Map<number, boolean> {
    const rows = this.#all<{ uid: number; isRead: number }>(
      `SELECT c.uid, h.isRead FROM readChanges c JOIN headers h ON h.account=c.account AND h.folder=c.folder AND h.uid=c.uid
       WHERE c.account=? AND c.folder=? AND c.uidValidity=? AND c.revision>?`,
      account,
      folder,
      validity,
      revision,
    );
    return new Map(rows.map(({ uid, isRead }) => [uid, isRead === 1]));
  }

  #recordReadState(account: string, folder: string, validity: number | null, uid: number, read: boolean): Message | null {
    const revision = this.#nextReadRevision();
    const updated = this.#run(
      `UPDATE headers AS h SET isRead=?, readRevision=? WHERE account=? AND folder=? AND uid=? AND ${VALIDITY} IS ?`,
      read,
      revision,
      account,
      folder,
      uid,
      validity,
    );
    if (updated === 0) return null;
    this.#run(
      `INSERT INTO readChanges VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (account, folder, uid) DO UPDATE SET uidValidity=excluded.uidValidity, revision=excluded.revision`,
      account,
      folder,
      uid,
      validity,
      revision,
    );
    return this.message(account, folder, uid);
  }

  markReadCached(account: string, folder: string, validity: number | null, uid: number): Message | null {
    return this.#write(() => this.#recordReadState(account, folder, validity, uid, true));
  }

  searchFolders(account: string): string[] {
    const sql = "SELECT folder FROM folders WHERE account=?1 UNION SELECT folder FROM headers WHERE account=?1 AND folder IS NOT NULL ORDER BY folder";
    return this.#all<{ folder: string }>(sql, account).map(({ folder }) => folder);
  }

  parcelSenderMessages(account: string, folder: string, sender: string, identifier: string): Message[] {
    if (!sender || !identifier.trim()) return [];
    return this.#all<Stored>(
      `${FULL} WHERE h.account=?1 AND h.folder=?2 AND h.senderKey=?3 AND instr(lower(h.sender), ?3)>0 ORDER BY h.timestamp, h.uid`,
      account,
      folder,
      sender,
    ).map(decode);
  }

  searchDataVersion(): number {
    return this.#one<{ data_version: number }>("PRAGMA data_version").data_version;
  }

  visitSearchMessages(account: string, folder: string, visit: (message: Message, id: number) => boolean): void {
    const rows = this.#database.query<SearchRow, [string, string]>(
      `SELECT h.id, h.uid, h.uidValidity, h.messageId, h.subject, h.sender, h.replyTo, h.recipients, h.cc, h.timestamp, h.date, h.isRead, h.isFlagged,
       h.readRevision, h.flagRevision FROM headers h WHERE h.account=? AND h.folder=? ${NEWEST}`,
    );
    for (const { id, isRead, isFlagged, ...row } of rows.iterate(account, folder)) {
      if (!visit(blank({ ...row, isRead: isRead === 1, isFlagged: isFlagged === 1 }), id)) break;
    }
  }

  searchBody(id: number, column: "bodyText" | "htmlText"): string {
    return this.#one<{ text: string }>(`SELECT ${column} AS text FROM bodies WHERE id=?`, id).text;
  }

  searchCandidates(query: string): Set<number> | null {
    if ([...query].length < 3) return null;
    const sql = "SELECT rowid AS id FROM headerSearch(?1) UNION SELECT rowid FROM bodySearch(?1) UNION SELECT id FROM unindexed";
    return new Set(this.#all<{ id: number }>(sql, trigrams(query)).map(({ id }) => id));
  }

  senderHeaders(account: string, folder: string): Message[] {
    const rows = this.#all<Stored & { htmlText: string; htmlTickets: string }>(
      `SELECT ${columns("b.bodyText", "''", "'[]'")}, b.htmlText, b.htmlTickets ${FROM} WHERE h.account=? AND h.folder=? ${NEWEST}`,
      account,
      folder,
    );
    return rows.map(({ htmlText, htmlTickets, ...row }) => {
      const message = decode(row);
      const calendar = message.calendarEvents.length > 0;
      return {
        ...message,
        parcels: calendar ? message.parcels : [],
        attachments: calendar ? message.attachments : [],
        bodyLoaded: false,
        inlineMediaLoaded: false,
        tickets: message.tickets.length > 0 ? message.tickets : JSON.parse(htmlTickets),
        bodyText: htmlText && !message.bodyText.includes(htmlText) ? `${message.bodyText}\n${htmlText}` : message.bodyText,
      };
    });
  }

  recordSyncStarted(seconds: number): void {
    this.#run("INSERT OR REPLACE INTO metadata VALUES ('last_sync_started', ?)", String(seconds));
  }

  lastSyncStarted(): number | null {
    const row = this.#get<{ value: string }>("SELECT value FROM metadata WHERE key='last_sync_started'");
    return row && Number(row.value);
  }

  syncFolders(account: string): string[] {
    this.#run("INSERT OR IGNORE INTO syncSettings VALUES (?, ?)", account, JSON.stringify(["INBOX"]));
    return JSON.parse(this.#one<{ folders: string }>("SELECT folders FROM syncSettings WHERE account=?", account).folders);
  }

  uncachedUids(account: string, folder: string): number[] {
    const sql = "SELECT uid FROM headers WHERE account=? AND folder=? AND NOT bodyLoaded ORDER BY uid";
    return this.#all<{ uid: number }>(sql, account, folder).map(({ uid }) => uid);
  }

  senderPage(account: string, folder: string, sender: string, before: [timestamp: number, uid: number] | null, limit: number): Message[] {
    const [timestamp, uid] = before ?? [null, null];
    const rows = this.#all<Stored>(
      `SELECT ${columns("b.bodyText", "b.bodyHtml", "'[]'")} ${FROM} WHERE h.account=?1 AND h.folder=?2 AND h.senderKey=?3 AND instr(lower(h.sender), ?3)>0
       AND (?4 IS NULL OR (h.timestamp, h.uid) < (?4, ?5)) ${NEWEST} LIMIT ?6`,
      account,
      folder,
      sender,
      timestamp,
      uid,
      limit,
    );
    return rows.map((row) => {
      const message = { ...decode(row), inlineMediaLoaded: false };
      prepareDisplay(message);
      return message;
    });
  }

  pendingBodies(account: string, folder: string, before: [timestamp: number, uid: number] | null, limit: number): Message[] {
    const [timestamp, uid] = before ?? [null, null];
    const rows = this.#all<Stored>(
      `SELECT ${columns("''", "''", "b.inlineMedia")} ${FROM} WHERE h.account=?1 AND h.folder=?2 AND NOT h.bodyLoaded
       AND (?3 IS NULL OR (h.timestamp, h.uid) < (?3, ?4)) ${NEWEST} LIMIT ?5`,
      account,
      folder,
      timestamp,
      uid,
      limit,
    );
    return rows.map((row) => ({ ...decode(row), attachments: [], calendarEvents: [], tickets: [] }));
  }

  validity(account: string, folder: string): number | null {
    return this.#get<{ uidValidity: number | null }>("SELECT uidValidity FROM folders WHERE account=? AND folder=?", account, folder)?.uidValidity ?? null;
  }

  inventory(account: string, folder: string, validity: number, flags: Flags[]): number[] {
    return this.inventorySince(account, folder, validity, flags, this.readRevision());
  }

  inventorySince(account: string, folder: string, validity: number, flags: Flags[], snapshotRevision: number): number[] {
    const [existing, live] = this.#write(() => {
      const revision = this.#nextReadRevision();
      const reads = this.#readsSince(account, folder, validity, snapshotRevision);
      const starred = this.#flagsSince(account, folder, validity, snapshotRevision);
      const read = (item: Flags) => reads.get(item.uid) ?? item.read;
      const previous = this.validity(account, folder);
      this.#observeNotifications(account, folder, validity, previous, flags.map((item) => [item.uid, !read(item) && !item.draft]));
      if (previous !== validity) this.#run("DELETE FROM headers WHERE account=? AND folder=?", account, folder);
      const existing = new Set(this.#all<{ uid: number }>("SELECT uid FROM headers WHERE account=? AND folder=?", account, folder).map(({ uid }) => uid));
      const removed = this.#removedIn(account, folder, validity);
      const live = new Set(flags.map(({ uid }) => uid).filter((uid) => !removed.has(uid)));
      for (const uid of existing) if (!live.has(uid)) this.#run("DELETE FROM headers WHERE account=? AND folder=? AND uid=?", account, folder, uid);
      for (const item of flags.filter(({ uid }) => existing.has(uid))) {
        this.#run(
          "UPDATE headers SET isRead=?, isFlagged=?, isDraft=?, readRevision=?, flagRevision=? WHERE account=? AND folder=? AND uid=?",
          read(item),
          starred.get(item.uid) ?? item.flagged,
          item.draft,
          revision,
          revision,
          account,
          folder,
          item.uid,
        );
      }
      this.#run("INSERT OR REPLACE INTO folders VALUES (?, ?, ?)", account, folder, validity);
      this.#run("INSERT OR REPLACE INTO unread VALUES (?, ?, ?)", account, folder, flags.some((item) => !read(item) && !removed.has(item.uid)));
      return [existing, live];
    });
    return [...live].filter((uid) => !existing.has(uid)).sort((a, b) => b - a);
  }

  storeHeaders(account: string, folder: string, validity: number, messages: Message[]): void {
    this.#write(() => {
      const revision = this.#nextReadRevision();
      if (this.validity(account, folder) !== validity) throw new Error("Mailbox changed during sync");
      const removed = this.#removedIn(account, folder, validity);
      for (const message of messages.filter(({ uid }) => !removed.has(uid))) {
        this.#put(account, folder, { ...message, readRevision: revision, flagRevision: revision }, ADD, null);
      }
    });
  }

  storeBody(account: string, folder: string, validity: number | null, fetched: Message): Message | null {
    return this.#write(() => {
      if (this.validity(account, folder) !== validity) return null;
      const stored = this.message(account, folder, fetched.uid);
      if (stored === null) return null;
      const id = normalizeMessageId(stored.messageId);
      if (id && !(stored.isDraft && !fetched.messageId) && id !== normalizeMessageId(fetched.messageId)) return null;
      const message: Message = {
        ...stored,
        messageId: stored.isDraft && !stored.messageId ? fetched.messageId : stored.messageId,
        uidValidity: validity,
        replyTo: fetched.replyTo,
        cc: fetched.cc,
        inReplyTo: fetched.inReplyTo,
        bodyText: fetched.bodyText,
        bodyHtml: fetched.bodyHtml,
        attachments: fetched.attachments,
        attachmentDetails: fetched.attachmentDetails,
        inlineMedia: fetched.inlineMediaLoaded ? fetched.inlineMedia : stored.inlineMedia,
        inlineMediaLoaded: fetched.inlineMediaLoaded || stored.inlineMediaLoaded,
        unsubscribe: fetched.unsubscribe ?? stored.unsubscribe,
        parcels: fetched.parcels,
        calendarEvents: fetched.calendarEvents,
        tickets: fetched.tickets,
        bodyLoaded: fetched.bodyLoaded,
      };
      this.#put(account, folder, message, PUT, stored);
      return message;
    });
  }

  storeUnsubscribe(account: string, folder: string, validity: number | null, header: Message): void {
    const current = this.message(account, folder, header.uid);
    if (current === null) throw new Error("Message is no longer cached");
    if (normalizeMessageId(current.messageId) !== normalizeMessageId(header.messageId)) throw new Error("The mailbox changed. Reload the folder.");
    const updated = this.#run(
      `UPDATE headers AS h SET unsubscribe=? WHERE account=? AND folder=? AND uid=? AND ${VALIDITY} IS ? AND messageId=?`,
      JSON.stringify(header.unsubscribe),
      account,
      folder,
      header.uid,
      validity,
      current.messageId,
    );
    if (updated !== 1) throw new Error("Mailbox changed while loading unsubscribe headers");
  }
}
