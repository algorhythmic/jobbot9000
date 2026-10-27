// Offline people collection. No default transport, sending, invitation or draft API.
// All source content is inert data and never becomes an instruction/tool call.
import { allowedUrl, type SourcePolicy, type ReadLedger } from "./discovery.js";
import { assertPeopleSourceUrl, assertPeopleReferenceUrl, parsePeoplePublication } from "./people-sources.js";
import type { PeopleSourceKind, PeopleStore } from "./people-types.js";

export interface PeopleSource {
  companyId: string; url: string; kind: PeopleSourceKind;
  public: true; professional: true;
}
export interface PeopleReply {
  status: number; body?: unknown; redirect?: string; retryAfterSeconds?: number;
}
export interface PeopleAdapter {
  fixtureOnly: true;
  read(request: { url: string; method: "GET"; redirect: "manual"; signal: AbortSignal }): Promise<PeopleReply>;
}
export interface PeopleOptions {
  id: string; execute?: boolean; sources: PeopleSource[];
  ttlMs?: number; maxCompanies?: number; maxPages?: number; timeoutMs?: number;
  signal?: AbortSignal;
  operatorReferences?: { personId: string; url: string }[];
}
export interface PeopleDeps {
  adapter: PeopleAdapter; store: PeopleStore; ledger: ReadLedger; policies: SourcePolicy[];
  now?: () => number; sleep?: (ms: number) => Promise<void>;
}
const bound = (value: number | undefined, fallback: number, maximum: number) => {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("invalid people collection bound");
  return Math.min(value, maximum);
};
const opaque = (id: string) => /^[a-zA-Z0-9_-]{1,80}$/.test(id);
export async function collectPeople(options: PeopleOptions, deps?: PeopleDeps) {
  if (!opaque(options.id)) throw new Error("invalid people run ID");
  const limits = { companies: bound(options.maxCompanies, 10, 10), pages: bound(options.maxPages, 30, 30) };
  const timeout = bound(options.timeoutMs, 10000, 30000);
  if (options.execute !== true) return { id: options.id, dry_run: true as const, limits };
  if (!deps || deps.adapter.fixtureOnly !== true) throw new Error("only injected synthetic people adapters are enabled");
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  if (options.ttlMs !== undefined && (!Number.isSafeInteger(options.ttlMs) || options.ttlMs < 1 || options.ttlMs > 365 * 86400000))
    throw new Error("invalid people retention TTL");
  // Validate all initial inputs before the first adapter call or private write.
  if (!Array.isArray(options.sources)) throw new Error("invalid people sources");
  for (const source of options.sources) {
    if (!source || !opaque(source.companyId) || source.public !== true || source.professional !== true
      || !["job_post", "official_team", "official_api"].includes(source.kind)) throw new Error("unsupported people source");
    assertPeopleSourceUrl(source.url);
    allowedUrl(source.url, "discover", deps.policies, now());
  }
  for (const reference of options.operatorReferences ?? []) {
    if (!opaque(reference.personId)) throw new Error("invalid operator reference ID");
    assertPeopleReferenceUrl(reference.url); // Never fetched, resolved, previewed or pinged.
  }
  const counts = { pages: 0, collected: 0, ambiguous: 0, stale: 0, suppressed: 0, purged: 0 };
  const check = () => { if (options.signal?.aborted) throw new Error("cancelled"); };
  const read = async (initial: string): Promise<{ body: unknown; url: string }> => {
    let url = initial, redirects = 0, retries = 0;
    while (true) {
      check(); assertPeopleSourceUrl(url);
      let safe = allowedUrl(url, "discover", deps.policies, now());
      if (counts.pages >= limits.pages) throw new Error("page_limit");
      const release = await deps.ledger.acquire(safe.hostname, now, sleep, 500);
      const controller = new AbortController();
      let rejectAbort: ((error: Error) => void) | undefined;
      const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
      const abort = () => { controller.abort(); rejectAbort?.(new Error("cancelled")); };
      options.signal?.addEventListener("abort", abort, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        check(); safe = allowedUrl(url, "discover", deps.policies, now());
        counts.pages++;
        const reply = await Promise.race([
          deps.adapter.read({ url: safe.href, method: "GET", redirect: "manual", signal: controller.signal }), aborted,
          new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("timeout")); }, timeout); }),
        ]);
        if (timer) { clearTimeout(timer); timer = undefined; }
        check();
        if (!Number.isSafeInteger(reply.status) || reply.status < 100 || reply.status > 599) throw new Error("invalid_reply");
        if ([301, 302, 303, 307, 308].includes(reply.status)) {
          if (!reply.redirect || ++redirects > 2) throw new Error("redirect_limit");
          url = new URL(reply.redirect, safe).href; continue;
        }
        if (reply.status === 429 || reply.status >= 500) {
          if (retries++ >= 2) throw new Error("retry_limit");
          const delay = reply.retryAfterSeconds ?? 2 ** retries;
          if (!Number.isFinite(delay) || delay < 0 || delay > 60) throw new Error("retry_after");
          await sleep(delay * 1000); continue; // Hold shared host slot during cooldown.
        }
        if (reply.status < 200 || reply.status >= 300) throw new Error("source_denied");
        return { body: reply.body, url: safe.href };
      } finally {
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort); release();
      }
    }
  };
  try {
    check(); counts.purged = deps.store.purgeExpired(now());
    const companies = new Set<string>();
    for (const source of options.sources) {
      if (!companies.has(source.companyId) && companies.size >= limits.companies) break;
      companies.add(source.companyId);
      const response = await read(source.url);
      if (!response.body || typeof response.body !== "object" || Array.isArray(response.body)) throw new Error("invalid_publication");
      const body = response.body as Record<string, unknown>;
      const people = parsePeoplePublication({ ...body, companyId: source.companyId, sourceUrl: response.url,
        sourceKind: source.kind, public: source.public, professional: source.professional,
        fetchedAt: body.fetchedAt ?? now(),
      } as Parameters<typeof parsePeoplePublication>[0], { now: now(), ttlMs: options.ttlMs });
      for (const person of people) {
        if (person.provenance.expiresAt <= now()) { counts.stale++; continue; }
        person.references = [...new Set([...person.references, ...(options.operatorReferences ?? [])
          .filter((reference) => reference.personId === person.id).map((reference) => reference.url)])];
        if (deps.store.collect(person)) { counts.collected++; if (person.match === "ambiguous") counts.ambiguous++; }
        else counts.suppressed++;
      }
    }
    return { id: options.id, dry_run: false as const, status: "collected" as const, counts };
  } catch {
    // Adapter/parser/source errors may contain private strings. Return no free text.
    return { id: options.id, dry_run: false as const,
      status: options.signal?.aborted ? "cancelled" as const : "stopped" as const, counts };
  }
}
