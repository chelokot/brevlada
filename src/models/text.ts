export const asciiLower = (value: string) => value.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());

export const asciiUpper = (value: string) => value.replace(/[a-z]+/g, (letters) => letters.toUpperCase());

export const sameAscii = (left: string, right: string) => asciiLower(left) === asciiLower(right);

export const collapse = (value: string) => value.split(/\p{White_Space}+/u).filter((word) => word).join(" ");

export const prefix = (value: string, count: number) => Array.from(value.slice(0, count * 2)).slice(0, count).join("");

export function lines(value: string) {
  const parts = value.split("\n");
  const last = parts.pop();
  return [...parts.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line)), ...(last ? [last] : [])];
}
