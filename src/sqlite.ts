// sqlite.ts — the SQLite driver, backed by node:sqlite (built into Node itself).
//
// WHY this exists rather than a `new Database()` straight from a driver package: the server
// used to depend on better-sqlite3, a NATIVE module. A native module's compiled binary is
// pinned to Node's ABI (NODE_MODULE_VERSION), which bumps on every Node major. So a pinned
// release (`^11`) could never carry a prebuild for a Node that shipped after it — the user
// upgrades Node, the binding fails to load, and the whole server dies at import with an
// error that reads like a corrupt install. Bumping the pin only moves that wall forward one
// major; it is a treadmill, not a fix. Node's built-in driver ships WITH the runtime, so
// upgrading Node upgrades SQLite with it. There is nothing to compile, no node-gyp/MSVC
// toolchain, no prebuild to wait on upstream for, and no version to chase. That is the
// whole point: it keeps working across Node upgrades with zero intervention, by construction.
//
// The API below is the small slice of the better-sqlite3 surface db.ts actually used, so
// the call sites there are unchanged. Only `pragma` and `transaction` need real work —
// node:sqlite has no equivalent of either.
import { createRequire } from "node:module";

// node:sqlite still emits an ExperimentalWarning on some Node lines. It is noise on an MCP
// server's stderr (which is the log channel) and alarms users about a stable, on-disk format,
// so drop just that one warning — never a blanket suppression. This MUST run before the
// module is loaded, which is why node:sqlite is require()'d below rather than imported:
// ESM `import` is hoisted above statements, and would fire the warning before the filter.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
  const msg = typeof warning === "string" ? warning : (warning as Error | undefined)?.message ?? "";
  if (/SQLite is an experimental feature/i.test(msg)) return;
  return (emitWarning as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

// Structural types for the slice we use. Declared here rather than leaned on from
// @types/node so the build doesn't depend on which @types/node version types node:sqlite.
export interface RunResult { changes: number; lastInsertRowid: number | bigint }
export interface Statement {
  run(...params: unknown[]): RunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
type DatabaseSyncCtor = new (path: string) => {
  prepare(sql: string): Statement;
  exec(sql: string): void;
  close(): void;
};

// Feature-detect rather than compare version strings: node:sqlite was flag-gated on early
// Node 22 lines, so "the major is high enough" is not the same question as "it loads". This
// is the one hard requirement the server has, so fail with a message that says what to do.
function loadDatabaseSync(): DatabaseSyncCtor {
  try {
    const ctor = createRequire(import.meta.url)("node:sqlite")?.DatabaseSync;
    if (typeof ctor !== "function") throw new Error("node:sqlite loaded but exposes no DatabaseSync");
    return ctor as DatabaseSyncCtor;
  } catch (e) {
    throw new Error(
      `jobbot9000 needs Node's built-in SQLite (node:sqlite), which this runtime does not expose ` +
        `(running Node ${process.version}). Upgrade to Node 22.13+ (24 LTS or newer recommended) and ` +
        `start a new session. Original error: ${(e as Error)?.message ?? e}`,
    );
  }
}

/** A database handle exposing the better-sqlite3-shaped slice that db.ts calls. */
export class Database {
  #db: InstanceType<DatabaseSyncCtor>;
  #depth = 0; // open transaction nesting, for the SAVEPOINT path below

  constructor(path: string) {
    this.#db = new (loadDatabaseSync())(path);
  }

  prepare(sql: string): Statement { return this.#db.prepare(sql); }
  exec(sql: string): void { this.#db.exec(sql); }
  close(): void { this.#db.close(); }

  /**
   * `db.pragma("journal_mode = WAL")` — node:sqlite has no pragma(); statements carry it.
   * Prepared first so value-returning pragmas still hand back their rows; some pragmas
   * can't be prepared, so those fall through to exec().
   */
  pragma(stmt: string): unknown[] {
    const sql = `PRAGMA ${stmt}`;
    try { return this.#db.prepare(sql).all(); } catch { this.#db.exec(sql); return []; }
  }

  /**
   * `db.transaction(fn)` returns a function that runs `fn` atomically — same contract as
   * better-sqlite3: commit on return, roll back on throw, and rethrow. Nested calls use
   * SAVEPOINTs (SQLite has no nested BEGIN). Nothing nests today; this keeps it safe if
   * a future helper composes two transactional writes rather than silently corrupting one.
   */
  transaction<T>(fn: () => T): () => T {
    return (): T => {
      const nested = this.#depth > 0;
      const sp = `jb_sp_${this.#depth}`;
      this.#db.exec(nested ? `SAVEPOINT ${sp}` : "BEGIN");
      this.#depth++;
      try {
        const out = fn();
        this.#db.exec(nested ? `RELEASE ${sp}` : "COMMIT");
        return out;
      } catch (e) {
        // A failed rollback must not mask the error that caused it.
        try { this.#db.exec(nested ? `ROLLBACK TO ${sp}; RELEASE ${sp}` : "ROLLBACK"); } catch { /* ignore */ }
        throw e;
      } finally {
        this.#depth--;
      }
    };
  }
}

export default Database;
