// bootstrap.mjs — runs on SessionStart (see hooks/hooks.json).
// Makes the bundled MCP server runnable on a fresh install, and keeps it fast
// across plugin UPDATES by persisting node_modules in the durable data dir
// (CLAUDE_PLUGIN_DATA) instead of the ephemeral plugin root (CLAUDE_PLUGIN_ROOT,
// which changes on every update). node_modules is reinstalled only when
// package.json changes; dist/ is a cheap tsc rebuild once the deps are present.
// Uses only Node built-ins, so it works before `npm install` has ever run. It runs
// synchronously and swallows failures, so a broken setup never aborts the session.
//
// Note what this deliberately does NOT do: rebuild anything when Node changes. The server
// has no native dependency (SQLite comes from Node itself — see src/sqlite.ts), so the
// installed tree is pure JavaScript and is not tied to a Node ABI. A user upgrading Node
// needs no reinstall, no recompile, and no action at all; that is the whole design.
import { existsSync, mkdirSync, copyFileSync, readFileSync, lstatSync, symlinkSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = process.env.CLAUDE_PLUGIN_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = process.env.CLAUDE_PLUGIN_DATA; // persistent, per-plugin dir; unset in local dev
const rootNM = join(ROOT, "node_modules");
const distEntry = join(ROOT, "dist", "index.js");
const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: "inherit" });
const pathNode = (p) => { try { lstatSync(p); return true; } catch { return false; } };
// Prefer `npm ci` (deterministic; fails closed on lockfile drift) when a lockfile is present.
const install = (dir) => run(existsSync(join(dir, "package-lock.json")) ? "npm ci --no-fund" : "npm install --no-fund", dir);

// The one hard runtime requirement: Node's built-in SQLite (node:sqlite), which is
// unflagged from 22.13. Checked here so the user gets one actionable line at session start
// rather than an opaque module-not-found when the server tries to open the database.
const [maj, min] = process.versions.node.split(".").map(Number);
if (maj < 22 || (maj === 22 && min < 13)) {
  console.error(
    `[jobbot9000] Node ${process.versions.node} is too old — jobbot9000 needs Node 22.13+ ` +
      `(24 LTS or newer recommended) for its built-in SQLite. The server will not start until Node is upgraded.`,
  );
}

// A node_modules FOLDER is not proof of a usable install: a plugin-install copy can carry
// the directory but drop files inside it, which only fails later at import. Checking that
// each runtime dep is actually present (dir + its package.json) is cheap and catches that.
const deps = ["@modelcontextprotocol/sdk", "zod"];
const depsOk = (nmDir) => existsSync(nmDir) && deps.every((d) => existsSync(join(nmDir, d, "package.json")));

try {
  if (!DATA) {
    // Local dev (no persistent dir): the simple, original behavior.
    if (!depsOk(rootNM)) { console.error("[jobbot9000] installing dependencies …"); install(ROOT); }
    if (!existsSync(distEntry)) { console.error("[jobbot9000] building …"); run("npm run build", ROOT); }
    process.exit(0);
  }

  // ── Persist node_modules in CLAUDE_PLUGIN_DATA; reinstall only on change ────
  mkdirSync(DATA, { recursive: true });
  const dataNM = join(DATA, "node_modules");
  const pkg = readFileSync(join(ROOT, "package.json"), "utf8");
  const pkgCache = join(DATA, "package.json");
  const stale = !depsOk(dataNM) || !existsSync(pkgCache) || readFileSync(pkgCache, "utf8") !== pkg;
  if (stale) {
    console.error("[jobbot9000] installing dependencies into the plugin data dir (persists across updates) …");
    copyFileSync(join(ROOT, "package.json"), pkgCache);
    const lock = join(ROOT, "package-lock.json");
    if (existsSync(lock)) copyFileSync(lock, join(DATA, "package-lock.json"));
    install(DATA);
  }

  // ── Make ROOT resolve the persisted deps (so tsc + node both find them) ─────
  let rootResolves = false;
  if (pathNode(rootNM)) {
    if (lstatSync(rootNM).isSymbolicLink()) {
      if (existsSync(rootNM)) rootResolves = true;        // valid link from a prior run
      else rmSync(rootNM, { force: true });               // dangling link → recreate below
    } else if (depsOk(rootNM)) {
      rootResolves = true;                                // a real, complete dir (dev checkout) — leave it
    } else {
      // A real dir with deps missing — e.g. an install copy that carried node_modules but
      // dropped files. It would shadow the good deps in DATA and break the server, so drop
      // it and relink to the data dir below.
      console.error("[jobbot9000] plugin-root deps are incomplete — relinking to the data dir …");
      rmSync(rootNM, { recursive: true, force: true });
    }
  }
  if (!rootResolves) {
    try { symlinkSync(dataNM, rootNM, process.platform === "win32" ? "junction" : "dir"); } catch { /* unsupported */ }
  }
  // Fallback: if ROOT still can't see deps (e.g. symlinks unavailable), install locally so the build works.
  if (!depsOk(rootNM)) { console.error("[jobbot9000] symlink unavailable; installing dependencies locally …"); install(ROOT); }

  // ── Build dist/ (cheap once deps are present); rebuild if the entry is gone ─
  if (!existsSync(distEntry)) { console.error("[jobbot9000] building the MCP server …"); run("npm run build", ROOT); }
  console.error("[jobbot9000] ready. If tools aren't available yet, reload the plugin / start a new session.");
} catch (e) {
  console.error("[jobbot9000] setup failed:", e?.message ?? e);
}
process.exit(0); // swallow failures — a broken setup must never abort the session
