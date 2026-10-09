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
