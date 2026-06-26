// pool.ts — the shared-catalog-pool seam behind gather('sync_catalog'). A pool is a
// remote store of PUBLIC catalog data that instances optionally sync against. This is the
// one place jobbot reaches OUTWARD to send data, so it's deliberately opt-in: with no
// JOBBOT_POOL_URL configured, getPool() returns null and sync_catalog does nothing but
// report the local diff — nothing leaves the machine. Only catalog data is ever sent
// (the snapshot is built from the catalog plane alone in db.ts; see catalogSnapshot).
//
// NOTE: no hosted pool ships with this build — the wire contract here (GET/POST {base}/catalog
// exchanging a CatalogSnapshot as JSON) is provisional. When a real pool exists, adapt this
// adapter (or add another behind the same interface) to its API; nothing else changes.

import type { CatalogSnapshot } from "./db.js";
import type { FetchFn } from "./ats.js";

export interface PushResult { accepted: number }
export interface PoolAdapter {
  name: string;
  pull(): Promise<CatalogSnapshot>;          // fetch the pool's catalog snapshot
  push(snap: CatalogSnapshot): Promise<PushResult>; // send local catalog (public data only)
}

export interface PoolConfig { url?: string; token?: string; fetchFn?: FetchFn }

// Returns null when no pool is configured — the default, so sync never egresses unasked.
export function getPool(cfg: PoolConfig): PoolAdapter | null {
  if (!cfg.url) return null;
  const f = cfg.fetchFn ?? fetch;
  const base = cfg.url.replace(/\/+$/, "");
  const headers: Record<string, string> = { "Content-Type": "application/json", "User-Agent": "jobbot9000" };
  if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
  return {
    name: "http",
    async pull() {
      const r = await f(`${base}/catalog`, { headers });
      if (!r.ok) throw new Error(`pool pull → HTTP ${r.status}`);
      const j = await r.json();
      // tolerate a bare snapshot or a wrapped one
      return { companies: j?.companies ?? [], jobs: j?.jobs ?? [] } as CatalogSnapshot;
    },
    async push(snap) {
      const r = await f(`${base}/catalog`, { method: "POST", headers, body: JSON.stringify(snap) });
      if (!r.ok) throw new Error(`pool push → HTTP ${r.status}`);
      const j = await r.json().catch(() => ({}));
      return { accepted: typeof j?.accepted === "number" ? j.accepted : snap.companies.length + snap.jobs.length };
    },
  };
}
