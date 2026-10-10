import type { BodyRequest } from "./protocol";
import { Signal } from "./signal";

export class BodyQueue {
  #selection = 0;
  #closed = false;
  #requests: BodyRequest[] = [];
  #cancels = new Set<() => void>();
  #signal = new Signal();

  select(selection: number) {
    this.#selection = selection;
    this.#requests = [];
    this.#interrupt();
  }

  current(selection: number) {
    return !this.#closed && this.#selection === selection;
  }

  push(request: BodyRequest) {
    if (!this.current(request.selection)) return;
    if (request.markRead) this.#requests.unshift(request);
    else this.#requests.push(request);
    this.#signal.notify();
  }

  async pop(): Promise<BodyRequest | null> {
    while (!this.#closed) {
      const request = this.#requests.shift();
      if (request) return request;
      await this.#signal.wait();
    }
    return null;
  }

  watch(selection: number, cancel: () => void): Disposable | null {
    if (!this.current(selection)) {
      cancel();
      return null;
    }
    this.#cancels.add(cancel);
    return { [Symbol.dispose]: () => this.#cancels.delete(cancel) };
  }

  close() {
    this.#closed = true;
    this.#interrupt();
    this.#signal.notify();
  }

  #interrupt() {
    for (const cancel of this.#cancels) cancel();
    this.#cancels.clear();
  }
}
