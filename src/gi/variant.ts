import { findInfo, namespace, override, structClass, type Instance } from "./runtime";

type Variant = Instance & Record<string, (...args: unknown[]) => unknown>;
type VariantClass = Record<string, (...args: unknown[]) => Variant>;

const Base = structClass(findInfo("GLib", "Variant")!) as unknown as new () => object;
const basic: Record<string, string> = { b: "boolean", y: "byte", n: "int16", q: "uint16", i: "int32", u: "uint32", x: "int64", t: "uint64", h: "handle", d: "double", s: "string", o: "object_path", g: "signature" };

function complete(signature: string, start: number): number {
  const open = signature[start];
  if (open === "a" || open === "m") return complete(signature, start + 1);
  if (open !== "(" && open !== "{") return start + 1;
  let index = start + 1;
  while (signature[index] !== (open === "(" ? ")" : "}")) index = complete(signature, index);
  return index + 1;
}

function members(signature: string) {
  const result: string[] = [];
  for (let index = 1; index < signature.length - 1; ) {
    const end = complete(signature, index);
    result.push(signature.slice(index, end));
    index = end;
  }
  return result;
}

function pack(signature: string, value: unknown): Variant {
  const factory = namespace("GLib")["Variant"] as unknown as VariantClass;
  const type = (signature: string) => new (namespace("GLib")["VariantType"] as unknown as new (signature: string) => object)(signature);
  const kind = signature[0]!;
  if (basic[kind]) return factory[`new_${basic[kind]}`]!(value);
  if (kind === "v") return factory["new_variant"]!(value);
  if (kind === "m") return factory["new_maybe"]!(type(signature.slice(1)), value === null || value === undefined ? null : pack(signature.slice(1), value));
  if (kind === "(") {
    const types = members(signature);
    return factory["new_tuple"]!((value as unknown[]).map((item, index) => pack(types[index]!, item)));
  }
  const item = signature.slice(1);
  if (item === "s") return factory["new_strv"]!(value);
  if (item[0] === "{") {
    const [key, entry] = members(item) as [string, string];
    const entries = Object.entries(value as Record<string, unknown>).map(([name, data]) => factory["new_dict_entry"]!(pack(key, name), pack(entry, data)));
    return factory["new_array"]!(type(item), entries);
  }
  return factory["new_array"]!(type(item), (value as unknown[]).map((data) => pack(item, data)));
}

function unpack(variant: Variant, deep: boolean, recursive: boolean): unknown {
  const signature = variant.get_type_string!() as string;
  const kind = signature[0]!;
  if (kind === "s" || kind === "o" || kind === "g") return (variant.get_string!() as [string, number])[0];
  if (kind === "v") return recursive ? unpack(variant.get_variant!() as Variant, deep, recursive) : variant.get_variant!();
  if (basic[kind]) return variant[`get_${basic[kind]}`]!();
  if (kind === "m") {
    const child = variant.get_maybe!() as Variant | null;
    return child && unpack(child, deep, recursive);
  }
  const count = variant.n_children!() as number;
  const children = Array.from({ length: count }, (_, index) => variant.get_child_value!(index) as Variant);
  const element = (child: Variant) => (deep ? unpack(child, deep, recursive) : child);
  if (kind === "a" && signature[1] === "{") {
    return Object.fromEntries(children.map((child) => [unpack(child.get_child_value!(0) as Variant, true, true), element(child.get_child_value!(1) as Variant)]));
  }
  return children.map(element);
}

class GVariant extends Base {
  constructor(signature: string, value: unknown) {
    super();
    return pack(signature, value) as unknown as GVariant;
  }

  unpack(this: Variant) {
    return unpack(this, false, false);
  }

  deepUnpack(this: Variant) {
    return unpack(this, true, false);
  }

  deep_unpack(this: Variant) {
    return unpack(this, true, false);
  }

  recursiveUnpack(this: Variant) {
    return unpack(this, true, true);
  }
}

override("GLib", "Variant", GVariant);
