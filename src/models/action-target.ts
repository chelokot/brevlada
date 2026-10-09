export type ActionTarget = { kind: "Sender"; sender: string } | { kind: "Messages"; messages: [uid: number, messageId: string][] };
