import { glib, libc } from "./native";

declare const self: Worker;

const context = glib.g_main_context_default()!;
const priority = new Int32Array(1);
const timeout = new Int32Array(1);
let capacity = 0;
let descriptors: Int32Array<ArrayBufferLike> = new Int32Array(0);
let count = 0;
let worker: Worker | undefined;
let scheduled: ReturnType<typeof setImmediate> | undefined;

export const loop = { sleeping: false };

function poller() {
  const poll = import("bun:ffi").then(({ dlopen }) => dlopen("libc.so.6", { poll: { args: ["ptr", "u64", "i32"], returns: "i32" } }).symbols.poll);
  let descriptors: Int32Array<ArrayBufferLike> = new Int32Array(2);
  self.onmessage = async ({ data }: MessageEvent<Int32Array | { count: number; timeout: number }>) => {
    if (data instanceof Int32Array) {
      descriptors = data;
      return;
    }
    (await poll)(descriptors, data.count, data.timeout);
    self.postMessage(null);
  };
}

export function wake() {
  loop.sleeping = false;
  glib.g_main_context_wakeup(context);
}

function resize() {
  capacity = Math.max(count, capacity * 2, 16);
  descriptors = new Int32Array(new SharedArrayBuffer(capacity * 8));
  worker!.postMessage(descriptors);
}

function prepare() {
  glib.g_main_context_prepare(context, priority);
  while ((count = glib.g_main_context_query(context, priority[0]!, timeout, descriptors, capacity)) > capacity) resize();
  if (timeout[0] === 0) {
    libc.poll(descriptors, count, 0);
    return dispatch();
  }
  loop.sleeping = true;
  worker!.postMessage({ count, timeout: timeout[0] });
}

function dispatch() {
  loop.sleeping = false;
  if (glib.g_main_context_check(context, priority[0]!, descriptors, count)) glib.g_main_context_dispatch(context);
  scheduled = setImmediate(prepare);
}

export function startLoop() {
  if (worker) return;
  glib.g_main_context_acquire(context);
  worker = new Worker(URL.createObjectURL(new Blob([`(${poller})()`], { type: "text/javascript" })));
  worker.onmessage = dispatch;
  worker.ref();
  resize();
  prepare();
}

export function stopLoop() {
  clearImmediate(scheduled);
  worker?.terminate();
  worker = undefined;
}
