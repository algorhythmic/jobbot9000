// Explicit local import only: never searches for a resume or reads on dry-run.
import { createHash } from "node:crypto";
import { appendReviewAudit } from "./review-queue.js";
import { constants, lstatSync, mkdirSync, rmSync, openSync, readFileSync, closeSync, writeFileSync, chmodSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { prepareStorage } from "./storage.js";
export function importResume(privateDir: string, source: string, id: string, persist = false, now = Date.now()) {
  if (!isAbsolute(source) || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id)) throw new Error("explicit source and opaque import ID required");
  if (!persist) return { dryRun: true, imported: false };
  const root = prepareStorage({ JOBBOT_PRIVATE_DIR: privateDir }).privateDir;
  const dir = join(root, "profile");
  try { const stat = lstatSync(dir); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("private profile directory denied"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const sourceStat = lstatSync(source);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.size > 20 * 1024 * 1024) throw new Error("resume source must be a bounded regular file");
  const fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try { bytes = readFileSync(fd); } finally { closeSync(fd); }
  mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700);
  const target = join(dir, `${id}.resume`);
  writeFileSync(target, bytes, { flag: "wx", mode: 0o600 });
  try {
    appendReviewAudit(root, { type: "resume_import", batchId: id, payloadSha256: createHash("sha256").update(bytes).digest("hex"), timestamp: now });
  } catch { rmSync(target); throw new Error("private resume import audit unavailable"); }
  return { dryRun: false, imported: true };
}
