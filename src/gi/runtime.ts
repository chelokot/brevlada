import { CFunction, CString, FFIType, JSCallback, ptr, read, toArrayBuffer, type FFITypeOrString, type Pointer } from "bun:ffi";
import { loop, wake } from "./loop";
import { gi, glib, gobject } from "./native";

type Info = Pointer;
type Native = number | bigint | boolean | Pointer | NodeJS.TypedArray | null;
type Fn = (...args: unknown[]) => unknown;
export type Constructor = (abstract new (...args: never[]) => object) & Record<string | symbol, unknown>;

const Tag = { VOID: 0, BOOLEAN: 1, UINT8: 3, INT32: 6, UINT32: 7, GTYPE: 12, UTF8: 13, FILENAME: 14, ARRAY: 15, INTERFACE: 16, GLIST: 17, GSLIST: 18, ERROR: 20, UNICHAR: 21 } as const;
const Direction = { IN: 0, OUT: 1, INOUT: 2 } as const;
const Transfer = { NOTHING: 0, CONTAINER: 1, EVERYTHING: 2 } as const;
const Scope = { CALL: 1, ASYNC: 2 } as const;
const GType = { NONE: 4, INTERFACE: 8, CHAR: 12, UCHAR: 16, BOOLEAN: 20, INT: 24, UINT: 28, LONG: 32, ULONG: 36, INT64: 40, UINT64: 44, ENUM: 48, FLAGS: 52, FLOAT: 56, DOUBLE: 60, STRING: 64, POINTER: 68, BOXED: 72, PARAM: 76, OBJECT: 80, VARIANT: 84 } as const;
const IS_METHOD = 1;
const GVALUE_SIZE = 24;
const numberTypes: Record<number, FFITypeOrString> = { 2: "i8", 3: "u8", 4: "i16", 5: "u16", 6: "i32", 7: "u32", 8: FFIType.i64_fast, 9: FFIType.u64_fast, 10: "f32", 11: "f64" };
const slotSizes: Record<string, number> = { i8: 1, u8: 1, i16: 2, u16: 2, i32: 4, u32: 4, f32: 4 };

const repository = gi.gi_repository_new()!;
const infoTypes = {
  object: gi.gi_object_info_get_type(),
  interface: gi.gi_interface_info_get_type(),
  union: gi.gi_union_info_get_type(),
  struct: gi.gi_struct_info_get_type(),
  enum: gi.gi_enum_info_get_type(),
  flags: gi.gi_flags_info_get_type(),
  callback: gi.gi_callback_info_get_type(),
  constant: gi.gi_constant_info_get_type(),
  function: gi.gi_function_info_get_type(),
};

export const text = (value: string) => Buffer.from(`${value}\0`);
const readString = (address: Pointer | null) => (address ? new CString(address).toString() : null);
const infoKind = (info: Info) => Number(read.u64(read.ptr(info), 0));
const typeOf = (instance: Pointer) => Number(read.u64(read.ptr(instance), 0));
const nameOf = (info: Info) => String(gi.gi_base_info_get_name(info));
const qualifiedName = (info: Info) => `${gi.gi_base_info_get_namespace(info)}.${nameOf(info)}`;
const withoutStaticScope = (gtype: bigint | number) => Number(BigInt(gtype) & ~1n);
const camel = (name: string) => name.replace(/[-_]([a-z0-9])/g, (_, letter: string) => letter.toUpperCase());
const kebab = (name: string) => name.replace(/_/g, "-").replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
const indexOut = (query: (info: Info, out: Uint32Array) => number, info: Info) => {
  const out = new Uint32Array(1);
  return query(info, out) ? out[0]! : -1;
};

export class GLibError extends Error {
  constructor(
    readonly domain: number,
    readonly code: number,
    message: string,
  ) {
    super(message);
  }

  override matches(domain: number | { $domain: number }, code: number) {
    return this.domain === (typeof domain === "number" ? domain : domain.$domain) && this.code === code;
  }
}

function takeError(slot: BigUint64Array) {
  const error = Number(slot[0]) as Pointer;
  if (!error) return;
  const thrown = new GLibError(read.u32(error, 0), read.i32(error, 4), readString(read.ptr(error, 8) as Pointer) ?? "");
  glib.g_error_free(error);
  throw thrown;
}

function guarded<T>(fn: () => T) {
  try {
    return fn();
  } catch (error) {
    console.error(error);
    return undefined;
  }
}

type Desc =
  | { kind: "void" | "bool" | "gtype" | "unichar" | "string" | "pointer" | "error" | "variant" | "param"; ffi: FFITypeOrString }
  | { kind: "number" | "enum"; ffi: FFITypeOrString }
  | { kind: "object"; ffi: "ptr"; info: Info }
  | { kind: "struct"; ffi: "ptr"; info: Info; gtype: number; size: number; byValue: boolean }
  | { kind: "callback"; ffi: "ptr"; info: Info }
  | { kind: "array"; ffi: "ptr"; item: Desc; length: number; fixed: number; zero: boolean }
  | { kind: "list"; ffi: "ptr"; item: Desc; single: boolean };
type ArrayDesc = Extract<Desc, { kind: "array" }>;
type StructDesc = Extract<Desc, { kind: "struct" }>;

