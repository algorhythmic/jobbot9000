// github.ts — the GitHub sense behind gather('ingest_portfolio'). Fetches a user's
// PUBLIC repos and returns structured facts; it never writes the DB and never calls the
// model. The deep judgment — which project to feature, architecture read, relevance to a
// role — is the agent's (the brain); this only supplies the raw facts to judge.
//
// Keyless by default (GitHub's unauthenticated REST API allows ~60 req/hr). The repo LIST
// is one call; ENRICHMENT (languages + README, so the grade isn't blind to the actual work)
// is ~2 calls/repo, so it's bounded by enrichMax and best run with GITHUB_TOKEN (raises the
// limit). Enrichment degrades gracefully — a rate-limit/error on a repo just leaves it at
// basic facts. Still no DB writes, no model calls: this only supplies raw facts to judge.

import type { FetchFn } from "./ats.js";

const README_MAX = 1500; // README excerpt length — enough to judge substance, not the whole file

export interface RepoFacts {
  repo: string;                 // full_name ("owner/name") — the portfolio PK
  name: string;
  description: string | null;
  language: string | null;      // GitHub's primary-language guess
  languages?: string[];         // full stack by bytes desc (enrichment) — undefined if not enriched
  readme_excerpt?: string | null; // first ~1500 chars of the README (enrichment)
  stars: number;
  forks: number;
  topics: string[];
  is_fork: boolean;
  is_archived: boolean;
  pushed_at: string | null;     // last push — recency/activity signal
  url: string;
  homepage: string | null;
}

export interface GithubOpts {
  fetchFn?: FetchFn;
  token?: string;               // optional — raises the rate limit
  maxPages?: number;            // pagination cap (100 repos/page)
  baseUrl?: string;             // test override
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const ghHeaders = (opts: GithubOpts): Record<string, string> => ({
  Accept: "application/vnd.github+json", "User-Agent": "jobbot9000",
  ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
});

function toFacts(r: any): RepoFacts | null {
  const repo = str(r?.full_name);
  if (!repo) return null;
  return {
    repo,
    name: str(r?.name) ?? repo,
    description: str(r?.description),
    language: str(r?.language),
    stars: num(r?.stargazers_count),
    forks: num(r?.forks_count),
    topics: Array.isArray(r?.topics) ? r.topics.filter((t: unknown) => typeof t === "string") : [],
    is_fork: !!r?.fork,
    is_archived: !!r?.archived,
    pushed_at: str(r?.pushed_at),
    url: str(r?.html_url) ?? `https://github.com/${repo}`,
    homepage: str(r?.homepage),
  };
}

/**
 * Fetch a user's public repos, most-recently-pushed first, as structured facts. Paginates
 * up to maxPages (100/page). Throws on an HTTP error (404 unknown user, 403 rate-limit,
 * …) with a readable message so the caller can return an honest note. Forks/archived are
 * returned as-is (flagged) — filtering is the caller's call.
 */
export async function fetchUserRepos(handle: string, opts: GithubOpts = {}): Promise<RepoFacts[]> {
  const f = opts.fetchFn ?? fetch;
  const base = opts.baseUrl ?? "https://api.github.com";
  const maxPages = opts.maxPages ?? 3;
  const headers = ghHeaders(opts);

  const out: RepoFacts[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const url = `${base}/users/${encodeURIComponent(handle)}/repos?per_page=100&sort=pushed&type=owner&page=${page}`;
    const res = await f(url, { headers });
    if (!res.ok) {
      if (res.status === 404) throw new Error(`no public GitHub user '${handle}'`);
      if (res.status === 403) throw new Error("GitHub rate limit hit (set GITHUB_TOKEN to raise it)");
      throw new Error(`GitHub HTTP ${res.status}`);
    }
    const page_data = await res.json();
    if (!Array.isArray(page_data) || page_data.length === 0) break;
    for (const r of page_data) { const facts = toFacts(r); if (facts) out.push(facts); }
    if (page_data.length < 100) break; // last page
  }
  return out;
}

/**
 * Enrich one repo so a relevance grade isn't blind to the actual work: the full LANGUAGE
 * breakdown (by bytes desc — surfaces e.g. the Python ETL hidden behind a TypeScript
 * primary) and a README excerpt (what the project actually is). ~2 keyless calls; errors/
 * rate-limits are swallowed (returns whatever it got), so enrichment never aborts ingest.
 */
export async function enrichRepo(repo: string, opts: GithubOpts = {}): Promise<{ languages: string[]; readme_excerpt: string | null }> {
  const f = opts.fetchFn ?? fetch;
  const base = opts.baseUrl ?? "https://api.github.com";
  const headers = ghHeaders(opts);

  let languages: string[] = [];
  try {
    const r = await f(`${base}/repos/${repo}/languages`, { headers });
    if (r.ok) {
      const j = await r.json();
      languages = Object.entries(j as Record<string, number>).sort((a, b) => b[1] - a[1]).map(([k]) => k);
    }
  } catch { /* leave empty */ }

  let readme_excerpt: string | null = null;
  try {
    const r = await f(`${base}/repos/${repo}/readme`, { headers: { ...headers, Accept: "application/vnd.github.raw+json" } });
    if (r.ok) {
      let text = await r.text();
      // Tolerate either raw markdown or the base64-JSON envelope (depends on proxy honoring the raw accept).
      if (text.startsWith("{")) { try { const j = JSON.parse(text); if (j?.content && j?.encoding === "base64") text = Buffer.from(j.content, "base64").toString("utf8"); } catch { /* keep raw */ } }
      readme_excerpt = text.slice(0, README_MAX).trim() || null;
    }
  } catch { /* leave null */ }

  return { languages, readme_excerpt };
}
