import { glib, libc } from "./native";

const context = glib.g_main_context_default()!;
const priority = new Int32Array(1);
const timeout = new Int32Array(1);
let capacity = 0;
let descriptors: Int32Array<ArrayBufferLike> = new Int32Array(0);
let count = 0;
let poller: Worker | undefined;
let scheduled: ReturnType<typeof setImmediate> | undefined;

export const loop = { sleeping: false };

export function wake() {
  loop.sleeping = false;
  glib.g_main_context_wakeup(context);
}

function resize() {
  capacity = Math.max(count, capacity * 2, 16);
  descriptors = new Int32Array(new SharedArrayBuffer(capacity * 8));
  poller!.postMessage(descriptors);
}

function prepare() {
  glib.g_main_context_prepare(context, priority);
  while ((count = glib.g_main_context_query(context, priority[0]!, timeout, descriptors, capacity)) > capacity) resize();
  if (timeout[0] === 0) {
    libc.poll(descriptors, count, 0);
    return dispatch();
  }
  loop.sleeping = true;
  poller!.postMessage({ count, timeout: timeout[0] });
}

function dispatch() {
  loop.sleeping = false;
  if (glib.g_main_context_check(context, priority[0]!, descriptors, count)) glib.g_main_context_dispatch(context);
  scheduled = setImmediate(prepare);
}

export function startLoop() {
  if (poller) return;
  glib.g_main_context_acquire(context);
  poller = new Worker(new URL("./poller.ts", import.meta.url));
  poller.onmessage = dispatch;
  poller.ref();
  resize();
  prepare();
}

export function stopLoop() {
  clearImmediate(scheduled);
  poller?.terminate();
  poller = undefined;
}
