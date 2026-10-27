// Private storage boundary. This module is inert until prepareStorage is called.
// Path checks protect accidental escape, not against a hostile process with the
// same OS identity replacing paths concurrently. No legacy state is read/moved.
import { constants, lstatSync, mkdirSync, chmodSync, openSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

export interface StoragePaths { privateDir: string; stateDir: string; databasePath: string }
const exists = (path: string) => {
  try { return lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
};
function absolute(value: string, name: string): string {
  if (!value || value.includes("${") || !isAbsolute(value))
    throw new Error(`${name} must be an expanded absolute path under .private`);
  return resolve(value);
}
function contained(parent: string, child: string): boolean {
  const r = relative(parent, child);
  return r === "" || (!r.startsWith(`..${sep}`) && r !== ".." && !isAbsolute(r));
}
function noSymlinks(path: string): void {
  let current = parse(path).root;
  for (const part of path.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    const stat = exists(current);
    if (stat?.isSymbolicLink()) throw new Error("private storage refuses symbolic links");
    if (stat && current !== path && !stat.isDirectory()) throw new Error("private storage parent is not a directory");
  }
}
function owned(path: string): void {
  const stat = lstatSync(path);
  if (process.getuid && stat.uid !== process.getuid()) throw new Error("private storage must be owned by the current user");
}
function privateFile(path: string, create: boolean): void {
  noSymlinks(path);
  let stat = exists(path);
  if (!stat && create) {
    const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    closeSync(fd);
    stat = lstatSync(path);
  }
  if (!stat) return;
  if (!stat.isFile() || stat.nlink !== 1) throw new Error("private storage refuses nonregular or multiply linked database files");
  owned(path);
  chmodSync(path, 0o600);
}
export function prepareStorage(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): StoragePaths {
  const explicitState = env.STATE_DIR === undefined ? undefined : absolute(env.STATE_DIR, "STATE_DIR");
  let inferred: string | undefined;
  if (explicitState) {
    for (let path = explicitState; path !== dirname(path); path = dirname(path)) {
      if (basename(path) === ".private") { inferred = path; break; }
    }
    if (!inferred) throw new Error("STATE_DIR must be contained in .private; legacy state is never migrated automatically");
  }
  const privateDir = env.JOBBOT_PRIVATE_DIR === undefined
    ? inferred ?? join(absolute(home, "home"), ".jobbot", ".private")
    : absolute(env.JOBBOT_PRIVATE_DIR, "JOBBOT_PRIVATE_DIR");
  if (basename(privateDir) !== ".private") throw new Error("JOBBOT_PRIVATE_DIR must name a .private directory");
  const stateDir = explicitState ?? join(privateDir, "state");
  if (!contained(privateDir, stateDir)) throw new Error("STATE_DIR escapes the selected .private root");
  noSymlinks(privateDir);
  noSymlinks(stateDir);
  // Validate existing private directory ownership before any creation/chmod.
  for (let path = stateDir; contained(privateDir, path); path = dirname(path)) {
    const stat = exists(path);
    if (stat) {
      if (!stat.isDirectory()) throw new Error("private storage root is not a directory");
      owned(path);
    }
    if (path === privateDir) break;
  }
  // Validate existing artifacts before creating or changing private directories.
  const databasePath = join(stateDir, "jobbot.db");
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const path = databasePath + suffix;
    noSymlinks(path);
    const stat = exists(path);
    if (stat && (!stat.isFile() || stat.nlink !== 1)) throw new Error("private storage refuses nonregular or multiply linked database files");
    if (stat) owned(path);
  }
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  for (let path = stateDir; contained(privateDir, path); path = dirname(path)) {
    if (!lstatSync(path).isDirectory()) throw new Error("private storage root is not a directory");
    owned(path);
    chmodSync(path, 0o700);
    if (path === privateDir) break;
  }
  privateFile(databasePath, true);
  privateFile(databasePath + "-wal", false);
  privateFile(databasePath + "-shm", false);
  privateFile(databasePath + "-journal", false);
  return { privateDir, stateDir, databasePath };
}
