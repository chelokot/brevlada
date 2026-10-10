import type { Count, Progress } from "../models/sync";
import { sameAscii } from "../models/text";

export interface Inventory {
  validity: number;
  live: number[];
  needed: number[];
  headersCached: boolean;
}

interface Folder {
  validity: number;
  needed: Set<number>;
  cached: Set<number>;
  headersCached: boolean;
}

interface Account {
  folders: Set<string> | null;
  inventories: Map<string, Folder>;
}

export const isInbox = (folder: string) => sameAscii(folder, "INBOX");

const key = (folder: string) => (isInbox(folder) ? "INBOX" : folder);

const unknown = (): Progress => ({ accounts: null, folders: null, messages: null });

const add = (sum: Count | null, count: Count | null) => sum && count && { cached: sum.cached + count.cached, total: sum.total + count.total };

export class Tracker {
  #accounts = new Map<string, Account>();

  overall(accounts: Iterable<string>): Progress {
    const counted: Count = { cached: 0, total: 0 };
    let folders: Count | null = { cached: 0, total: 0 };
    let messages: Count | null = { cached: 0, total: 0 };
    for (const account of accounts) {
      const progress = this.progress(account);
      counted.total++;
      counted.cached += Number(progress.folders !== null && progress.folders.cached === progress.folders.total);
      folders = add(folders, progress.folders);
      messages = add(messages, progress.messages);
    }
    return counted.total ? { accounts: counted, folders, messages } : unknown();
  }

  discovered(account: string, folders: string[]) {
    this.#account(account).folders = new Set(folders.map(key));
  }

  inventory(account: string, name: string, { validity, live, needed, headersCached }: Inventory) {
    const inventories = this.#account(account).inventories;
    const previous = inventories.get(key(name));
    const current = previous && previous.validity === validity ? previous : { needed: new Set<number>(), cached: new Set<number>() };
    const alive = new Set(live);
    const wanted = new Set(needed);
    const kept = current.needed.intersection(alive);
    const cached = current.cached.intersection(alive).union(kept.difference(wanted));
    inventories.set(key(name), { validity, needed: kept.union(wanted), cached, headersCached });
  }

  bodyCached(account: string, name: string, validity: number, uid: number) {
    const folder = this.#folder(account, name, validity);
    if (folder && folder.needed.has(uid)) folder.cached.add(uid);
  }

  headersCached(account: string, name: string, validity: number) {
    const folder = this.#folder(account, name, validity);
    if (folder) folder.headersCached = true;
  }

  progress(name: string): Progress {
    const account = this.#accounts.get(name);
    if (!account || !account.folders) return unknown();
    let complete = 0;
    const messages: Count = { cached: 0, total: 0 };
    let known = true;
    for (const folder of account.folders) {
      const inventory = account.inventories.get(folder);
      if (!inventory) {
        known = false;
        continue;
      }
      messages.cached += inventory.cached.size;
      messages.total += inventory.needed.size;
      complete += Number(inventory.headersCached && inventory.cached.size === inventory.needed.size);
    }
    return { accounts: null, folders: { cached: complete, total: account.folders.size }, messages: known ? messages : null };
  }

  #account(name: string) {
    const account = this.#accounts.get(name) ?? { folders: null, inventories: new Map() };
    this.#accounts.set(name, account);
    return account;
  }

  #folder(account: string, name: string, validity: number) {
    const folder = this.#accounts.get(account)?.inventories.get(key(name));
    return folder && folder.validity === validity ? folder : null;
  }
}
