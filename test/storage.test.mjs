// Synthetic filesystem fixtures only: never opens or reads a real SQLite database.
import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync,
  rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { prepareStorage } from "../src/storage.ts";

const fixture = (t) => {
  const root = mkdtempSync(join(tmpdir(), "jobbot-storage-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};
const mode = (p) => statSync(p).mode & 0o777;
const rejects = (env, home) => assert.throws(() => prepareStorage(env, home));

test("storage module import does not create configured private storage", (t) => {
  const root = fixture(t);
  const privateDir = join(root, ".private");
  const stateDir = join(privateDir, "state");
  const storageUrl = new URL("../src/storage.ts", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `await import(${JSON.stringify(storageUrl)})`], {
    cwd: dirname(dirname(fileURLToPath(import.meta.url))),
    env: { HOME: root, JOBBOT_PRIVATE_DIR: privateDir, STATE_DIR: stateDir },
    encoding: "utf8",
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(existsSync(privateDir), false);
});

test("default storage creates only home/.jobbot/.private/state with restrictive modes", (t) => {
  const home = fixture(t);
  const result = prepareStorage({}, home);
  assert.deepEqual(result, {
    privateDir: join(home, ".jobbot", ".private"),
    stateDir: join(home, ".jobbot", ".private", "state"),
    databasePath: join(home, ".jobbot", ".private", "state", "jobbot.db"),
  });
  assert.equal(mode(result.privateDir), 0o700);
  assert.equal(mode(result.stateDir), 0o700);
  assert.equal(mode(result.databasePath), 0o600);
  assert.equal(lstatSync(result.databasePath).isFile(), true);
  assert.equal(statSync(result.databasePath).size, 0);
});

test("explicit private root and nested absolute STATE_DIR are retained", (t) => {
  const home = fixture(t);
  const privateDir = join(home, "plugin-data", ".private");
  const stateDir = join(privateDir, "runs", "state");
  const result = prepareStorage({ JOBBOT_PRIVATE_DIR: privateDir, STATE_DIR: stateDir }, home);
  assert.deepEqual(result, { privateDir, stateDir, databasePath: join(stateDir, "jobbot.db") });
  for (const p of [privateDir, join(privateDir, "runs"), stateDir]) assert.equal(mode(p), 0o700);
});

test("explicit private root supplies the default state child", (t) => {
  const home = fixture(t);
  const privateDir = join(home, ".private");
  assert.equal(prepareStorage({ JOBBOT_PRIVATE_DIR: privateDir }, home).stateDir, join(privateDir, "state"));
});

test("STATE_DIR infers its nearest .private ancestor without an explicit root", (t) => {
  const home = fixture(t);
  const privateDir = join(home, "plugin-data", ".private");
  const stateDir = join(privateDir, "nested", "state");
  const result = prepareStorage({ STATE_DIR: stateDir }, home);
  assert.equal(result.privateDir, privateDir);
  assert.equal(result.stateDir, stateDir);
});

test("invalid configuration fails before creating a storage tree", (t) => {
  const home = fixture(t);
  const privateDir = join(home, ".private");
  for (const env of [
    { STATE_DIR: "relative/.private/state" },
    { JOBBOT_PRIVATE_DIR: "relative/.private" },
    { STATE_DIR: "${CLAUDE_PLUGIN_DATA}/.private/state" },
    { JOBBOT_PRIVATE_DIR: "${CLAUDE_PLUGIN_DATA}/.private" },
    { JOBBOT_PRIVATE_DIR: join(home, "private") },
    { JOBBOT_PRIVATE_DIR: "/" },
    { STATE_DIR: join(home, "legacy-state") },
    { JOBBOT_PRIVATE_DIR: privateDir, STATE_DIR: join(home, "outside") },
    { JOBBOT_PRIVATE_DIR: privateDir, STATE_DIR: join(home, ".private-sibling", "state") },
    { JOBBOT_PRIVATE_DIR: privateDir, STATE_DIR: `${privateDir}/state/../../outside` },
  ]) rejects(env, home);
  assert.equal(existsSync(privateDir), false);
  assert.equal(existsSync(join(home, ".jobbot")), false);
});

test("private root symlink is rejected without chmod or data access at its target", (t) => {
  const home = fixture(t);
  const target = join(home, "target");
  mkdirSync(target, { mode: 0o755 });
  chmodSync(target, 0o755);
  const privateDir = join(home, ".private");
  symlinkSync(target, privateDir, "dir");
  rejects({ JOBBOT_PRIVATE_DIR: privateDir }, home);
  assert.equal(mode(target), 0o755);
  assert.equal(existsSync(join(target, "state")), false);
});

test("symlink in an ancestor above the .private root is rejected", (t) => {
  const home = fixture(t);
  const target = join(home, "real-parent");
  mkdirSync(target);
  const alias = join(home, "alias");
  symlinkSync(target, alias, "dir");
  rejects({ JOBBOT_PRIVATE_DIR: join(alias, ".private") }, home);
  assert.equal(existsSync(join(target, ".private")), false);
});

test("symlink within the state path is rejected even when its target is private", (t) => {
  const home = fixture(t);
  const privateDir = join(home, ".private");
  const target = join(privateDir, "real");
  mkdirSync(target, { recursive: true, mode: 0o700 });
  symlinkSync(target, join(privateDir, "alias"), "dir");
  rejects({ JOBBOT_PRIVATE_DIR: privateDir, STATE_DIR: join(privateDir, "alias", "state") }, home);
  assert.equal(existsSync(join(target, "state")), false);
});

for (const suffix of ["", "-wal", "-shm", "-journal"]) {
  test(`SQLite ${suffix || "main"} symlink is rejected without modifying its synthetic target`, (t) => {
    const home = fixture(t);
    const privateDir = join(home, ".private");
    const stateDir = join(privateDir, "state");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const target = join(home, "synthetic-target");
    writeFileSync(target, "synthetic", { mode: 0o644 });
    chmodSync(target, 0o644);
    symlinkSync(target, join(stateDir, `jobbot.db${suffix}`));
    rejects({ JOBBOT_PRIVATE_DIR: privateDir, STATE_DIR: stateDir }, home);
    assert.equal(mode(target), 0o644);
    assert.equal(statSync(target).size, 9);
  });
}

test("hard-linked SQLite database is rejected before tightening its external alias", (t) => {
  const home = fixture(t);
  const privateDir = join(home, ".private");
  const stateDir = join(privateDir, "state");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const target = join(home, "synthetic-target");
  writeFileSync(target, "synthetic", { mode: 0o644 });
  chmodSync(target, 0o644);
  linkSync(target, join(stateDir, "jobbot.db"));
  rejects({ JOBBOT_PRIVATE_DIR: privateDir, STATE_DIR: stateDir }, home);
  assert.equal(mode(target), 0o644);
});

test("nonregular database and non-directory state components are rejected", (t) => {
  const home = fixture(t);
  const privateDir = join(home, ".private");
  const stateDir = join(privateDir, "state");
  mkdirSync(join(stateDir, "jobbot.db"), { recursive: true, mode: 0o700 });
  rejects({ JOBBOT_PRIVATE_DIR: privateDir, STATE_DIR: stateDir }, home);
  rmSync(stateDir, { recursive: true });
  writeFileSync(stateDir, "synthetic");
  rejects({ JOBBOT_PRIVATE_DIR: privateDir, STATE_DIR: stateDir }, home);
});

test("existing private dirs, DB and regular sidecars are tightened and repeated preparation is stable", (t) => {
  const home = fixture(t);
  const privateDir = join(home, ".private");
  const stateDir = join(privateDir, "state");
  mkdirSync(stateDir, { recursive: true });
  chmodSync(privateDir, 0o755);
  chmodSync(stateDir, 0o755);
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const p = join(stateDir, `jobbot.db${suffix}`);
    writeFileSync(p, "synthetic");
    chmodSync(p, 0o644);
  }
  const first = prepareStorage({ JOBBOT_PRIVATE_DIR: privateDir, STATE_DIR: stateDir }, home);
  const second = prepareStorage({ JOBBOT_PRIVATE_DIR: privateDir, STATE_DIR: stateDir }, home);
  assert.deepEqual(second, first);
  assert.equal(mode(privateDir), 0o700);
  assert.equal(mode(stateDir), 0o700);
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const p = join(stateDir, `jobbot.db${suffix}`);
    assert.equal(mode(p), 0o600);
    assert.equal(statSync(p).size, 9, "existing synthetic contents must not be truncated");
  }
});

test("default does not reopen or migrate the legacy home/.jobbot/state directory", (t) => {
  const home = fixture(t);
  const legacy = join(home, ".jobbot", "state");
  mkdirSync(legacy, { recursive: true });
  const oldFile = join(legacy, "jobbot.db");
  writeFileSync(oldFile, "synthetic");
  const before = statSync(oldFile);
  const result = prepareStorage({}, home);
  assert.notEqual(resolve(result.stateDir), resolve(legacy));
  assert.equal(statSync(oldFile).ino, before.ino);
  assert.equal(statSync(oldFile).size, before.size);
});
