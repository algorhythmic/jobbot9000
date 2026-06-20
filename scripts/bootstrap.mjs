// bootstrap.mjs — runs on SessionStart (see hooks/hooks.json).
// Makes the bundled MCP server runnable on a fresh install, and keeps it fast
// across plugin UPDATES by persisting node_modules in the durable data dir
// (CLAUDE_PLUGIN_DATA) instead of the ephemeral plugin root (CLAUDE_PLUGIN_ROOT,
// which changes on every update). node_modules is reinstalled only when
// package.json changes; dist/ is a cheap tsc rebuild once the deps are present.
// Uses only Node built-ins, so it works before `npm install` has ever run. It runs
// synchronously and swallows failures, so a broken setup never aborts the session.
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

try {
  if (!DATA) {
    // Local dev (no persistent dir): the simple, original behavior.
    if (!existsSync(rootNM)) { console.error("[jobbot9000] installing dependencies …"); install(ROOT); }
    if (!existsSync(distEntry)) { console.error("[jobbot9000] building …"); run("npm run build", ROOT); }
    process.exit(0);
  }

  // ── Persist node_modules in CLAUDE_PLUGIN_DATA; reinstall only on change ────
  mkdirSync(DATA, { recursive: true });
  const dataNM = join(DATA, "node_modules");
  const pkg = readFileSync(join(ROOT, "package.json"), "utf8");
  const pkgCache = join(DATA, "package.json");
  const stale = !existsSync(dataNM) || !existsSync(pkgCache) || readFileSync(pkgCache, "utf8") !== pkg;
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
    } else {
      rootResolves = true;                                // a real dir (dev checkout) — leave it
    }
  }
  if (!rootResolves) {
    try { symlinkSync(dataNM, rootNM, process.platform === "win32" ? "junction" : "dir"); } catch { /* unsupported */ }
  }
  // Fallback: if ROOT still can't see deps (e.g. symlinks unavailable), install locally so the build works.
  if (!existsSync(rootNM)) { console.error("[jobbot9000] symlink unavailable; installing dependencies locally …"); install(ROOT); }

  // ── Build dist/ (cheap once deps are present); rebuild if the entry is gone ─
  if (!existsSync(distEntry)) { console.error("[jobbot9000] building the MCP server …"); run("npm run build", ROOT); }
  console.error("[jobbot9000] ready. If tools aren't available yet, reload the plugin / start a new session.");
} catch (e) {
  console.error("[jobbot9000] setup failed:", e?.message ?? e);
}
process.exit(0); // swallow failures — a broken setup must never abort the session
