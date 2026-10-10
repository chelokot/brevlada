import { spawn } from "../gi";
import type { Account } from "../models";
import type { Status } from "../models/sync";
import { backendWorker } from "../workers";
import type { BodyRequest, Command, Event } from "./protocol";

export type Delivered = Exclude<Event, { type: "SyncStatus" }>;

export class MailWorker {
  #request = 0;
  #status: Status | null = null;

  constructor(readonly send: (command: Command) => void) {}

  static start(path: string, listener: (event: Delivered) => void) {
    const backend = spawn(backendWorker);
    const worker = new MailWorker((command) => backend.postMessage(command));
    backend.onmessage = ({ data }: MessageEvent<Event>) => {
      if (data.type === "SyncStatus") worker.#status = data.status;
      else listener(data);
    };
    backend.postMessage(path);
    return worker;
  }

  static recording(): [worker: MailWorker, commands: Command[]] {
    const commands: Command[] = [];
    return [new MailWorker((command) => commands.push(command)), commands];
  }

  nextRequest() {
    return ++this.#request;
  }

  register(account: Account, expanded: boolean) {
    this.send({ type: "Register", account, expanded });
  }

  retainAccounts(accounts: Account[]) {
    this.send({ type: "RetainAccounts", accounts });
  }

  avatars(email: string) {
    this.send({ type: "Avatar", email });
  }

  expanded(email: string, expanded: boolean) {
    this.send({ type: "Expanded", email, expanded });
  }

  sync() {
    this.send({ type: "Sync" });
  }

  syncStatus() {
    return this.#status;
  }

  focus(account: string, folder: string) {
    this.send({ type: "Focus", account, folder });
  }

  select(selection: number) {
    this.send({ type: "Select", selection });
  }

  body(request: BodyRequest) {
    this.send({ type: "Body", request });
  }

  stop() {
    this.send({ type: "Stop" });
  }
}
