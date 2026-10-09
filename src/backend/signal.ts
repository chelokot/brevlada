export class Signal {
  #next = Promise.withResolvers<void>();

  wait() {
    return this.#next.promise;
  }

  notify() {
    this.#next.resolve();
    this.#next = Promise.withResolvers();
  }
}
