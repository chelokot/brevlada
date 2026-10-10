export const TTL = 30 * 24 * 60 * 60;
export const MISS_TTL = 7 * 24 * 60 * 60;
export const SOURCES = "google,gravatar,icons-fitted-padded15";

export type Source = "google" | "gravatar" | "favicon" | "none";

export const now = () => Math.floor(Date.now() / 1000);

export function isFresh(found: boolean, fetchedAt: number, now: number) {
  const age = now - fetchedAt;
  return age >= 0 && age < (found ? TTL : MISS_TTL);
}
