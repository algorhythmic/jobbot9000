// Offline discovery-loop core. No transport is installed or enabled here.
import { isIP } from "node:net";

export type Phase = "discover" | "resolve" | "jobs";
export interface SourcePolicy {
  host: string; allowed: boolean; operations: Phase[]; policyRef: string;
  checkedAt: number; expiresAt: number;
}
export interface Candidate { name: string; domain: string; boardUrl?: string }
export interface Finding { url: string; title: string }
export interface Provenance { url: string; fetchedAt: number; confidence: "source_reported"; staleAfter: number }
export interface CompanyResult { company: Candidate; jobs: Finding[]; provenance: Provenance[]; score?: number }
export interface DiscoveryRun {
  schemaVersion: 1; id: string; status: "running" | "completed" | "no_results" | "cancelled" | "stopped";
  phase: Phase; cursor?: string; companyIndex: number; companies: CompanyResult[];
  requests: number; reason?: string; updatedAt: number; ttlMs: number; inputCompanies?: Candidate[];
}
export interface DiscoveryStore { load(id: string): DiscoveryRun | undefined; save(run: DiscoveryRun): void }
export interface Reply { status: number; body?: unknown; redirect?: string; retryAfterSeconds?: number }
export interface FixtureAdapter {
  // This implementation deliberately cannot enable a live transport.
  fixtureOnly: true;
  url(phase: Phase, company?: Candidate, cursor?: string): string;
  read(url: string, signal: AbortSignal): Promise<Reply>;
  companies(body: unknown): { items: Candidate[]; next?: string };
  resolved(body: unknown, company: Candidate): Candidate;
  jobs(body: unknown): { items: Finding[]; next?: string };
}
export interface ReadLedger {
  acquire(host: string, now: () => number, sleep: (ms: number) => Promise<void>, dailyLimit: number): Promise<() => void>;
}
export interface DiscoveryDeps {
  adapter: FixtureAdapter; store: DiscoveryStore; ledger: ReadLedger; policies: SourcePolicy[];
  now?: () => number; sleep?: (ms: number) => Promise<void>; random?: () => number;
  score?: (company: Candidate, jobs: readonly Finding[]) => number;
}
export interface DiscoveryOptions {
  id: string; execute?: boolean; resume?: boolean; refreshStale?: boolean; companies?: Candidate[]; signal?: AbortSignal;
  maxCompanies?: number; maxRequests?: number; maxDailyRequests?: number; ttlMs?: number; timeoutMs?: number;
}
const bound = (n: number | undefined, fallback: number, max: number): number => {
  if (n === undefined) return fallback;
  if (!Number.isSafeInteger(n) || n < 1) throw new Error("invalid positive bound");
  return Math.min(n, max);
};
const candidate = (value: unknown): value is Candidate => {
  if (!value || typeof value !== "object") return false;
  const c = value as Candidate;
  return typeof c.name === "string" && !!c.name.trim() && typeof c.domain === "string" && !!c.domain.trim()
    && (c.boardUrl === undefined || (typeof c.boardUrl === "string" && !!c.boardUrl.trim()));
};
export function allowedUrl(raw: string, phase: Phase, policies: readonly SourcePolicy[], now: number): URL {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("invalid policy check timestamp");
  const url = new URL(raw);
  const host = url.hostname.toLowerCase();
  if (host.endsWith(".")) throw new Error("ambiguous trailing-dot host");
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) throw new Error("unsafe URL");
  if (isIP(host.replace(/^\[|\]$/g, "")) || !host.includes(".") || /(^|\.)(localhost|local|internal|linkedin\.com)$/.test(host) || host.endsWith(".home.arpa")) throw new Error("prohibited host");
  if (/(^|\/)(login|log-in|signin|sign-in|auth|captcha)(\/|$)/i.test(decodeURIComponent(url.pathname))) throw new Error("prohibited interaction");
  const policy = policies.find((p) => p.host.toLowerCase() === host && p.allowed && p.operations.includes(phase));
  if (!policy || !Number.isSafeInteger(policy.checkedAt) || !Number.isSafeInteger(policy.expiresAt) || policy.checkedAt < 0 || !/^https:\/\//.test(policy.policyRef) || policy.checkedAt > now || policy.expiresAt <= now || policy.checkedAt >= policy.expiresAt) throw new Error("source policy missing or stale");
  return url;
}