function describe(type: Info): Desc {
  const tag = gi.gi_type_info_get_tag(type);
  if (numberTypes[tag]) return { kind: "number", ffi: numberTypes[tag]! };
  switch (tag) {
    case Tag.VOID:
      return gi.gi_type_info_is_pointer(type) ? { kind: "pointer", ffi: "ptr" } : { kind: "void", ffi: "void" };
    case Tag.BOOLEAN:
      return { kind: "bool", ffi: "i32" };
    case Tag.GTYPE:
      return { kind: "gtype", ffi: FFIType.u64_fast };
    case Tag.UNICHAR:
      return { kind: "unichar", ffi: "u32" };
    case Tag.UTF8:
    case Tag.FILENAME:
      return { kind: "string", ffi: "ptr" };
    case Tag.ERROR:
      return { kind: "error", ffi: "ptr" };
    case Tag.GLIST:
    case Tag.GSLIST:
      return { kind: "list", ffi: "ptr", item: describe(gi.gi_type_info_get_param_type(type, 0)!), single: tag === Tag.GSLIST };
    case Tag.ARRAY: {
      const fixed = new BigUint64Array(1);
      return {
        kind: "array",
        ffi: "ptr",
        item: describe(gi.gi_type_info_get_param_type(type, 0)!),
        length: indexOut(gi.gi_type_info_get_array_length_index, type),
        fixed: gi.gi_type_info_get_array_fixed_size(type, fixed) ? Number(fixed[0]) : -1,
        zero: gi.gi_type_info_is_zero_terminated(type) !== 0,
      };
    }
  }
  const info = gi.gi_type_info_get_interface(type)!;
  const kind = infoKind(info);
  if (kind === infoTypes.enum || kind === infoTypes.flags) return { kind: "enum", ffi: gi.gi_enum_info_get_storage_type(info) === Tag.UINT32 ? "u32" : "i32" };
  if (kind === infoTypes.callback) return { kind: "callback", ffi: "ptr", info };
  const gtype = gi.gi_registered_type_info_get_g_type(info);
  if (gtype === GType.PARAM) return { kind: "param", ffi: "ptr" };
  if (gtype === GType.VARIANT) return { kind: "variant", ffi: "ptr" };
  if (kind === infoTypes.object || kind === infoTypes.interface) return { kind: "object", ffi: "ptr", info };
  const size = kind === infoTypes.union ? gi.gi_union_info_get_size(info) : gi.gi_struct_info_get_size(info);
  return { kind: "struct", ffi: "ptr", info, gtype: gtype === GType.NONE ? 0 : gtype, size, byValue: !gi.gi_type_info_is_pointer(type) };
}

function readSlot(desc: Desc, address: Pointer, offset: number): Native {
  switch (desc.ffi) {
    case "i8":
      return read.i8(address, offset);
    case "u8":
      return read.u8(address, offset);
    case "i16":
      return read.i16(address, offset);
    case "u16":
      return read.u16(address, offset);
    case "i32":
      return read.i32(address, offset);
    case "u32":
      return read.u32(address, offset);
    case "f32":
      return read.f32(address, offset);
    case "f64":
      return read.f64(address, offset);
    case FFIType.i64_fast:
      return Number(read.i64(address, offset));
    case FFIType.u64_fast:
      return Number(read.u64(address, offset));
    default:
      return read.ptr(address, offset) as Pointer;
  }
}

function writeSlot(desc: Desc, view: DataView, offset: number, value: Native) {
  switch (desc.ffi) {
    case "i8":
    case "u8":
      return view.setUint8(offset, Number(value));
    case "i16":
    case "u16":
      return view.setUint16(offset, Number(value), true);
    case "i32":
    case "u32":
      return view.setUint32(offset, Number(value) >>> 0, true);
    case "f32":
      return view.setFloat32(offset, Number(value), true);
    case "f64":
      return view.setFloat64(offset, Number(value), true);
    default:
      return view.setBigUint64(offset, BigInt(value && typeof value === "object" ? ptr(value) : Number(value ?? 0)), true);
  }
}

function toNative(desc: Desc, value: unknown, transfer: number, keep: unknown[]): Native {
  switch (desc.kind) {
    case "bool":
      return value ? 1 : 0;
    case "number":
    case "enum":
    case "gtype":
      return (value as number | undefined) ?? 0;
    case "unichar":
      return typeof value === "string" ? value.codePointAt(0)! : (value as number);
    case "pointer":
      return (value as Pointer | null | undefined) ?? null;
    case "string": {
      if (value === null || value === undefined) return null;
      const buffer = text(String(value));
      if (transfer === Transfer.EVERYTHING) return glib.g_strdup(buffer);
      keep.push(buffer);
      return buffer;
    }
    case "array":
      return arrayToNative(desc, value, keep);
  }
  if (typeof value === "function") return closureFor(value as Fn);
  const address = (value as Instance | null | undefined)?.ptr ?? null;
  if (!address || transfer !== Transfer.EVERYTHING) return address;
  if (desc.kind === "object") gobject.g_object_ref(address);
  if (desc.kind === "variant") glib.g_variant_ref_sink(address);
  if (desc.kind === "struct" && desc.gtype) return gobject.g_boxed_copy(desc.gtype, address);
  return address;
}

function arrayToNative(desc: ArrayDesc, value: unknown, keep: unknown[]): Native {
  if (value === null || value === undefined) return null;
  if (desc.item.ffi === "u8") {
    const bytes = typeof value === "string" ? Buffer.from(value) : (value as Uint8Array);
    const owned = desc.zero ? Buffer.concat([bytes, new Uint8Array(1)]) : bytes;
    keep.push(owned);
    return owned.byteLength ? owned : null;
  }
  const items = value as unknown[];
  const size = slotSizes[String(desc.item.ffi)] ?? 8;
  const buffer = new Uint8Array((items.length + (desc.zero ? 1 : 0)) * size || 8);
  const view = new DataView(buffer.buffer);
  items.forEach((item, index) => writeSlot(desc.item, view, index * size, toNative(desc.item, item, Transfer.NOTHING, keep)));
  keep.push(buffer);
  return buffer;
}

const arrayLength = (value: unknown) => (typeof value === "string" ? Buffer.byteLength(value) : ((value as ArrayLike<unknown> | null | undefined)?.length ?? 0));

function fromNative(desc: Desc, raw: Native, transfer: number, length = -1): unknown {
  switch (desc.kind) {
    case "void":
      return undefined;
    case "bool":
      return raw !== 0;
    case "unichar":
      return String.fromCodePoint(raw as number);
    case "string": {
      const value = readString(raw as Pointer);
      if (raw && transfer !== Transfer.NOTHING) glib.g_free(raw as Pointer);
      return value;
    }
    case "object":
      return wrapInstance(raw as Pointer | null, transfer === Transfer.EVERYTHING, desc.info);
    case "variant":
      return wrapVariant(raw as Pointer | null, transfer === Transfer.EVERYTHING);
    case "struct":
      return wrapStruct(desc, raw as Pointer | null, transfer === Transfer.EVERYTHING);
    case "param":
      return raw ? { name: String(gobject.g_param_spec_get_name(raw as Pointer)) } : null;
    case "list": {
      const items: unknown[] = [];
      for (let node = raw as Pointer | null; node; node = read.ptr(node, 8) as Pointer) {
        items.push(fromNative(desc.item, read.ptr(node, 0) as Pointer, transfer === Transfer.EVERYTHING ? transfer : Transfer.NOTHING));
      }
      if (raw && transfer !== Transfer.NOTHING) (desc.single ? glib.g_slist_free : glib.g_list_free)(raw as Pointer);
      return items;
    }
    case "array":
      return arrayFromNative(desc, raw as Pointer | null, transfer, length);
    default:
      return raw;
  }
}

