// Integration seam: actual SQLite files, with synthetic data in an isolated .private.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("private storage integrates with SQLite WAL and durable reopen", async (t) => {
  const temp = mkdtempSync(join(tmpdir(), "jobbot-storage-db-"));
  const privateDir = join(temp, ".private");
  const stateDir = join(privateDir, "state");
  const databasePath = join(stateDir, "jobbot.db");
  const previousState = process.env.STATE_DIR;
  const previousPrivate = process.env.JOBBOT_PRIVATE_DIR;
  let DB;
  let reopened;
  t.after(() => {
    try { DB?.db.close(); } catch {}
    try { reopened?.close(); } catch {}
    if (previousState === undefined) delete process.env.STATE_DIR;
    else process.env.STATE_DIR = previousState;
    if (previousPrivate === undefined) delete process.env.JOBBOT_PRIVATE_DIR;
    else process.env.JOBBOT_PRIVATE_DIR = previousPrivate;
    rmSync(temp, { recursive: true, force: true });
  });

  // Configure BEFORE importing db.ts: that import opens/migrates the database.
  process.env.JOBBOT_PRIVATE_DIR = privateDir;
  process.env.STATE_DIR = stateDir;
  DB = await import(new URL("../src/db.ts", import.meta.url).href);
  DB.upsertProfile({ target_role: "Synthetic test engineer", target_niche: "Synthetic fixtures" });

  await t.test("real main/WAL/SHM files remain private and use restrictive permissions", () => {
    for (const path of [privateDir, stateDir]) {
      assert.equal(statSync(path).isDirectory(), true);
      assert.equal(statSync(path).mode & 0o777, 0o700);
    }
    for (const suffix of ["", "-wal", "-shm"]) {
      const path = databasePath + suffix;
      assert.equal(existsSync(path), true, `SQLite must create the expected ${suffix || "main"} file`);
      assert.equal(statSync(path).isFile(), true);
      assert.equal(statSync(path).mode & 0o777, 0o600);
    }
    assert.deepEqual(readdirSync(temp), [".private"]);
    assert.deepEqual(readdirSync(privateDir), ["state"]);
    assert.deepEqual(readdirSync(stateDir).sort(), ["jobbot.db", "jobbot.db-shm", "jobbot.db-wal"]);
    assert.equal(DB.getProfile().target_role, "Synthetic test engineer");
  });

  await t.test("closing and reopening through the SQLite shim preserves synthetic profile and integrity", async () => {
    DB.db.close();
    const { default: Database } = await import(new URL("../src/sqlite.ts", import.meta.url).href);
    reopened = new Database(databasePath);
    assert.equal(reopened.pragma("journal_mode")[0].journal_mode, "wal");
    assert.equal(reopened.pragma("integrity_check")[0].integrity_check, "ok");
    const profile = reopened.prepare("SELECT target_role, target_niche FROM profile WHERE id=1").get();
    assert.equal(profile.target_role, "Synthetic test engineer");
    assert.equal(profile.target_niche, "Synthetic fixtures");
    assert.equal(statSync(databasePath).mode & 0o777, 0o600);
    reopened.close();
  });
});
