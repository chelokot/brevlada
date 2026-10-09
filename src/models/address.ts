export interface Mailbox {
  name: string | null;
  addr: string;
}

export type Address = Mailbox | Mailbox[];

type State = "initial" | "quoted" | "escaped" | "afterQuoted" | "bracketed" | "afterBracketed" | "unquoted" | "comment";

const SPACE = /\p{White_Space}/u;

function list(chars: IterableIterator<string>, group: boolean): Address[] | null {
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
    const nested = group ? null : list(chars, true);
    return nested !== null && result.push(nested.flat()) > 0;
  };
  for (const char of chars) {
    empty = false;
    const space = SPACE.test(char);
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

export const parse = (value: string) => list(value[Symbol.iterator](), false);

export const format = ({ name, addr }: Mailbox) => (name === null ? addr : `"${name.replaceAll('"', '\\"')}" <${addr}>`);