function arrayFromNative(desc: ArrayDesc, address: Pointer | null, transfer: number, length: number) {
  if (!address) return desc.item.ffi === "u8" ? new Uint8Array() : [];
  const size = slotSizes[String(desc.item.ffi)] ?? 8;
  let count = length >= 0 ? length : desc.fixed;
  if (count < 0) for (count = 0; readSlot(desc.item, address, count * size); count++);
  const itemTransfer = transfer === Transfer.EVERYTHING ? transfer : Transfer.NOTHING;
  const result =
    desc.item.ffi === "u8"
      ? new Uint8Array(toArrayBuffer(address, 0, count).slice(0))
      : Array.from({ length: count }, (_, index) => fromNative(desc.item, readSlot(desc.item, address, index * size), itemTransfer));
  if (transfer !== Transfer.NOTHING) glib.g_free(address);
  return result;
}

interface ArgPlan {
  direction: number;
  transfer: number;
  desc: Desc;
  callerAllocates: boolean;
  closure: number;
  destroy: number;
  scope: number;
  hidden: boolean;
}

function planCallable(info: Info) {
  const args: ArgPlan[] = Array.from({ length: gi.gi_callable_info_get_n_args(info) }, (_, index) => {
    const arg = gi.gi_callable_info_get_arg(info, index)!;
    return {
      direction: gi.gi_arg_info_get_direction(arg),
      transfer: gi.gi_arg_info_get_ownership_transfer(arg),
      desc: describe(gi.gi_arg_info_get_type_info(arg)!),
      callerAllocates: gi.gi_arg_info_is_caller_allocates(arg) !== 0,
      closure: indexOut(gi.gi_arg_info_get_closure_index, arg),
      destroy: indexOut(gi.gi_arg_info_get_destroy_index, arg),
      scope: gi.gi_arg_info_get_scope(arg),
      hidden: false,
    };
  });
  const result = describe(gi.gi_callable_info_get_return_type(info)!);
  const byValue = [result, ...args.flatMap((arg) => (arg.direction === Direction.IN ? [arg.desc] : []))].find((desc) => desc.kind === "struct" && desc.byValue);
  if (byValue) throw new Error(`${qualifiedName(info)}: ${qualifiedName((byValue as StructDesc).info)} passed by value is not supported`);
  for (const desc of [...args.map((arg) => arg.desc), result]) if (desc.kind === "array" && desc.length >= 0) args[desc.length]!.hidden = true;
  for (const arg of args) {
    if (arg.desc.kind !== "callback") continue;
    if (arg.closure >= 0) args[arg.closure]!.hidden = true;
    if (arg.destroy >= 0) args[arg.destroy]!.hidden = true;
  }
  return { args, result, transfer: gi.gi_callable_info_get_caller_owns(info) };
}

function functionAddress(info: Info) {
  const symbol = String(gi.gi_function_info_get_symbol(info));
  const out = new BigUint64Array(1);
  if (!gi.gi_typelib_symbol(gi.gi_base_info_get_typelib(info)!, text(symbol), out)) throw new Error(`Missing symbol ${symbol}`);
  return Number(out[0]) as Pointer;
}

function compileFunction(info: Info, finish: () => Info | null, promised = false): Fn {
  const method = gi.gi_callable_info_is_method(info) !== 0;
  const throws = gi.gi_callable_info_can_throw_gerror(info) !== 0;
  const { args, result, transfer } = planCallable(info);
  const ffiArgs: FFITypeOrString[] = [...(method ? ["ptr" as const] : []), ...args.map((arg) => (arg.direction === Direction.IN ? arg.desc.ffi : "ptr")), ...(throws ? ["ptr" as const] : [])];
  const call = CFunction({ ptr: functionAddress(info), args: ffiArgs, returns: result.ffi });
  const visible = args.flatMap((arg, index) => (arg.hidden || arg.direction === Direction.OUT ? [] : [index]));
  const outputs = args.flatMap((arg, index) => (arg.hidden || arg.direction === Direction.IN ? [] : [index]));
  const objects = visible.flatMap((index, position) => (args[index]!.desc.kind === "object" ? [position] : []));
  const asyncPosition = visible.findIndex((index) => args[index]!.desc.kind === "callback" && args[index]!.scope === Scope.ASYNC);
  const offset = method ? 1 : 0;
  let finisher: Fn | undefined;

  const invoke = function (this: Instance, ...values: unknown[]): unknown {
    if (loop.sleeping) wake();
    if (asyncPosition >= 0 && values[asyncPosition] === undefined) {
      const finishInfo = finish();
      if (finishInfo) {
        finisher ??= compileFunction(finishInfo, () => null, true);
        return new Promise((resolve, reject) => {
          values[asyncPosition] = (source: Instance | null, result: Instance) => {
            try {
              resolve(finisher!.call(source ?? this, result));
            } catch (error) {
              reject(error);
            }
          };
          invoke.apply(this, values);
        });
      }
    }
    const keep: unknown[] = [];
    const native: Native[] = new Array(ffiArgs.length);
    const slots = new BigUint64Array(args.length + 1);
    const slotView = new DataView(slots.buffer);
    const slotAddress = ptr(slots);
    const structs: (Uint8Array | undefined)[] = [];
    const scoped: number[] = [];
    if (method) native[0] = this.ptr;
    visible.forEach((index, position) => {
      const arg = args[index]!;
      const value = values[position];
      if (arg.desc.kind === "callback") {
        if (typeof value !== "function") return (native[index + offset] = null);
        const native_ = callbackToNative(arg.desc.info, value as Fn, arg.scope);
        native[index + offset] = native_.address;
        if (arg.closure >= 0) native[arg.closure + offset] = native_.data;
        if (arg.destroy >= 0) native[arg.destroy + offset] = destroyNotify.ptr;
        if (arg.scope === Scope.CALL) scoped.push(Number(native_.data));
        return;
      }
      const converted = toNative(arg.desc, value, arg.transfer, keep);
      if (arg.direction === Direction.INOUT) {
        writeSlot(arg.desc, slotView, index * 8, converted);
        native[index + offset] = slotAddress + index * 8;
      } else native[index + offset] = converted;
      if (arg.desc.kind === "array" && arg.desc.length >= 0) {
        const lengthArg = args[arg.desc.length]!;
        if (lengthArg.direction === Direction.IN) native[arg.desc.length + offset] = arrayLength(value);
        else {
          writeSlot(lengthArg.desc, slotView, arg.desc.length * 8, arrayLength(value));
          native[arg.desc.length + offset] = slotAddress + arg.desc.length * 8;
        }
      }
    });
    args.forEach((arg, index) => {
      if (native[index + offset] !== undefined) return;
      if (arg.direction === Direction.IN) return (native[index + offset] = arg.desc.kind === "number" || arg.desc.kind === "enum" ? 0 : null);
      if (arg.callerAllocates && arg.desc.kind === "struct") return (native[index + offset] = structs[index] = new Uint8Array(arg.desc.size));
      native[index + offset] = slotAddress + index * 8;
    });
    if (throws) native[ffiArgs.length - 1] = slotAddress + args.length * 8;
    const raw = call(...native) as Native;
    for (const id of scoped) callbacks.delete(id);
    if (method && this instanceof ObjectBase) syncStrength(this);
    for (const position of objects) if (values[position] instanceof ObjectBase) syncStrength(values[position] as Instance);
    if (throws) takeError(slots.subarray(args.length));
    const lengthOf = (desc: Desc) => (desc.kind === "array" && desc.length >= 0 ? Number(readSlot(args[desc.length]!.desc, slotAddress, desc.length * 8)) : -1);
    const returned = result.kind === "void" ? [] : [fromNative(result, raw, transfer, lengthOf(result))];
    for (const index of outputs) {
      const arg = args[index]!;
      const buffer = structs[index];
      returned.push(buffer ? wrapStruct(arg.desc as StructDesc, ptr(buffer), true, buffer) : fromNative(arg.desc, readSlot(arg.desc, slotAddress, index * 8), arg.transfer, lengthOf(arg.desc)));
    }
    if (promised && throws && result.kind === "bool" && outputs.length > 0) returned.shift();
    return returned.length > 1 ? returned : returned[0];
  };
  return invoke;
}

