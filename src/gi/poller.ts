import { dlopen } from "bun:ffi";

declare const self: Worker;

const { poll } = dlopen("libc.so.6", { poll: { args: ["ptr", "u64", "i32"], returns: "i32" } }).symbols;
let descriptors: Int32Array<ArrayBufferLike> = new Int32Array(2);

self.onmessage = ({ data }: MessageEvent<Int32Array | { count: number; timeout: number }>) => {
  if (data instanceof Int32Array) {
    descriptors = data;
    return;
  }
  poll(descriptors, data.count, data.timeout);
  self.postMessage(null);
};
