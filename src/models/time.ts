export interface Time {
  days: number;
  seconds: number;
  nano: number;
  offset: number;
}

const DAY = 86400;
const MONTHS = "January February March April May June July August September October November December".split(" ");
const WEEKDAYS = "Sunday Monday Tuesday Wednesday Thursday Friday Saturday".split(" ");
const RFC3339 = /^(\d{4})-(\d\d)-(\d\d)[Tt ](\d\d):(\d\d):(\d\d)(?:\.(\d+))?(?:[Zz]|([+\-\u2212]\d\d):([0-5]\d))$/;
const FIELDS: Record<string, string> = { Y: "[+-]\\d+|\\d{1,4}", z: "[+\\-\\u2212]\\d\\d[:\\p{White_Space}]*[0-5]\\d" };
const patterns = new Map<string, RegExp>();

function time(year: number, month: number, day: number, hour: number, minute: number, second: number, nano: number, offset: number): Time | null {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  const valid = date.getUTCMonth() === month - 1 && date.getUTCDate() === day && hour < 24 && minute < 60 && second < 60 && Math.abs(offset) < DAY;
  return valid ? { days: date.getTime() / DAY / 1000, seconds: hour * 3600 + minute * 60 + second, nano, offset } : null;
}

const nanoseconds = (fraction: string) => Number(fraction.slice(0, 9).padEnd(9, "0"));

const offsetSeconds = (sign: string, hours: string, minutes: string) => (sign === "+" ? 1 : -1) * (Number(hours) * 3600 + Number(minutes) * 60);

export function rfc3339(value: string): Time | null {
  const match = RFC3339.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, fraction = "", offset = "+00", minutes = "00"] = match;
  return time(Number(year), Number(month), Number(day), Number(hour), Number(minute), second === "60" ? 59 : Number(second), nanoseconds(fraction), offsetSeconds(offset.charAt(0), offset.slice(1), minutes));
}

export function parse(value: string, format: string): Time | null {
  let pattern = patterns.get(format);
  if (!pattern) {
    const field = (name: string) => (name === ".f" ? "(?:\\.(?<f>\\d+))?" : `\\p{White_Space}*(?<${name}>${FIELDS[name] ?? "\\d{1,2}"})`);
    const source = format.replace(/%(\.f|.)|(\s)|[.*+?^${}()|[\]\\]/g, (token, name?: string, space?: string) => (name ? field(name) : space ? "\\p{White_Space}*" : `\\${token}`));
    pattern = new RegExp(`^${source}$`, "u");
    patterns.set(format, pattern);
  }
  const { Y, m, d, H = "0", M = "0", S = "0", f = "", z = "+0000" } = pattern.exec(value)?.groups ?? {};
  return time(Number(Y), Number(m), Number(d), Number(H), Number(M), Number(S), nanoseconds(f), offsetSeconds(z.charAt(0), z.slice(1, 3), z.slice(-2)));
}

export const timestamp = ({ days, seconds, offset }: Time) => days * DAY + seconds - offset;

export function fromTimestamp(value: number, offset = 0, nano = 0): Time {
  const shifted = value + offset;
  return { days: Math.floor(shifted / DAY), seconds: ((shifted % DAY) + DAY) % DAY, nano, offset };
}

export const local = (value: number, nano = 0) => fromTimestamp(value, -new Date(value * 1000).getTimezoneOffset() * 60, nano);

export const addDays = (value: Time, days: number): Time => ({ ...value, days: value.days + days });

export const compare = (left: Time, right: Time) => timestamp(left) - timestamp(right) || left.nano - right.nano;

export const compareNaive = (left: Time, right: Time) => left.days - right.days || left.seconds - right.seconds || left.nano - right.nano;

export function format({ days, seconds, offset }: Time, pattern: string) {
  const date = new Date(days * DAY * 1000);
  const pad = (value: number, width = 2) => String(Math.abs(value)).padStart(width, "0");
  const year = date.getUTCFullYear();
  const weekday = WEEKDAYS[date.getUTCDay()] ?? "";
  const month = MONTHS[date.getUTCMonth()] ?? "";
  const values = {
    Y: year >= 0 && year <= 9999 ? pad(year, 4) : `${year < 0 ? "-" : "+"}${pad(year, 4)}`,
    y: pad(((year % 100) + 100) % 100),
    m: pad(date.getUTCMonth() + 1),
    d: pad(date.getUTCDate()),
    "-d": String(date.getUTCDate()),
    e: String(date.getUTCDate()).padStart(2, " "),
    H: pad(Math.floor(seconds / 3600)),
    M: pad(Math.floor(seconds / 60) % 60),
    S: pad(seconds % 60),
    a: weekday.slice(0, 3),
    A: weekday,
    B: month,
    b: month.slice(0, 3),
    ":z": `${offset < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(offset) / 3600))}:${pad(Math.floor(Math.abs(offset) / 60) % 60)}`,
  };
  return pattern.replace(/%(-d|:z|[YymdeHMSaAbB])/g, (_, key: keyof typeof values) => values[key]);
}

export function toRfc3339(value: Time) {
  const { nano } = value;
  const digits = nano % 1_000_000 === 0 ? 3 : nano % 1000 === 0 ? 6 : 9;
  const fraction = nano === 0 ? "" : `.${String(nano).padStart(9, "0").slice(0, digits)}`;
  return `${format(value, "%Y-%m-%dT%H:%M:%S")}${fraction}${format(value, "%:z")}`;
}