const callbacks = new Map<number, { fn: Fn; scope: number }>();
const trampolines = new Map<string, Pointer>();
let callbackIds = 0;

const destroyNotify = new JSCallback((data: Pointer) => void callbacks.delete(Number(data)), { args: ["ptr"], returns: "void" });

function callbackToNative(info: Info, fn: Fn, scope: number) {
  const name = qualifiedName(info);
  const id = ++callbackIds;
  callbacks.set(id, { fn, scope });
  let address = trampolines.get(name);
  if (!address) {
    const { args, result, transfer } = planCallable(info);
    const closure = args.findIndex((_, index) => args.some((arg) => arg.closure === index));
    const userData = closure >= 0 ? closure : args.length - 1;
    if (args[userData]?.desc.kind !== "pointer") throw new Error(`Callback ${name} has no user data`);
    const trampoline = new JSCallback(
      (...raw: Native[]) => {
        const key = Number(raw[userData]);
        const callback = callbacks.get(key);
        if (!callback) return result.kind === "void" ? undefined : 0;
        if (callback.scope === Scope.ASYNC) callbacks.delete(key);
        const values = args.flatMap((arg, index) => (arg.hidden || index === userData ? [] : [fromNative(arg.desc, raw[index]!, arg.transfer)]));
        const returned = guarded(() => callback.fn(...values));
        return result.kind === "void" ? undefined : toNative(result, returned, transfer, []);
      },
      { args: args.map((arg) => (arg.direction === Direction.IN ? arg.desc.ffi : "ptr")), returns: result.ffi },
    );
    address = trampoline.ptr!;
    trampolines.set(name, address);
  }
  return { address, data: id as unknown as Pointer };
}

const HANDLERS = Symbol("handlers");

export class Instance {
  declare ptr: Pointer;
  declare [HANDLERS]: Map<number, Fn> | undefined;
}

interface WrapperEntry {
  ref: WeakRef<Instance>;
  token: object;
}

const wrappers = new Map<number, WrapperEntry>();
const strong = new Set<Instance>();
const classes = new Map<number, Constructor>();

function syncStrength(wrapper: Instance) {
  if (read.u32(wrapper.ptr, 8) > 1) strong.add(wrapper);
  else strong.delete(wrapper);
}

const toggleNotify = new JSCallback(
  (_: Pointer, object: Pointer) => {
    const wrapper = wrappers.get(object)?.ref.deref();
    if (wrapper) syncStrength(wrapper);
  },
  { args: ["ptr", "ptr", "i32"], returns: "void", threadsafe: true },
);

const objectFinalizer = new FinalizationRegistry<number>((address) => {
  wrappers.delete(address);
  gobject.g_object_remove_toggle_ref(address as Pointer, toggleNotify.ptr, null);
});

function adopt(wrapper: Instance, owned: boolean, previous?: WrapperEntry) {
  const address = wrapper.ptr;
  const token = {};
  if (previous && objectFinalizer.unregister(previous.token)) {
    if (owned) gobject.g_object_unref(address);
  } else {
    if (!owned || gobject.g_object_is_floating(address)) gobject.g_object_ref_sink(address);
    gobject.g_object_add_toggle_ref(address, toggleNotify.ptr, null);
    gobject.g_object_unref(address);
  }
  wrappers.set(address, { ref: new WeakRef(wrapper), token });
  objectFinalizer.register(wrapper, address, token);
  syncStrength(wrapper);
}

const fundamentalFinalizer = new FinalizationRegistry<[Pointer, Pointer]>(([unref, address]) => CFunction({ ptr: unref, args: ["ptr"], returns: "void" })(address));

function wrapInstance(address: Pointer | null, owned: boolean, info?: Info): Instance | null {
  if (!address) return null;
  if (info && infoKind(info) === infoTypes.object && gi.gi_object_info_get_fundamental(info)) {
    const wrapper = Object.create(classFor(typeOf(address)).prototype as object) as Instance;
    wrapper.ptr = address;
    if (!owned) CFunction({ ptr: gi.gi_object_info_get_ref_function_pointer(info)!, args: ["ptr"], returns: "ptr" })(address);
    fundamentalFinalizer.register(wrapper, [gi.gi_object_info_get_unref_function_pointer(info)!, address]);
    return wrapper;
  }
  return wrapObject(address, owned);
}

export function wrapObject<T = Instance>(address: Pointer | null, owned: boolean): T | null {
  if (!address) return null;
  const entry = wrappers.get(address);
  const alive = entry?.ref.deref();
  if (alive) {
    if (owned) gobject.g_object_unref(address);
    return alive as T;
  }
  const wrapper = Object.create(classFor(typeOf(address)).prototype as object) as Instance;
  wrapper.ptr = address;
  adopt(wrapper, owned, entry);
  return wrapper as T;
}

