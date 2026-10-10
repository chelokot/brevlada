export interface Mailbox {
  name: string | null;
  addr: string;
}

export type Address = Mailbox | Mailbox[];

type State = "initial" | "quoted" | "escaped" | "afterQuoted" | "bracketed" | "afterBracketed" | "unquoted" | "comment";

const WHITE = /[\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;
const SPACES = "[\\t-\\r \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]*";
const PLAIN = `(?!${SPACES.slice(0, -1)})[^"<;,:(][^<;,:(]*`;
const SIMPLE = new RegExp(`^${SPACES}(?:"([^"\\\\]*)"${SPACES}<([^>]*)>|(${PLAIN})<([^>]*)>|(${PLAIN}))${SPACES}$`);

const white = (char: string) => char === " " || (char >= "\t" && char <= "\r") || (char > "\x84" && WHITE.test(char));

function list(value: string, cursor: { index: number }, group: boolean): Address[] | null {
  const result: Address[] = [];
  let state: State = "initial";
  let resume: State = "initial";
  let name: string | null = null;
  let quoted = "";
  let spaces = "";
  let addr = "";
  let empty = true;
  const push = (address: string) => address.includes("@") && result.push({ name, addr: address }) > 0;
  const members = () => {
    const nested = group ? null : list(value, cursor, true);
    return nested !== null && result.push(nested.flat()) > 0;
  };
  while (cursor.index < value.length) {
    const char = value.charAt(cursor.index++);
    empty = false;
    const space = white(char);
    switch (state) {
      case "initial":
        if (char === '"') {
          state = "quoted";
          quoted = "";
        } else if (char === "<") {
          state = "bracketed";
          addr = "";
        } else if (char === ";") return group ? result : null;
        else if (!space) {
          state = "unquoted";
          addr = char;
        }
        break;
      case "quoted":
        if (char === "\\") state = "escaped";
        else if (char === '"') state = "afterQuoted";
        else quoted += char;
        break;
      case "escaped":
        state = "quoted";
        quoted += char;
        break;
      case "afterQuoted":
        if (space) spaces += char;
        else if (char === "<") {
          state = "bracketed";
          name = quoted;
          addr = "";
        } else if (char === ":") {
          if (!members()) return null;
          state = "initial";
        } else {
          if (char === '"') state = "quoted";
          quoted += char === '"' ? spaces : spaces + char;
          spaces = "";
        }
        break;
      case "bracketed":
        if (char !== ">") addr += char;
        else if (!push(addr)) return null;
        else {
          state = "afterBracketed";
          name = null;
        }
        break;
      case "afterBracketed":
        if (char === ";" && group) return result;
        if (char === "," || char === ";") state = "initial";
        else if (char === "(") {
          state = "comment";
          resume = "afterBracketed";
        } else if (!space) return null;
        break;
      case "unquoted":
        if (char === "<") {
          state = "bracketed";
          name = addr.trimEnd();
          addr = "";
        } else if (char === "," || char === ";") {
          if (!push(addr.trimEnd())) return null;
          if (char === ";" && group) return result;
          state = "initial";
        } else if (char === ":") {
          if (!members()) return null;
          state = "initial";
        } else if (char === "(") {
          state = "comment";
          resume = "unquoted";
        } else addr += char;
        break;
      case "comment":
        if (char === ")") state = resume;
    }
  }
  if (group) return empty ? result : null;
  if (state === "unquoted") return push(addr.trimEnd()) ? result : null;
  return state === "initial" || state === "afterBracketed" ? result : null;
}

export function parse(value: string): Address[] | null {
  const simple = SIMPLE.exec(value);
  if (!simple) return list(value, { index: 0 }, false);
  const [, quoted, quotedAddr = "", plain = "", plainAddr = "", bare] = simple;
  const mailbox = bare !== undefined ? { name: null, addr: bare.trimEnd() } : quoted !== undefined ? { name: quoted, addr: quotedAddr } : { name: plain.trimEnd(), addr: plainAddr };
  return mailbox.addr.includes("@") ? [mailbox] : null;
}

export const format = ({ name, addr }: Mailbox) => (name === null ? addr : `"${name.replaceAll('"', '\\"')}" <${addr}>`);
