export type SenderAction =
  | { kind: "MarkRead" }
  | { kind: "MarkUnread" }
  | { kind: "Star" }
  | { kind: "Unstar" }
  | { kind: "MoveTo"; folder: string }
  | { kind: "Restore" }
  | { kind: "Unspam" }
  | { kind: "Spam" }
  | { kind: "Archive" }
  | { kind: "Delete" };

type Kind = SenderAction["kind"];

export const ALL: [SenderAction, string][] = [
  [{ kind: "MarkRead" }, "Mark all as read"],
  [{ kind: "Spam" }, "Mark as spam"],
  [{ kind: "Archive" }, "Archive all"],
  [{ kind: "Delete" }, "Delete all"],
  [{ kind: "MarkUnread" }, "Mark all as unread"],
  [{ kind: "Star" }, "Star all"],
  [{ kind: "Unstar" }, "Unstar all"],
  [{ kind: "MoveTo", folder: "" }, "Move to…"],
  [{ kind: "Restore" }, "Restore from Trash"],
  [{ kind: "Unspam" }, "Not spam"],
];

const TITLES: Record<Kind, [bulk: string, single: string]> = {
  MarkRead: ["Mark all as read", "Mark as read"],
  MarkUnread: ["Mark all as unread", "Mark as unread"],
  Star: ["Star all", "Star"],
  Unstar: ["Unstar all", "Unstar"],
  MoveTo: ["Move to…", "Move to…"],
  Restore: ["Restore from Trash", "Restore from Trash"],
  Unspam: ["Not spam", "Not spam"],
  Spam: ["Mark as spam", "Mark as spam"],
  Archive: ["Archive all", "Archive"],
  Delete: ["Delete all", "Delete"],
};

const ICONS: Record<Kind, string> = {
  MarkRead: "brevlada-mail-read-symbolic",
  MarkUnread: "mail-unread-symbolic",
  Star: "starred-symbolic",
  Unstar: "non-starred-symbolic",
  MoveTo: "folder-symbolic",
  Restore: "edit-undo-symbolic",
  Unspam: "mail-mark-notjunk-symbolic",
  Spam: "mail-mark-junk-symbolic",
  Archive: "package-x-generic-symbolic",
  Delete: "user-trash-symbolic",
};

export const removesMessages = ({ kind }: SenderAction) => !["MarkRead", "MarkUnread", "Star", "Unstar"].includes(kind);

export const readState = ({ kind }: SenderAction) => (kind === "MarkRead" ? true : kind === "MarkUnread" ? false : null);

export const flaggedState = ({ kind }: SenderAction) => (kind === "Star" ? true : kind === "Unstar" ? false : null);

export const title = ({ kind }: SenderAction, bulk: boolean) => TITLES[kind][bulk ? 0 : 1];

export const icon = ({ kind }: SenderAction) => ICONS[kind];