const variantFinalizer = new FinalizationRegistry<number>((address) => glib.g_variant_unref(address as Pointer));

export function wrapVariant(address: Pointer | null, owned: boolean) {
  if (!address) return null;
  const wrapper = Object.create(namespace("GLib")["Variant"]!.prototype as object) as Instance;
  wrapper.ptr = owned ? glib.g_variant_take_ref(address)! : glib.g_variant_ref_sink(address)!;
  variantFinalizer.register(wrapper, wrapper.ptr);
  return wrapper;
}

const boxedFinalizer = new FinalizationRegistry<[number, number]>(([gtype, address]) => gobject.g_boxed_free(gtype, address as Pointer));
const memory = new WeakMap<Instance, Uint8Array>();

function wrapStruct(desc: StructDesc, address: Pointer | null, owned: boolean, buffer?: Uint8Array) {
  if (!address) return null;
  const wrapper = Object.create(structClass(desc.info).prototype as object) as Instance;
  if (buffer) memory.set(wrapper, buffer);
  wrapper.ptr = desc.gtype && !buffer && !owned ? gobject.g_boxed_copy(desc.gtype, address)! : address;
  if (desc.gtype && !buffer) boxedFinalizer.register(wrapper, [desc.gtype, wrapper.ptr]);
  return wrapper;
}

const fundamentals = new Map<number, number>();
const fundamentalOf = (gtype: number) => fundamentals.get(gtype) ?? fundamentals.set(gtype, gobject.g_type_fundamental(gtype)).get(gtype)!;
const strvType = gobject.g_strv_get_type();
const initiallyUnowned = gobject.g_initially_unowned_get_type();
const gtypeType = gobject.g_gtype_get_type();
const stringArray: ArrayDesc = { kind: "array", ffi: "ptr", item: { kind: "string", ffi: "ptr" }, length: -1, fixed: -1, zero: true };

export function setValue(value: Pointer, gtype: number, data: unknown) {
  gobject.g_value_init(value, gtype);
  switch (fundamentalOf(gtype)) {
    case GType.BOOLEAN:
      return gobject.g_value_set_boolean(value, data ? 1 : 0);
    case GType.CHAR:
    case GType.INT:
      return gobject.g_value_set_int(value, data as number);
    case GType.UCHAR:
    case GType.UINT:
      return gobject.g_value_set_uint(value, data as number);
    case GType.LONG:
      return gobject.g_value_set_long(value, data as number);
    case GType.ULONG:
      return gobject.g_value_set_ulong(value, data as number);
    case GType.INT64:
      return gobject.g_value_set_int64(value, data as number);
    case GType.UINT64:
      return gobject.g_value_set_uint64(value, data as number);
    case GType.FLOAT:
      return gobject.g_value_set_float(value, data as number);
    case GType.DOUBLE:
      return gobject.g_value_set_double(value, data as number);
    case GType.STRING:
      return gobject.g_value_set_string(value, data === null || data === undefined ? null : text(String(data)));
    case GType.ENUM:
      return gobject.g_value_set_enum(value, data as number);
    case GType.FLAGS:
      return gobject.g_value_set_flags(value, data as number);
    case GType.OBJECT:
    case GType.INTERFACE:
      return gobject.g_value_set_object(value, (data as Instance | null)?.ptr ?? null);
    case GType.BOXED: {
      const keep: unknown[] = [];
      return gobject.g_value_set_boxed(value, gtype === strvType ? (arrayToNative(stringArray, data, keep) as Pointer) : ((data as Instance | null)?.ptr ?? null));
    }
    case GType.VARIANT:
      return gobject.g_value_set_variant(value, (data as Instance | null)?.ptr ?? null);
    case GType.POINTER:
      return gobject.g_value_set_pointer(value, data as Pointer);
  }
  if (gtype === gtypeType) return gobject.g_value_set_gtype(value, data as number);
  throw new Error(`Cannot store ${gobject.g_type_name(gtype)} in a GValue`);
}

export function getValue(value: Pointer): unknown {
  const gtype = Number(read.u64(value, 0));
  switch (fundamentalOf(gtype)) {
    case GType.BOOLEAN:
      return gobject.g_value_get_boolean(value) !== 0;
    case GType.CHAR:
      return gobject.g_value_get_schar(value);
    case GType.UCHAR:
      return gobject.g_value_get_uchar(value);
    case GType.INT:
      return gobject.g_value_get_int(value);
    case GType.UINT:
      return gobject.g_value_get_uint(value);
    case GType.LONG:
      return gobject.g_value_get_long(value);
    case GType.ULONG:
      return gobject.g_value_get_ulong(value);
    case GType.INT64:
      return gobject.g_value_get_int64(value);
    case GType.UINT64:
      return gobject.g_value_get_uint64(value);
    case GType.FLOAT:
      return gobject.g_value_get_float(value);
    case GType.DOUBLE:
      return gobject.g_value_get_double(value);
    case GType.STRING:
      return readString(gobject.g_value_get_string(value));
    case GType.ENUM:
      return gobject.g_value_get_enum(value);
    case GType.FLAGS:
      return gobject.g_value_get_flags(value);
    case GType.OBJECT:
    case GType.INTERFACE:
      return wrapObject(gobject.g_value_get_object(value), false);
    case GType.BOXED: {
      const boxed = gobject.g_value_get_boxed(value);
      if (gtype === strvType) return arrayFromNative(stringArray, boxed, Transfer.NOTHING, -1);
      const info = gi.gi_repository_find_by_gtype(repository, gtype);
      return info ? wrapStruct({ kind: "struct", ffi: "ptr", info, gtype, size: 0, byValue: false }, boxed, false) : boxed;
    }
    case GType.VARIANT:
      return wrapVariant(gobject.g_value_get_variant(value), false);
    case GType.PARAM:
      return { name: String(gobject.g_param_spec_get_name(gobject.g_value_get_param(value)!)) };
    case GType.POINTER:
      return gobject.g_value_get_pointer(value);
  }
  return gtype === gtypeType ? gobject.g_value_get_gtype(value) : null;
}

const propertyTypes = new Map<string, number>();

function propertyType(instance: Instance, name: string) {
  const klass = read.ptr(instance.ptr) as Pointer;
  const key = `${klass}:${name}`;
  let gtype = propertyTypes.get(key);
  if (gtype === undefined) {
    const spec = gobject.g_object_class_find_property(klass, text(name));
    if (!spec) throw new Error(`${gobject.g_type_name(typeOf(instance.ptr))} has no property ${name}`);
    gtype = Number(read.u64(spec, 24));
    propertyTypes.set(key, gtype);
  }
  return gtype;
}

