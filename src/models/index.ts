import { hasRemoteMedia } from "../components/html";
import { message as preview } from "../components/preview";
import type { Details } from "./attachment";
import { type Event, events } from "./calendar";
import type { Target } from "./draft";
import { type Parcel, parseMessage } from "./parcel";
import { fields } from "./search";
import { prefix } from "./text";
import { type Reservation, parse as tickets } from "./ticket";

export interface SmtpSettings {
  host: string;
  port: number;
  username: string;
  ssl: boolean;
  tls: boolean;
  auth: boolean;
  login: boolean;
  plain: boolean;
  xoauth2: boolean;
}

export interface Account {
  path: string;
  email: string;
  name: string;
  host: string;
  username: string;
  port: number;
  ssl: boolean;
  tls: boolean;
  oauth2: boolean;
  smtp: SmtpSettings | null;
}

export interface Unsubscribe {
  url: string;
  oneClick: boolean | null;
}

export interface InlineMedia {
  contentId: string;
  mime: string;
  data: string;
}

export interface Message {
  uid: number;
  uidValidity: number | null;
  messageId: string;
  subject: string;
  sender: string;
  replyTo: string;
  recipients: string;
  cc: string;
  inReplyTo: string | null;
  date: string;
  timestamp: number;
  references: string[];
  isRead: boolean;
  readRevision: number;
  isDraft: boolean;
  isFlagged: boolean;
  isSpam: boolean;
  flagRevision: number;
  bodyText: string;
  bodyHtml: string;
  attachments: string[];
  attachmentDetails: Details[];
  inlineMedia: InlineMedia[];
  inlineMediaLoaded: boolean;
  unsubscribe: Unsubscribe | null;
  parcels: Parcel[];
  calendarEvents: Event[];
  tickets: Reservation[];
  bodyLoaded: boolean;
  listPreview: string | null;
  displayPrepared: boolean;
  remoteMedia: boolean | null;
  searchMatch: boolean;
}

export interface Draft {
  attachmentsLoaded: boolean;
  to: string;
  cc: string;
  subject: string;
  text: string;
  html: string | null;
  attachments: string[];
  attachmentNames: string[];
  removedAttachments: number[];
  attachmentSource: Target | null;
  inReplyTo: string | null;
  references: string[];
}

export interface SentMessage {
  folder: string;
  message: Message;
}

export function message(fields: Partial<Message> = {}): Message {
  return {
    uid: 0,
    uidValidity: null,
    messageId: "",
    subject: "",
    sender: "",
    replyTo: "",
    recipients: "",
    cc: "",
    inReplyTo: null,
    date: "",
    timestamp: 0,
    references: [],
    isRead: false,
    readRevision: 0,
    isDraft: false,
    isFlagged: false,
    isSpam: false,
    flagRevision: 0,
    bodyText: "",
    bodyHtml: "",
    attachments: [],
    attachmentDetails: [],
    inlineMedia: [],
    inlineMediaLoaded: false,
    unsubscribe: null,
    parcels: [],
    calendarEvents: [],
    tickets: [],
    bodyLoaded: false,
    listPreview: null,
    displayPrepared: false,
    remoteMedia: null,
    searchMatch: false,
    ...fields,
  };
}

export function prepareDisplay(message: Message) {
  if (message.displayPrepared) return;
  if (message.tickets.length === 0 && message.bodyHtml) message.tickets = tickets(message.bodyHtml);
  if (message.bodyLoaded) {
    if (message.parcels.length === 0) message.parcels = parseMessage(message);
    message.calendarEvents = events(message);
  }
  if (message.bodyLoaded || message.bodyText || message.bodyHtml) message.listPreview = preview(message);
  message.remoteMedia = hasRemoteMedia(message);
  message.displayPrepared = true;
}

export function listHeader(source: Message, withPreview: boolean): Message {
  const { uid, uidValidity, messageId, subject, sender, replyTo, recipients, cc, inReplyTo, references, timestamp, date, isRead, readRevision } = source;
  const { isFlagged, flagRevision, isSpam, isDraft, listPreview, calendarEvents, tickets, searchMatch } = source;
  return message({
    uid, uidValidity, messageId, subject, sender, replyTo, recipients, cc, inReplyTo, references, timestamp, date, isRead, readRevision,
    isFlagged, flagRevision, isSpam, isDraft, calendarEvents, tickets, searchMatch, displayPrepared: true,
    bodyText: withPreview ? (listPreview ?? prefix(source.bodyText, 161)) : "",
    listPreview: withPreview ? listPreview : null,
  });
}

export const searchDocument = (source: Message): Message => ({
  ...listHeader(source, true),
  bodyText: source.bodyText,
  bodyHtml: source.bodyHtml,
  bodyLoaded: source.bodyLoaded,
  displayPrepared: source.displayPrepared,
  remoteMedia: source.remoteMedia,
});

export const matches = (message: Message, query: string) => !query || fields(message).some((field) => field.toLowerCase().includes(query));

interface Thread {
  message: Message;
  parent: Thread | null;
}

function root(thread: Thread) {
  let node = thread;
  while (node.parent) {
    if (node.parent.parent) node.parent = node.parent.parent;
    node = node.parent;
  }
  return node;
}

function union(thread: Thread, other: Thread) {
  const [left, right] = [root(thread), root(other)];
  if (left !== right) right.parent = left;
}

export function threads(messages: Message[], query: string): Message[][] {
  const nodes = messages.filter((message) => matches(message, query)).map((message): Thread => ({ message, parent: null }));
  const subjects = new Map<string, Thread>();
  const ids = new Map<string, Thread>();
  const referencedBy = new Map<string, Thread[]>();
  for (const node of nodes) {
    const { subject, messageId, references } = node.message;
    const key = subjectKey(subject);
    const sameSubject = subjects.get(key);
    if (key) subjects.set(key, node);
    if (key && sameSubject) union(node, sameSubject);
    if (messageId) {
      const sameId = ids.get(messageId);
      ids.set(messageId, node);
      if (sameId) union(node, sameId);
      for (const other of referencedBy.get(messageId) ?? []) union(node, other);
    }
    for (const reference of references) {
      const referenced = ids.get(reference);
      if (referenced) union(node, referenced);
      const list = referencedBy.get(reference);
      if (list) list.push(node);
      else referencedBy.set(reference, [node]);
    }
  }
  const groups = new Map<Thread, [Message, ...Message[]]>();
  for (const node of nodes) {
    const thread = root(node);
    const group = groups.get(thread);
    if (group) group.push(node.message);
    else groups.set(thread, [node.message]);
  }
  return sortGroups([...groups.values()]);
}

export const sortGroups = (groups: [Message, ...Message[]][]) =>
  groups
    .map((group) => ({ group: group.sort((a, b) => b.timestamp - a.timestamp || b.uid - a.uid), unread: Number(group.some((message) => !message.isRead)) }))
    .sort((a, b) => b.unread - a.unread || b.group[0].timestamp - a.group[0].timestamp || b.group[0].uid - a.group[0].uid)
    .map(({ group }): Message[] => group);

export const SUBJECT_PREFIX = /^(?:(?:re|fw|fwd|aw|antw|回复|转发):\p{White_Space}*)+/iu;

export const subjectKey = (subject: string) => subject.replace(SUBJECT_PREFIX, "").trim().toLowerCase();
