import tls from "node:tls";
import type { Socket, SocketHandler } from "bun";

let trusted: string[] | null = null;
export const certificates = () => (trusted ??= [...tls.getCACertificates("system")]);
const encoder = new TextEncoder();

export class Stream {
  #socket: Socket<Stream>;
  #chunks: Uint8Array[] = [];
  #size = 0;
  #ended = false;
  #secured = false;
  #error: Error | null = null;
  #notify = () => {};

  private constructor(socket: Socket<Stream>) {
    this.#socket = socket;
    socket.data = this;
  }

  static async connect(hostname: string, port: number): Promise<Stream> {
    let timer: Timer | undefined;
    const connecting = Bun.connect<Stream>({ hostname, port, socket: { ...Stream.#handlers, open: (socket) => void new Stream(socket) } });
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        connecting.then((socket) => socket.terminate(), () => {});
        reject(new Error("Connection timed out"));
      }, 15_000);
    });
    return (await Promise.race([connecting, timeout]).finally(() => clearTimeout(timer))).data;
  }

  async upgrade(serverName: string): Promise<void> {
    this.#socket = this.#socket.upgradeTLS<Stream>({ data: this, tls: { ca: certificates(), serverName }, socket: Stream.#handlers })[1];
    while (!this.#secured) {
      if (this.#ended) throw this.#error ?? new Error("Connection closed during TLS handshake");
      await this.#wait();
    }
  }

  async line(): Promise<Uint8Array | null> {
    for (let scanned = 0; ; ) {
      const end = this.#find(scanned);
      if (end >= 0) return this.#take(end + 1);
      if (this.#ended) return this.#size ? this.#take(this.#size) : this.#eof();
      scanned = this.#size;
      await this.#wait();
    }
  }

  async bytes(count: number): Promise<Uint8Array | null> {
    while (this.#size < count) {
      if (this.#ended) return this.#eof();
      await this.#wait();
    }
    return this.#take(count);
  }

  async write(data: string | Uint8Array): Promise<void> {
    for (let bytes = typeof data === "string" ? encoder.encode(data) : data; ; await this.#wait()) {
      if (this.#ended) throw this.#error ?? new Error("Broken pipe (os error 32)");
      bytes = bytes.subarray(Math.max(this.#socket.write(bytes), 0));
      if (!bytes.length) return;
    }
  }

  close() {
    this.#ended = true;
    this.#socket.end();
    this.#notify();
  }

  #eof() {
    if (this.#error) throw this.#error;
    return null;
  }

  #fail(error: Error) {
    this.#error ??= error;
    this.close();
  }

  #wait() {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => this.#fail(new Error("Resource temporarily unavailable (os error 11)")), 30_000);
      this.#notify = () => {
        clearTimeout(timer);
        this.#notify = () => {};
        resolve();
      };
    });
  }

  #find(from: number) {
    let offset = 0;
    for (const chunk of this.#chunks) {
      if (offset + chunk.length > from) {
        const index = chunk.indexOf(10, Math.max(from - offset, 0));
        if (index >= 0) return offset + index;
      }
      offset += chunk.length;
    }
    return -1;
  }

  #take(count: number) {
    this.#size -= count;
    const [first] = this.#chunks;
    if (first && first.length >= count) {
      if (first.length === count) this.#chunks.shift();
      else this.#chunks[0] = first.subarray(count);
      return first.subarray(0, count);
    }
    const result = new Uint8Array(count);
    let filled = 0;
    let consumed = 0;
    for (const chunk of this.#chunks) {
      const part = chunk.subarray(0, count - filled);
      result.set(part, filled);
      filled += part.length;
      if (part.length < chunk.length) {
        this.#chunks[consumed] = chunk.subarray(part.length);
        break;
      }
      consumed++;
      if (filled === count) break;
    }
    this.#chunks.splice(0, consumed);
    return result;
  }

  static #handlers: SocketHandler<Stream> = {
    data(socket, chunk) {
      const stream = socket.data;
      if (socket !== stream.#socket) return;
      stream.#chunks.push(chunk);
      stream.#size += chunk.length;
      stream.#notify();
    },
    drain(socket) {
      socket.data.#notify();
    },
    handshake(socket, success, error) {
      const stream = socket.data;
      stream.#secured = success;
      if (error && !success) stream.#fail(error);
      stream.#notify();
    },
    error(socket, error) {
      socket.data.#fail(error);
    },
    close(socket, error) {
      const stream = socket.data;
      if (error) stream.#error ??= error;
      stream.#ended = true;
      stream.#notify();
    },
  };
}
