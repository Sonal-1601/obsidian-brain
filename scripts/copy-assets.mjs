import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// tsc only emits .js, so the visualiser's HTML has to be copied into dist by hand.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const from = path.join(root, "src", "server", "ui");
const to = path.join(root, "dist", "server", "ui");

await mkdir(to, { recursive: true });
await cp(from, to, { recursive: true });
console.log(`copied UI assets -> ${path.relative(root, to)}`);