export function getProperty(instance: Instance, name: string) {
  const value = ptr(new Uint8Array(GVALUE_SIZE));
  gobject.g_value_init(value, propertyType(instance, name));
  gobject.g_object_get_property(instance.ptr, text(name), value);
  const result = getValue(value);
  gobject.g_value_unset(value);
  return result;
}

export function setProperty(instance: Instance, name: string, data: unknown) {
  if (loop.sleeping) wake();
  const value = ptr(new Uint8Array(GVALUE_SIZE));
  setValue(value, propertyType(instance, name), data);
  gobject.g_object_set_property(instance.ptr, text(name), value);
  gobject.g_value_unset(value);
  if (instance instanceof ObjectBase && data instanceof ObjectBase) syncStrength(data);
}

function construct(gtype: number, properties: Record<string, unknown> = {}) {
  if (loop.sleeping) wake();
  const entries = Object.entries(properties).filter(([, value]) => value !== undefined);
  const klass = gobject.g_type_class_ref(gtype)!;
  const names = new BigUint64Array(entries.length || 1);
  const values = new Uint8Array(GVALUE_SIZE * (entries.length || 1));
  const encoded = entries.map(([name, value], index) => {
    const property = text(kebab(name));
    const spec = gobject.g_object_class_find_property(klass, property);
    if (!spec) throw new Error(`${gobject.g_type_name(gtype)} has no property ${kebab(name)}`);
    names[index] = BigInt(ptr(property));
    setValue(ptr(values, index * GVALUE_SIZE), Number(read.u64(spec, 24)), value);
    return property;
  });
  const address = gobject.g_object_new_with_properties(gtype, encoded.length, names, values)!;
  encoded.forEach((_, index) => gobject.g_value_unset(ptr(values, index * GVALUE_SIZE)));
  for (const [, value] of entries) if (value instanceof ObjectBase) syncStrength(value);
  return address;
}

const handlerOwners = new Map<number, number>();
let handlerIds = 0;

const invalidate = new JSCallback(
  (data: Pointer) => {
    const id = Number(data);
    const owner = handlerOwners.get(id);
    handlerOwners.delete(id);
    if (owner) wrappers.get(owner)?.ref.deref()?.[HANDLERS]?.delete(id);
  },
  { args: ["ptr", "ptr"], returns: "void" },
);

const marshalSignature = { args: ["ptr", "ptr", "u32", "ptr", "ptr", "ptr"], returns: "void" } as const;
const readValues = (params: Pointer, from: number, count: number) => Array.from({ length: count - from }, (_, index) => getValue((params + (index + from) * GVALUE_SIZE) as Pointer));

function storeResult(result: Pointer | null, returned: unknown) {
  if (!result || returned === undefined) return;
  const gtype = Number(read.u64(result, 0));
  gobject.g_value_unset(result);
  setValue(result, gtype, returned);
}

function newClosure(id: number, marshaller: JSCallback, invalidator: JSCallback) {
  const closure = gobject.g_closure_new_simple(32, id as unknown as Pointer)!;
  gobject.g_closure_set_marshal(closure, marshaller.ptr);
  gobject.g_closure_add_invalidate_notifier(closure, id as unknown as Pointer, invalidator.ptr);
  return closure;
}

const marshal = new JSCallback((closure: Pointer, result: Pointer | null, count: number, params: Pointer) => {
  const instance = wrappers.get(read.ptr(params, 8) as number)?.ref.deref();
  const handler = instance?.[HANDLERS]?.get(Number(read.ptr(closure, 16)));
  if (handler) storeResult(result, guarded(() => handler(instance, ...readValues(params, 1, count))));
}, marshalSignature);

const closures = new Map<number, Fn>();
const closureInvalidate = new JSCallback((data: Pointer) => void closures.delete(Number(data)), { args: ["ptr", "ptr"], returns: "void" });
const closureMarshal = new JSCallback((closure: Pointer, result: Pointer | null, count: number, params: Pointer) => {
  const handler = closures.get(Number(read.ptr(closure, 16)));
  if (handler) storeResult(result, guarded(() => handler(...readValues(params, 0, count))));
}, marshalSignature);

function closureFor(handler: Fn) {
  const id = ++handlerIds;
  closures.set(id, handler);
  return newClosure(id, closureMarshal, closureInvalidate);
}

export class ObjectBase extends Instance {
  static $gtype: number = GType.OBJECT;

  constructor(properties?: Record<string, unknown>) {
    super();
    this.ptr = construct((new.target as unknown as typeof ObjectBase).$gtype, properties);
    adopt(this, !(gobject.g_type_is_a(typeOf(this.ptr), initiallyUnowned) && !gobject.g_object_is_floating(this.ptr)));
  }

  connect(signal: string, handler: (...args: never[]) => unknown) {
    return this.#connect(signal, handler, false);
  }

  connect_after(signal: string, handler: (...args: never[]) => unknown) {
    return this.#connect(signal, handler, true);
  }

  #connect(signal: string, handler: (...args: never[]) => unknown, after: boolean) {
    const id = ++handlerIds;
    const closure = newClosure(id, marshal, invalidate);
    (this[HANDLERS] ??= new Map()).set(id, handler as Fn);
    handlerOwners.set(id, this.ptr);
    return gobject.g_signal_connect_closure(this.ptr, text(signal), closure, after ? 1 : 0);
  }

  disconnect(id: number) {
    gobject.g_signal_handler_disconnect(this.ptr, id);
  }

  block_signal_handler(id: number) {
    gobject.g_signal_handler_block(this.ptr, id);
  }

  unblock_signal_handler(id: number) {
    gobject.g_signal_handler_unblock(this.ptr, id);
  }

  emit(signal: string, ...args: unknown[]) {
    if (loop.sleeping) wake();
    const [name, detail] = signal.split("::");
    const id = gobject.g_signal_lookup(text(name!), typeOf(this.ptr));
    const query = new BigUint64Array(7);
    gobject.g_signal_query(id, query);
    const parameters = Number(query[6]) as Pointer;
    const returnType = withoutStaticScope(query[4]!);
    const values = new Uint8Array(GVALUE_SIZE * (args.length + 1));
    const result = ptr(new Uint8Array(GVALUE_SIZE));
    setValue(ptr(values), typeOf(this.ptr), this);
    args.forEach((arg, index) => setValue(ptr(values, (index + 1) * GVALUE_SIZE), withoutStaticScope(read.u64(parameters, index * 8)), arg));
    if (returnType !== GType.NONE) gobject.g_value_init(result, returnType);
    gobject.g_signal_emitv(ptr(values), id, detail ? glib.g_quark_from_string(text(detail)) : 0, returnType === GType.NONE ? null : result);
    for (let index = 0; index <= args.length; index++) gobject.g_value_unset(ptr(values, index * GVALUE_SIZE));
    if (returnType === GType.NONE) return undefined;
    const returned = getValue(result);
    gobject.g_value_unset(result);
    return returned;
  }
}

