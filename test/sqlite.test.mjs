// Offline test for the SQLite driver seam (src/sqlite.ts) — the node:sqlite-backed
// replacement for better-sqlite3. Everything here is a hand-written shim over an API that
// doesn't provide it (`pragma`, `transaction`), or a behaviour db.ts silently depends on
// (`lastInsertRowid`, `changes`, bare `@named` binding, WAL on a real file). That makes it
// exactly the code a passing discovery suite would NOT catch a regression in, so it gets
// its own test. Run via `npm test` (tsx executes it against src/ directly).
//
// The DB is a temp file, not `:memory:`, because WAL and the transaction/rollback paths
// only mean anything against a real on-disk database.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "jbsqlite-"));
const { default: Database } = await import(new URL("../src/sqlite.ts", import.meta.url).href);

let pass = 0, fail = 0;
const eq = (got, want, msg) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"} ${msg}${ok ? "" : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

const db = new Database(join(TMP, "t.db"));

// ── pragma ────────────────────────────────────────────────────────────────────
// db.ts sets these three at import. WAL is the one that matters: it's persisted IN the
// file, so getting it wrong changes the on-disk format other sessions/readers expect.
eq(db.pragma("journal_mode = WAL"), [{ journal_mode: "wal" }], "pragma: WAL is set and reports back");
eq(db.pragma("foreign_keys = ON"), [], "pragma: a value-less pragma returns no rows (doesn't throw)");
eq(db.pragma("busy_timeout = 5000"), [{ timeout: 5000 }], "pragma: busy_timeout applied");
eq(db.pragma("journal_mode"), [{ journal_mode: "wal" }], "pragma: WAL persisted (read back)");

db.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT, n INTEGER);
         CREATE TABLE parent (id INTEGER PRIMARY KEY);
         CREATE TABLE child (id INTEGER PRIMARY KEY, pid INTEGER REFERENCES parent(id));`);

// ── statement results ─────────────────────────────────────────────────────────
// db.ts returns `Number(info.lastInsertRowid)` as new-row ids and reads `.changes` to
// count rows it marked dead — both must be real numbers, not bigints or undefined.
const ins = db.prepare("INSERT INTO t (a, n) VALUES (?, ?)").run("x", 1);
eq([ins.lastInsertRowid, ins.changes], [1, 1], "run(): lastInsertRowid + changes");
eq(typeof ins.lastInsertRowid, "number", "run(): lastInsertRowid is a number, not a bigint");
eq(db.prepare("SELECT a, n FROM t WHERE id = ?").get(1), { a: "x", n: 1 }, "get(): row by id");
eq(db.prepare("SELECT a FROM t WHERE id = ?").get(99), undefined, "get(): a miss is undefined, not null");
eq(db.prepare("SELECT a FROM t ORDER BY id").all(), [{ a: "x" }], "all(): rows");
eq(db.prepare("SELECT a FROM t WHERE id = 99").all(), [], "all(): a miss is an empty array");
eq(db.prepare("UPDATE t SET n = 2 WHERE id = ?").run(1).changes, 1, "run(): changes on UPDATE");
eq(db.prepare("INSERT INTO t (a, n) VALUES (?, ?)").run(null, null).changes, 1, "run(): NULL binds");

// Bare `@named` params against an object — what setProfile does (db.ts).
db.prepare("INSERT INTO t (id, a, n) VALUES (@id, @a, @n)").run({ id: 50, a: "named", n: 7 });
eq(db.prepare("SELECT a, n FROM t WHERE id = 50").get(), { a: "named", n: 7 }, "bind: bare @named params from an object");

// ── foreign_keys actually enforced ───────────────────────────────────────────
// The pragma above is meaningless if it didn't take: db.ts leans on FK cascade/restrict.
let fkEnforced = false;
try { db.prepare("INSERT INTO child (pid) VALUES (999)").run(); } catch { fkEnforced = true; }
eq(fkEnforced, true, "pragma: foreign_keys = ON is enforced, not just accepted");

// ── transaction: commit ───────────────────────────────────────────────────────
const added = db.transaction(() => {
  db.prepare("INSERT INTO t (a, n) VALUES ('tx', 10)").run();
  db.prepare("INSERT INTO t (a, n) VALUES ('tx', 20)").run();
  return "returned";
})();
eq(added, "returned", "transaction: passes the callback's return value through");
eq(db.prepare("SELECT count(*) c FROM t WHERE a='tx'").get().c, 2, "transaction: commits on return");

// ── transaction: rollback ─────────────────────────────────────────────────────
// The path that protects the DB from a half-applied multi-write (e.g. replacePortfolio,
// which deletes then re-inserts). A throw must undo the deletes AND resurface.
let threw = null;
try {
  db.transaction(() => {
    db.prepare("DELETE FROM t WHERE a='tx'").run();
    db.prepare("INSERT INTO t (a, n) VALUES ('rolled', 1)").run();
    throw new Error("boom");
  })();
} catch (e) { threw = e.message; }
eq(threw, "boom", "transaction: rethrows the original error");
eq(db.prepare("SELECT count(*) c FROM t WHERE a='tx'").get().c, 2, "transaction: rolls the DELETE back on throw");
eq(db.prepare("SELECT count(*) c FROM t WHERE a='rolled'").get().c, 0, "transaction: rolls the INSERT back on throw");

// The connection must be usable afterwards — a botched rollback leaves the transaction
// open and every later write fails with "cannot start a transaction within a transaction".
eq(db.transaction(() => "fine")(), "fine", "transaction: connection still usable after a rollback");

// ── transaction: nesting (SAVEPOINTs) ─────────────────────────────────────────
// Nothing nests today; this is the guard that keeps it correct if a future helper
// composes two transactional writes.
db.transaction(() => {
  db.prepare("INSERT INTO t (a, n) VALUES ('outer', 1)").run();
  try {
    db.transaction(() => {
      db.prepare("INSERT INTO t (a, n) VALUES ('inner', 1)").run();
      throw new Error("inner boom");
    })();
  } catch { /* swallowed: the outer transaction should still commit */ }
})();
eq(db.prepare("SELECT count(*) c FROM t WHERE a='outer'").get().c, 1, "transaction: outer commits when a nested one fails");
eq(db.prepare("SELECT count(*) c FROM t WHERE a='inner'").get().c, 0, "transaction: nested failure rolls back to its savepoint");

const nested = db.transaction(() => {
  db.prepare("INSERT INTO t (a, n) VALUES ('n-out', 1)").run();
  db.transaction(() => { db.prepare("INSERT INTO t (a, n) VALUES ('n-in', 1)").run(); })();
  return "ok";
})();
eq(nested, "ok", "transaction: nested success returns normally");
eq(db.prepare("SELECT count(*) c FROM t WHERE a IN ('n-out','n-in')").get().c, 2, "transaction: nested writes both commit");

// ── durability across handles ─────────────────────────────────────────────────
// The real invariant behind the plugin: a later session opens the same file and sees
// everything, in the same WAL format.
db.close();
const reopened = new Database(join(TMP, "t.db"));
eq(reopened.pragma("journal_mode"), [{ journal_mode: "wal" }], "reopen: still WAL on disk");
eq(reopened.pragma("integrity_check"), [{ integrity_check: "ok" }], "reopen: integrity_check ok");
eq(reopened.prepare("SELECT count(*) c FROM t WHERE a='tx'").get().c, 2, "reopen: committed rows survive a close/open");
reopened.close();

try { rmSync(TMP, { recursive: true, force: true }); } catch {}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
