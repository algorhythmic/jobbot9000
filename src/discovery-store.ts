// Explicit bridge to private persistence. Import only in a configured private
// runtime: db.ts opens its private SQLite database. The loop itself stays inert.
import { loadDiscoveryRun, saveDiscoveryRun } from "./db.js";
import type { DiscoveryRun, DiscoveryStore } from "./discovery.js";
export const privateDiscoveryStore: DiscoveryStore = {
  load: (id) => loadDiscoveryRun<DiscoveryRun>(id),
  save: (run) => saveDiscoveryRun(run),
};
// Safe executive receipt; keep findings, source URLs, drafts and free text private.
export function discoveryReceipt(run: DiscoveryRun) {
  return {
    id: run.id, status: run.status, companies: run.companies.length,
    jobs: run.companies.reduce((n, company) => n + company.jobs.length, 0),
    requests: run.requests,
  };
}
