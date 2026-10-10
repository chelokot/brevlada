import { rename } from "node:fs/promises";

export interface Settings {
  trustAllSenders: boolean;
  backgroundService: boolean;
}

function flag(data: object, key: string) {
  const value: unknown = Reflect.get(data, key);
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new Error(`invalid type: expected a boolean for \`${key}\``);
  return value;
}

export async function load(path: string): Promise<Settings> {
  const file = Bun.file(path);
  if (!(await file.exists())) return { trustAllSenders: false, backgroundService: false };
  const data: unknown = JSON.parse(await file.text());
  if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error("invalid type: expected struct Settings");
  return { trustAllSenders: flag(data, "trust_all_senders"), backgroundService: flag(data, "background_service") };
}

export async function save({ trustAllSenders, backgroundService }: Settings, path: string) {
  const temporary = `${path}.tmp`;
  await Bun.write(temporary, JSON.stringify({ trust_all_senders: trustAllSenders, background_service: backgroundService }));
  await rename(temporary, path);
}