// Share one instance across synthetic workers. Not a cross-process production ledger.
export function memoryReadLedger(): ReadLedger {
  const tails = new Map<string, Promise<void>>();
  const last = new Map<string, number>();
  const days = new Map<string, number>();
  return {
    async acquire(host, now, sleep, dailyLimit) {
      const previous = tails.get(host) ?? Promise.resolve();
      let release!: () => void;
      const next = new Promise<void>((resolve) => { release = resolve; });
      const tail = previous.then(() => next);
      tails.set(host, tail);
      await previous;
      try {
        const delay = Math.max(0, (last.get(host) ?? -Infinity) + 1000 - now());
        if (delay) await sleep(delay);
        const day = new Date(now()).toISOString().slice(0, 10);
        const used = days.get(day) ?? 0;
        if (used >= dailyLimit) throw new Error("daily request budget exhausted");
        days.set(day, used + 1); last.set(host, now());
        return () => { release(); if (tails.get(host) === tail) tails.delete(host); };
      } catch (error) { release(); throw error; }
    },
  };
}

export async function discoverCompanies(options: DiscoveryOptions, deps?: DiscoveryDeps) {
  const limits = {
    companies: bound(options.maxCompanies, 25, 25), requests: bound(options.maxRequests, 100, 100),
    daily: bound(options.maxDailyRequests, 500, 500),
  };
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(options.id)) throw new Error("invalid run ID");
  if (options.execute !== true) return { dry_run: true as const, id: options.id, limits };
  if (!deps || deps.adapter.fixtureOnly !== true) throw new Error("only explicitly injected synthetic adapters are enabled");
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeout = bound(options.timeoutMs, 10000, 30000);
  let run: DiscoveryRun;
  if (options.companies !== undefined && (!Array.isArray(options.companies) || !options.companies.every(candidate))) {
    throw new Error("invalid manual company input");
  }
  const selectedInput = options.companies?.map((c) => ({ name: c.name.trim(), domain: c.domain.trim().toLowerCase(),
    ...(c.boardUrl === undefined ? {} : { boardUrl: c.boardUrl.trim() }) }))
    .filter((c, i, all) => all.findIndex((x) => x.domain === c.domain) === i).slice(0, limits.companies);
  const existing = deps.store.load(options.id);
  if (!options.resume && existing) throw new Error("run ID already exists; request resume explicitly");
  const loaded = options.resume ? existing : undefined;
  if (options.resume && !loaded) throw new Error("resume run not found");
  if (loaded) {
    // Persistence is an untrusted boundary. Never reinterpret unknown state as
    // a fresh run or advance a corrupt cursor by making more source reads.
    if (loaded.schemaVersion !== 1) throw new Error("unsupported persisted discovery schema version");
    if (loaded.id !== options.id) throw new Error("stored run ID mismatch");
    const timestamp = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
    const company = (value: unknown): boolean => {
      if (!value || typeof value !== "object") return false;
      const c = value as CompanyResult;
      return candidate(c.company) && c.company.domain === c.company.domain.trim().toLowerCase()
        && Array.isArray(c.jobs) && c.jobs.length <= 1000
        && c.jobs.every((job) => job && typeof job.url === "string" && !!job.url && typeof job.title === "string" && !!job.title)
        && Array.isArray(c.provenance) && c.provenance.length <= 100
        && c.provenance.every((p) => p && typeof p.url === "string" && !!p.url && p.confidence === "source_reported"
          && timestamp(p.fetchedAt) && timestamp(p.staleAfter) && p.staleAfter > p.fetchedAt)
        && (c.score === undefined || (typeof c.score === "number" && Number.isFinite(c.score)));
    };
    if (!["running", "completed", "no_results", "cancelled", "stopped"].includes(loaded.status)
      || !["discover", "resolve", "jobs"].includes(loaded.phase)
      || !Array.isArray(loaded.companies) || loaded.companies.length > 25 || !loaded.companies.every(company)
      || (loaded.inputCompanies !== undefined && (!Array.isArray(loaded.inputCompanies) || loaded.inputCompanies.length > 25 || !loaded.inputCompanies.every(candidate)))
      || !Number.isSafeInteger(loaded.companyIndex) || loaded.companyIndex < 0 || loaded.companyIndex > loaded.companies.length
      || !Number.isSafeInteger(loaded.requests) || loaded.requests < 0 || loaded.requests > 100
      || !Number.isSafeInteger(loaded.updatedAt) || loaded.updatedAt < 0
      || !Number.isSafeInteger(loaded.ttlMs) || loaded.ttlMs < 1 || loaded.ttlMs > 30 * 86400000
      || (loaded.cursor !== undefined && typeof loaded.cursor !== "string")) throw new Error("invalid persisted discovery state");
  }
  const ttl = bound(options.ttlMs, loaded?.ttlMs ?? 86400000, 30 * 86400000);
  const manualInput = selectedInput ?? loaded?.inputCompanies;
  const fresh = (): DiscoveryRun => ({ schemaVersion: 1, id: options.id, status: "running", phase: manualInput ? "resolve" : "discover", companyIndex: 0,
    ...(manualInput ? { inputCompanies: structuredClone(manualInput) } : {}), ttlMs: ttl,
    companies: (manualInput ?? []).map((c) => ({ company: { ...c }, jobs: [], provenance: [] })), requests: 0, updatedAt: now() });
  run = loaded ? structuredClone(loaded) : fresh();
  if (loaded && ["completed", "no_results"].includes(loaded.status)) {
    const stale = loaded.status === "no_results"
      ? loaded.updatedAt + (loaded.ttlMs ?? ttl) <= now()
      : loaded.companies.some((c) => c.provenance.some((p) => p.staleAfter <= now()));
    if (!options.refreshStale || !stale) return { dry_run: false as const, run };
    run = fresh();
  }
  run.status = "running"; delete run.reason;
  const save = () => { run.updatedAt = now(); deps.store.save(structuredClone(run)); };
  const check = () => { if (options.signal?.aborted) throw new Error("cancelled"); };
  const provenance = (url: string): Provenance => ({ url, fetchedAt: now(), confidence: "source_reported", staleAfter: now() + ttl });
  const backoff = (attempt: number): number => {
    const jitter = (deps.random ?? Math.random)();
    if (!Number.isFinite(jitter) || jitter < 0 || jitter > 1) throw new Error("invalid backoff random value");
    return 2 ** attempt * 1000 + Math.floor(jitter * 1000);
  };
  const read = async (initial: string, phase: Phase): Promise<{ body: unknown; url: string }> => {
    let url = initial, redirects = 0, retries = 0;
    while (true) {
      check();
      const safe = allowedUrl(url, phase, deps.policies, now());
      if (run.requests >= limits.requests) throw new Error("run request budget exhausted");
      const release = await deps.ledger.acquire(safe.hostname, now, sleep, limits.daily);
      let reply: Reply;
      const controller = new AbortController();
      let rejectAbort: ((reason: Error) => void) | undefined;
      const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
      const abort = () => { controller.abort(); rejectAbort?.(new Error("cancelled")); };
      options.signal?.addEventListener("abort", abort, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        check();
        // Waiting for a shared domain slot may outlive the terms decision.
        allowedUrl(safe.href, phase, deps.policies, now());
        run.requests++; save();
        reply = await Promise.race([
          deps.adapter.read(safe.href, controller.signal), aborted,
          new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("request timeout")); }, timeout); }),
        ]);
        check();
        if (!Number.isSafeInteger(reply.status) || reply.status < 100 || reply.status > 599) throw new Error("invalid source HTTP status");
        if ([301, 302, 303, 307, 308].includes(reply.status)) {
          if (!reply.redirect || ++redirects > 2) throw new Error("redirect limit or missing target");
          url = new URL(reply.redirect, safe).href; continue;
        }
        if (reply.status === 429 || reply.status >= 500) {
          if (retries++ >= 2) throw new Error("retry limit exhausted");
          const retry = reply.retryAfterSeconds;
          if (retry !== undefined && (!Number.isFinite(retry) || retry < 0 || retry > 60)) throw new Error("unsupported Retry-After");
          // Keep the shared host slot through cooldown so other workers cannot
          // issue reads while this source asks us to wait.
          await sleep(retry === undefined ? backoff(retries) : retry * 1000); continue;
        }
        if (reply.status < 200 || reply.status >= 300) throw new Error(`source denied HTTP ${reply.status}`);
        return { body: reply.body, url: safe.href };
      } catch (error) {
        if (!options.signal?.aborted && error instanceof Error && error.message === "request timeout" && retries++ < 2) {
          await sleep(backoff(retries)); continue;
        }
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort); release();
      }
    }
  };
  save();
  try {
    while (true) {
      check();
      if (run.phase === "discover") {
        const response = await read(deps.adapter.url("discover", undefined, run.cursor), "discover");
        const page = deps.adapter.companies(response.body);
        for (const candidate of page.items) {
          if (!candidate.name || !candidate.domain) continue;
          const domain = candidate.domain.trim().toLowerCase();
          if (run.companies.some((x) => x.company.domain === domain)) continue;
          if (run.companies.length >= limits.companies) break;
          run.companies.push({ company: { ...candidate, domain }, jobs: [], provenance: [provenance(response.url)] });
        }
        if (page.next && page.next !== run.cursor && run.companies.length < limits.companies) run.cursor = page.next;
        else { run.phase = "resolve"; delete run.cursor; }
        save();
      } else {
        const result = run.companies[run.companyIndex];
        if (!result) {
          run.status = run.companies.length ? "completed" : "no_results";
          if (run.status === "no_results") run.reason = "no_candidates";
          save(); break;
        }
        const response = await read(deps.adapter.url(run.phase, result.company, run.cursor), run.phase);
        result.provenance.push(provenance(response.url));
        if (run.phase === "resolve") {
          const resolved = deps.adapter.resolved(response.body, structuredClone(result.company));
          if (!resolved || typeof resolved.name !== "string" || !resolved.name.trim()
            || typeof resolved.domain !== "string" || resolved.domain.trim().toLowerCase() !== result.company.domain) {
            throw new Error("resolved company identity mismatch");
          }
          result.company = { ...resolved, domain: result.company.domain };
          run.phase = "jobs";
        } else {
          const page = deps.adapter.jobs(response.body);
          for (const job of page.items) {
            if (result.jobs.length >= 1000) break;
            // References are policy-checked too; this loop never opens application URLs.
            if (job.url && job.title) {
              const normalized = allowedUrl(job.url, "jobs", deps.policies, now()).href;
              if (!result.jobs.some((x) => x.url === normalized)) result.jobs.push({ url: normalized, title: job.title });
            }
          }
          if (page.next && page.next !== run.cursor && result.jobs.length < 1000) run.cursor = page.next;
          else {
            if (deps.score) {
              const score = deps.score(structuredClone(result.company), structuredClone(result.jobs));
              if (!Number.isFinite(score)) throw new Error("score callback returned nonfinite value");
              result.score = score;
            }
            run.companyIndex++; run.phase = "resolve"; delete run.cursor;
          }
        }
        save();
      }
    }
  } catch (error) {
    run.status = options.signal?.aborted ? "cancelled" : "stopped";
    run.reason = error instanceof Error ? error.message : "discovery failed"; save();
  }
  return { dry_run: false as const, run };
}
