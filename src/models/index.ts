import type { Details } from "./attachment";
import type { Event } from "./calendar";
import type { Parcel } from "./parcel";
import type { Target } from "./draft";
import type { Reservation } from "./ticket";

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
