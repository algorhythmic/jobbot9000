// github.ts — the GitHub sense behind gather('ingest_portfolio'). Fetches a user's
// PUBLIC repos and returns structured facts; it never writes the DB and never calls the
// model. The deep judgment — which project to feature, architecture read, relevance to a
// role — is the agent's (the brain); this only supplies the raw facts to judge.
//
// Keyless by default (GitHub's unauthenticated REST API allows ~60 req/hr — plenty for
// one user, since a repo list is 1–few requests). GITHUB_TOKEN, if set, raises the limit;
// it's an optional accelerator, never required. We read only the repos-list payload (no
// per-repo language/README calls) to stay well inside the rate limit and keep it one pass.

import type { FetchFn } from "./ats.js";

export interface RepoFacts {
  repo: string;                 // full_name ("owner/name") — the portfolio PK
  name: string;
  description: string | null;
  language: string | null;      // GitHub's primary-language guess
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
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "jobbot9000" };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;

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