function defineLazy(target: object, name: string, compute: () => unknown, inherited: boolean) {
  if (inherited ? name in target : Object.prototype.hasOwnProperty.call(target, name)) return;
  Object.defineProperty(target, name, {
    configurable: true,
    get() {
      const value = compute();
      Object.defineProperty(target, name, { value, configurable: true, writable: true });
      return value;
    },
    set(this: object, value: unknown) {
      Object.defineProperty(this, name, { value, configurable: true, writable: true });
    },
  });
}

function defineProperties(prototype: object, info: Info, count: (info: Info) => number, get: (info: Info, index: number) => Info | null) {
  for (let index = 0; index < count(info); index++) {
    const property = nameOf(get(info, index)!);
    const accessor = {
      configurable: true,
      get(this: Instance) {
        return getProperty(this, property);
      },
      set(this: Instance, value: unknown) {
        setProperty(this, property, value);
      },
    };
    for (const name of new Set([camel(property), property.replace(/-/g, "_")])) if (!(name in prototype)) Object.defineProperty(prototype, name, accessor);
  }
}

function defineMethods(target: Constructor, info: Info, count: (info: Info) => number, get: (info: Info, index: number) => Info | null, inherited = false) {
  const methods = new Map<string, Info>();
  for (let index = 0; index < count(info); index++) {
    const method = get(info, index)!;
    methods.set(nameOf(method), method);
  }
  for (const [name, method] of methods) {
    const container = gi.gi_function_info_get_flags(method) & IS_METHOD ? (target.prototype as object) : target;
    defineLazy(container, name, () => compileFunction(method, () => methods.get(`${name.replace(/_async$/, "")}_finish`) ?? null), inherited);
  }
}

function classFor(gtype: number): Constructor {
  const cached = classes.get(gtype);
  if (cached) return cached;
  const found = gi.gi_repository_find_by_gtype(repository, gtype);
  const info = found && infoKind(found) === infoTypes.object ? found : null;
  const parentInfo = info && gi.gi_object_info_get_parent(info);
  const Parent = (info ? (parentInfo ? classFor(gi.gi_registered_type_info_get_g_type(parentInfo)) : ObjectBase) : classFor(gobject.g_type_parent(gtype))) as unknown as typeof ObjectBase;
  const name = info ? nameOf(info) : String(gobject.g_type_name(gtype));
  const created = { [name]: class extends Parent {} }[name]! as unknown as Constructor;
  if (info) created.$gtype = gtype;
  classes.set(gtype, created);
  const prototype = created.prototype as object;
  if (info) {
    defineMethods(created, info, gi.gi_object_info_get_n_methods, gi.gi_object_info_get_method);
    defineProperties(prototype, info, gi.gi_object_info_get_n_properties, gi.gi_object_info_get_property);
  }
  const count = new Uint32Array(1);
  const interfaces = gobject.g_type_interfaces(gtype, count)!;
  for (let index = 0; index < count[0]!; index++) {
    const iface = gi.gi_repository_find_by_gtype(repository, Number(read.u64(interfaces, index * 8)));
    if (!iface) continue;
    defineMethods(created, iface, gi.gi_interface_info_get_n_methods, gi.gi_interface_info_get_method, true);
    defineProperties(prototype, iface, gi.gi_interface_info_get_n_properties, gi.gi_interface_info_get_property);
  }
  glib.g_free(interfaces);
  return created;
}

const classInits: JSCallback[] = [];

function classField(gtype: number, field: string): { offset: number; info: Info } {
  const info = gi.gi_repository_find_by_gtype(repository, gtype)!;
  const struct = gi.gi_object_info_get_class_struct(info);
  const found = struct && gi.gi_struct_info_find_field(struct, field);
  if (found) return { offset: gi.gi_field_info_get_offset(found), info: gi.gi_type_info_get_interface(gi.gi_field_info_get_type_info(found)!)! };
  return classField(gi.gi_registered_type_info_get_g_type(gi.gi_object_info_get_parent(info)!), field);
}

function overrideVfunc(klass: Pointer, parentType: number, name: string, implementation: (raw: Native[], chain: () => unknown) => unknown) {
  const { offset, info } = classField(parentType, name);
  const { args, result } = planCallable(info);
  const types = args.map((arg) => (arg.direction === Direction.IN ? arg.desc.ffi : "ptr"));
  const inherited = read.ptr(gobject.g_type_class_peek(parentType)!, offset) as Pointer;
  const chain = inherited ? CFunction({ ptr: inherited, args: types, returns: result.ffi }) : undefined;
  const callback = new JSCallback((...raw: Native[]) => guarded(() => implementation(raw, () => chain && chain(...raw))), { args: types, returns: result.ffi });
  classInits.push(callback);
  new DataView(toArrayBuffer(klass, 0, offset + 8)).setBigUint64(offset, BigInt(callback.ptr!), true);
  return { args, result };
}

export function defineClass<T extends abstract new (...args: never[]) => object>(
  name: string,
  Parent: T,
  vfuncs: Record<string, (this: InstanceType<T>, ...args: never[]) => unknown> = {},
): Pick<T, keyof T> & (new (...args: ConstructorParameters<T>) => InstanceType<T>) {
  const parentType = (Parent as unknown as Constructor).$gtype as number;
  const query = new Uint32Array(6);
  gobject.g_type_query(parentType, query);
  const created = { [name]: class extends (Parent as unknown as typeof ObjectBase) {} }[name]! as unknown as Constructor;
  const widget = gobject.g_type_is_a(parentType, gobject.g_type_from_name(text("GtkWidget"))) !== 0;
  const init = new JSCallback(
    (klass: Pointer) => {
      for (const [vfunc, implementation] of Object.entries(vfuncs)) {
        const { args } = overrideVfunc(klass, parentType, vfunc, (raw) =>
          implementation.apply(wrapObject(raw[0] as Pointer, false) as InstanceType<T>, args.slice(1).map((arg, index) => fromNative(arg.desc, raw[index + 1]!, arg.transfer)) as never[]),
        );
      }
      if (!widget) return;
      const Widget = namespace("Gtk")["Widget"]!.prototype as Record<string, Fn>;
      overrideVfunc(klass, parentType, "dispose", (raw, chain) => {
        const self = { ptr: raw[0] };
        for (let child = Widget["get_first_child"]!.call(self) as Instance | null; child; child = Widget["get_first_child"]!.call(self) as Instance | null) Widget["unparent"]!.call(child);
        chain();
      });
    },
    { args: ["ptr", "ptr"], returns: "void" },
  );
  classInits.push(init);
  const gtype = gobject.g_type_register_static_simple(parentType, name, query[4]!, init.ptr, query[5]!, null, 0);
  created.$gtype = gtype;
  classes.set(gtype, created);
  return created as unknown as Pick<T, keyof T> & (new (...args: ConstructorParameters<T>) => InstanceType<T>);
}

