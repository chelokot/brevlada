export const asciiLower = (value: string) => value.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());

export const asciiUpper = (value: string) => value.replace(/[a-z]+/g, (letters) => letters.toUpperCase());

export const sameAscii = (left: string, right: string) => asciiLower(left) === asciiLower(right);

const WHITESPACE = /[\t-\r \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/g;

export function collapse(value: string) {
  const spaced = value.replace(WHITESPACE, " ");
  return spaced.slice(spaced.startsWith(" ") ? 1 : 0, spaced.endsWith(" ") ? -1 : spaced.length);
}

export const prefix = (value: string, count: number) => Array.from(value.slice(0, count * 2)).slice(0, count).join("");

export function lines(value: string) {
  const parts = value.split("\n");
  const last = parts.pop();
  return [...parts.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line)), ...(last ? [last] : [])];
}
