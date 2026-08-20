import { createHash } from "node:crypto";

/** Short content fingerprint used to skip no-op note rewrites. */
export function sha1(input: string): string {
  return createHash("sha1").update(input).digest("hex");
}

export function shortHash(input: string, length = 12): string {
  return sha1(input).slice(0, length);
}