const structClasses = new Map<string, Constructor>();

export function structClass(info: Info): Constructor {
  const name = qualifiedName(info);
  const cached = structClasses.get(name);
  if (cached) return cached;
  const union = infoKind(info) === infoTypes.union;
  const size = union ? gi.gi_union_info_get_size(info) : gi.gi_struct_info_get_size(info);
  const created = {
    [nameOf(info)]: class extends Instance {
      constructor(...args: unknown[]) {
        super();
        if (Object.prototype.hasOwnProperty.call(created, "new")) return (created["new"] as Fn)(...args) as Instance;
        const fields = (args[0] ?? {}) as Record<string, unknown>;
        const buffer = new Uint8Array(size || 8);
        memory.set(this, buffer);
        this.ptr = ptr(buffer);
        Object.assign(this, fields);
      }
    },
  }[nameOf(info)]! as unknown as Constructor;
  structClasses.set(name, created);
  defineMethods(created, info, union ? gi.gi_union_info_get_n_methods : gi.gi_struct_info_get_n_methods, union ? gi.gi_union_info_get_method : gi.gi_struct_info_get_method);
  for (let index = 0; !union && index < gi.gi_struct_info_get_n_fields(info); index++) {
    const field = gi.gi_struct_info_get_field(info, index)!;
    const offset = gi.gi_field_info_get_offset(field);
    const type = gi.gi_field_info_get_type_info(field)!;
    const tag = gi.gi_type_info_get_tag(type);
    if (tag === Tag.INTERFACE && !gi.gi_type_info_is_pointer(type) && [infoTypes.struct, infoTypes.union].includes(infoKind(gi.gi_type_info_get_interface(type)!))) continue;
    const desc = describe(type);
    Object.defineProperty(created.prototype, nameOf(field), {
      get(this: Instance) {
        return fromNative(desc, readSlot(desc, this.ptr, offset), Transfer.NOTHING);
      },
      set(this: Instance, value: unknown) {
        writeSlot(desc, new DataView(toArrayBuffer(this.ptr, 0, offset + 8)), offset, toNative(desc, value, Transfer.NOTHING, []));
      },
    });
  }
  return created;
}

function interfaceObject(info: Info) {
  const gtype = gi.gi_registered_type_info_get_g_type(info);
  const target = {
    prototype: {},
    $gtype: gtype,
    [Symbol.hasInstance]: (value: unknown) => value instanceof Instance && gobject.g_type_is_a(typeOf(value.ptr), gtype) !== 0,
  } as unknown as Constructor;
  defineMethods(target, info, gi.gi_interface_info_get_n_methods, gi.gi_interface_info_get_method);
  return target;
}

function enumObject(info: Info) {
  const values: Record<string, number> = {};
  for (let index = 0; index < gi.gi_enum_info_get_n_values(info); index++) {
    const value = gi.gi_enum_info_get_value(info, index)!;
    values[nameOf(value).toUpperCase()] = gi.gi_value_info_get_value(value);
  }
  const domain = gi.gi_enum_info_get_error_domain(info);
  if (domain) Object.defineProperty(values, "$domain", { value: glib.g_quark_from_string(text(String(domain))) });
  return values;
}

function constantValue(info: Info) {
  const value = new BigUint64Array(1);
  gi.gi_constant_info_get_value(info, value);
  const desc = describe(gi.gi_constant_info_get_type_info(info)!);
  const result = desc.kind === "string" ? readString(Number(value[0]) as Pointer) : fromNative(desc, readSlot(desc, ptr(value), 0), Transfer.NOTHING);
  gi.gi_constant_info_free_value(info, value);
  return result;
}

const namespaces = new Map<string, Record<string, Constructor>>();
const overrides: Record<string, Record<string, unknown>> = { GLib: { Error: GLibError } };

export function override(namespaceName: string, member: string, value: unknown) {
  (overrides[namespaceName] ??= {})[member] = value;
  const loaded = namespaces.get(namespaceName);
  if (loaded) Object.defineProperty(loaded, member, { value, configurable: true, writable: true });
}

export function findInfo(namespaceName: string, member: string) {
  namespace(namespaceName);
  return gi.gi_repository_find_by_name(repository, text(namespaceName), text(member));
}

export function namespace(name: string, version?: string): Record<string, Constructor> {
  const cached = namespaces.get(name);
  if (cached) return cached;
  const error = new BigUint64Array(1);
  if (!gi.gi_repository_require(repository, text(name), version ? text(version) : null, 0, error)) takeError(error);
  const proxy = new Proxy({ ...overrides[name] } as Record<string, unknown>, {
    get(target, member) {
      if (typeof member !== "string" || member in target) return target[member as string];
      const info = gi.gi_repository_find_by_name(repository, text(name), text(member));
      if (!info) return undefined;
      const kind = infoKind(info);
      if (kind === infoTypes.object) target[member] = classFor(gi.gi_registered_type_info_get_g_type(info));
      else if (kind === infoTypes.interface) target[member] = interfaceObject(info);
      else if (kind === infoTypes.struct || kind === infoTypes.union) target[member] = structClass(info);
      else if (kind === infoTypes.enum || kind === infoTypes.flags) target[member] = enumObject(info);
      else if (kind === infoTypes.constant) target[member] = constantValue(info);
      else if (kind === infoTypes.function) target[member] = compileFunction(info, () => gi.gi_repository_find_by_name(repository, text(name), text(`${member.replace(/_async$/, "")}_finish`)));
      return target[member];
    },
  }) as Record<string, Constructor>;
  namespaces.set(name, proxy);
  return proxy;
}
