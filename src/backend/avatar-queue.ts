import type { Account } from "../models";
import { isGoogle, type Credential } from "./avatars";
import { Signal } from "./signal";

export class AvatarQueue {
  #closed = false;
  #requests = new Set<string>();
  #accounts: Account[] = [];
  #unauthorized = new Set<string>();
  #signal = new Signal();

  retainAccounts(accounts: Account[]) {
    const live = new Set(accounts.map((account) => account.email));
    this.#accounts = this.#accounts.filter((account) => live.has(account.email));
    this.#unauthorized = this.#unauthorized.intersection(live);
  }

  register(account: Account) {
    const index = this.#accounts.findIndex((existing) => existing.email === account.email);
    if (index < 0) this.#accounts.push(account);
    else this.#accounts[index] = account;
  }

  credentials(): Credential[] {
    return this.#accounts.filter(isGoogle).map((account) => ({ account, search: !this.#unauthorized.has(account.email) }));
  }

  unauthorized(emails: string[]) {
    for (const email of emails) this.#unauthorized.add(email);
  }

  push(email: string) {
    if (this.#closed || !email) return;
    this.#requests.add(email);
    this.#signal.notify();
  }

  async pop(): Promise<string | null> {
    while (!this.#closed) {
      const [email] = this.#requests;
      if (email !== undefined) {
        this.#requests.delete(email);
        return email;
      }
      await this.#signal.wait();
    }
    return null;
  }

  close() {
    this.#closed = true;
    this.#requests.clear();
    this.#signal.notify();
  }
}
