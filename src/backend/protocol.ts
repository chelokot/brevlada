import type { Account, Draft, Message, SentMessage } from "../models";
import type { ActionTarget } from "../models/action-target";
import type { Event as CalendarEvent, Response } from "../models/calendar";
import type { Outcome, Saved, Target } from "../models/draft";
import type { Identifier } from "../models/parcel/history";
import type { SenderAction } from "../models/sender-action";
import type { Status } from "../models/sync";

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export type UnsubscribeOutcome = { kind: "Open"; url: string } | { kind: "Done" };

export interface BodyRequest {
  account: Account;
  folder: string;
  uid: number;
  generation: number;
  selection: number;
  markRead: boolean;
}

export type Command =
  | { type: "FlushNotifications" }
  | { type: "NotificationsHandled"; account: string; folder: string; validity: number; uids: number[] }
  | { type: "OpenNotification"; account: string; validity: number; uid: number }
  | { type: "CalendarHistory"; account: Account; uid: string; generation: number }
  | { type: "CalendarReply"; account: Account; message: Message; event: CalendarEvent; response: Response }
  | { type: "ParcelHistory"; account: Account; folder: string; sender: string; identifier: Identifier; generation: number; selection: number }
  | { type: "Unsubscribe"; account: Account; folder: string; uid: number; messageId: string }
  | { type: "SaveDraft"; account: Account; draft: Draft; target: Target | null; request: number }
  | { type: "Compose"; account: Account; draft: Draft; target: Target | null; request: number }
  | { type: "DeleteDraft"; account: Account; target: Target; request: number }
  | { type: "RelatedSent"; account: Account; folder: string; messages: Message[]; generation: number; selection: number }
  | { type: "SentBody"; account: Account; folder: string; uid: number; generation: number; selection: number }
  | { type: "UndoSpam"; account: Account; folder: string; originals: Message[] }
  | { type: "SenderAction"; account: Account; folder: string; sender: ActionTarget; action: SenderAction }
  | { type: "Discover" }
  | { type: "Sync" }
  | { type: "Folders"; account: Account }
  | { type: "Load"; account: Account; folder: string; generation: number }
  | { type: "LoadSenderPage"; account: Account; folder: string; sender: string; generation: number; senderGeneration: number; before: [timestamp: number, uid: number] | null; limit: number }
  | { type: "Register"; account: Account; expanded: boolean }
  | { type: "RetainAccounts"; accounts: Account[] }
  | { type: "Expanded"; email: string; expanded: boolean }
  | { type: "Focus"; account: string; folder: string }
  | { type: "Select"; selection: number }
  | { type: "Body"; request: BodyRequest }
  | { type: "Avatar"; email: string }
  | { type: "Stop" };

export type Event =
  | { type: "NewMail"; account: string; folder: string; validity: number; messages: Message[] }
  | { type: "NotificationOpened"; account: string; result: Result<Message | null> }
  | { type: "CalendarHistory"; generation: number; uid: string; result: Result<Message[]> }
  | { type: "CalendarReplied"; account: string; uid: string; recurrenceId: string | null; result: Result<Message> }
  | { type: "ParcelHistory"; generation: number; selection: number; sender: string; identifier: Identifier; messages: Message[] }
  | { type: "Unsubscribe"; account: string; folder: string; uid: number; messageId: string; result: Result<UnsubscribeOutcome> }
  | { type: "DraftSaved"; request: number; result: Result<Saved> }
  | { type: "Composed"; request: number; result: Result<Outcome> }
  | { type: "DraftDeleted"; request: number; result: Result<null> }
  | { type: "SentCacheChanged"; account: string }
  | { type: "RelatedSent"; generation: number; selection: number; messages: SentMessage[] }
  | { type: "SentBody"; generation: number; selection: number; folder: string; uid: number; result: Result<Message> }
  | { type: "SpamUndoFinished"; account: string; folder: string; originals: Message[]; restored: Message[]; messages: Message[] | null; error: string | null }
  | { type: "SenderActionFinished"; account: string; folder: string; sender: ActionTarget; messages: Message[] | null; error: string | null; removed: Message[] }
  | { type: "Accounts"; accounts: Account[] }
  | { type: "SidebarReady" }
  | { type: "Folders"; account: string; folders: string[] }
  | { type: "Unread"; account: string; folders: [folder: string, unread: boolean][] }
  | { type: "UnreadSnapshot"; account: string; folders: [folder: string, unread: boolean][] }
  | { type: "Messages"; generation: number; messages: Message[]; cached: boolean }
  | { type: "SenderPage"; generation: number; senderGeneration: number; messages: Message[]; hasMore: boolean }
  | { type: "SenderPageError"; generation: number; senderGeneration: number; error: string }
  | { type: "Body"; generation: number; selection: number; message: Message }
  | { type: "BodyError"; generation: number; selection: number; uid: number; error: string }
  | { type: "Preview"; generation: number; selection: number; message: Message }
  | { type: "PreviewError"; generation: number; selection: number; uid: number }
  | { type: "CacheList"; account: string; folder: string; messages: Message[] }
  | { type: "CacheBody"; account: string; folder: string; message: Message }
  | { type: "Avatar"; email: string; image: Uint8Array | null }
  | { type: "SyncStatus"; status: Status | null }
  | { type: "Error"; generation: number | null; error: string };

export type Emit = (event: Event) => void;

export const failure = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function attempt<T>(run: () => T | Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, error: failure(error) };
  }
}
