import type { Account } from "../models";
import type { BodyQueue } from "./body-queue";
import { Mail } from "./mail";
import type { Stream } from "./stream";

export class Connections {
  #pool = new Map<string, { mail: Mail; used: number }>();
  #queue: Promise<unknown> = Promise.resolve();

  execute<T>(account: Account, operation: (mail: Mail) => Promise<T>): Promise<T> {
    return this.#serialize(async () => {
      for (const [path, { mail, used }] of this.#pool) if (performance.now() - used >= 300_000) this.#remove(path, mail);
      for (let attempt = 0; ; attempt++) {
        const pooled = this.#pool.get(account.path);
        const mail = pooled ? pooled.mail : await Mail.connect(account);
        this.#pool.set(account.path, { mail, used: performance.now() });
        try {
          return await operation(mail);
        } catch (error) {
          this.#remove(account.path, mail);
          if (attempt === 1) throw error;
        }
      }
    });
  }

  executeBody<T>(account: Account, queue: BodyQueue, selection: number, operation: (mail: Mail) => Promise<T>): Promise<T> {
    return this.#serialize(async () => {
      for (let attempt = 0; ; attempt++) {
        if (!queue.current(selection)) throw new Error("Message selection changed");
        using watching = new DisposableStack();
        const watch = (stream: Stream) => {
          const active = queue.watch(selection, () => stream.close());
          if (!active) throw new Error("Message selection changed");
          watching.use(active);
        };
        const pooled = this.#pool.get(account.path);
        const mail = pooled ? pooled.mail : await Mail.connect(account, watch);
        if (pooled) watch(mail.session.stream);
        this.#pool.set(account.path, { mail, used: performance.now() });
        try {
          return await operation(mail);
        } catch (error) {
          this.#remove(account.path, mail);
          if (attempt === 1 || !queue.current(selection)) throw error;
        }
      }
    });
  }

  #remove(path: string, mail: Mail) {
    this.#pool.delete(path);
    void mail.logout();
  }

  #serialize<T>(task: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(task);
    this.#queue = result.catch(() => {});
    return result;
  }
}
