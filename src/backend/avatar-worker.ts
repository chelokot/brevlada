import type { AvatarQueue } from "./avatar-queue";
import { isFresh, lookup, now } from "./avatars";
import type { Emit } from "./protocol";
import type { Storage } from "./storage";

export async function start(storage: Storage, queue: AvatarQueue, emit: Emit) {
  for (let email = await queue.pop(); email !== null; email = await queue.pop()) {
    emit({ type: "Avatar", email, image: await resolve(storage, queue, email).catch(() => null) });
  }
}

export async function resolve(storage: Storage, queue: AvatarQueue, email: string) {
  const cached = storage.avatar(email);
  if (cached && isFresh(cached.image !== null, cached.fetchedAt, now())) return cached.image;
  const fetched = await lookup(queue.credentials(), email);
  if (fetched.unauthorized.length) queue.unauthorized(fetched.unauthorized);
  storage.storeAvatar(email, fetched.source, fetched.image);
  return fetched.image;
}
