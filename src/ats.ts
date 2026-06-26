// ats.ts — free, keyless ATS-slug resolution (Tool 1, stage 4). Given a company's
// name + domain, find which public ATS board it runs and its slug. Every endpoint is
// a keyless GET keyed on a per-company slug; there is NO cross-company search, so we
// derive candidate slugs and probe. Endpoints per ats_endpoint_verification.md (see
// the dev handoff §5). An EMPTY-but-valid board counts as RESOLVED (the company uses
// that ATS; it just has no live postings right now) — only a 404/garbage board is a
// miss. This module never writes the DB and holds no key; tools.ts persists the result.
//
// NOTE: the Workable endpoint shape is the least-verified here; confirm it against
// ats_endpoint_verification.md before trusting it in production. The others (Ashby,
// Greenhouse, Lever) match the verified table in the handoff.

export type AtsPlatform = "ashby" | "greenhouse" | "lever" | "workable";

export interface AtsResolution {
  platform: AtsPlatform;
  slug: string;
  job_count: number;
  via: "domain" | "name"; // which candidate hit — domain-derived is higher-confidence
}

export type FetchFn = typeof fetch;

// Resolution order: Ashby → Greenhouse → Lever → Workable (handoff §5 / tool1_build stage 4).
const ORDER: AtsPlatform[] = ["ashby", "greenhouse", "lever", "workable"];

// ── slug candidates ─────────────────────────────────────────────────────────
// Domain-derived slugs are primary (trusted); name-derived are the fallback and get
// corroborated by the caller's collision guard (db.ts resolveCompany is collision-safe).
const slugify = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "").trim();

export function slugCandidates(name: string, domain?: string | null): { slug: string; via: "domain" | "name" }[] {
  const out: { slug: string; via: "domain" | "name" }[] = [];
  const seen = new Set<string>();
  const add = (slug: string, via: "domain" | "name") => {
    if (slug && !seen.has(slug)) { seen.add(slug); out.push({ slug, via }); }
  };
  // domain → second-level label (acme.com → "acme"; jobs.acme.io → "acme")
  if (domain) {
    const host = domain.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/?#].*$/, "");
    const labels = host.split(".").filter(Boolean);
    if (labels.length >= 2) add(slugify(labels[labels.length - 2]), "domain");
    else if (labels.length === 1) add(slugify(labels[0]), "domain");
  }
  // name → compact slug, and a dash-joined variant some boards use
  const words = name.toLowerCase().replace(/\b(inc|llc|ltd|corp|co|the)\b/g, "").split(/[^a-z0-9]+/).filter(Boolean);
  add(slugify(words.join("")), "name");
  add(slugify(name), "name");
  return out;
}

// ── per-ATS probes — return the live job count for a valid board, or null on miss ──
// A valid board with zero postings returns 0 (resolved). A 404/non-OK/garbage returns null.
const okJson = async (res: Response): Promise<any | null> => {
  if (!res.ok) return null;
  try { return await res.json(); } catch { return null; }
};

const PROBES: Record<AtsPlatform, (slug: string, f: FetchFn) => Promise<number | null>> = {
  // Ashby — GET (not POST); { jobs: [...] }
  ashby: async (slug, f) => {
    const j = await okJson(await f(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=true`));
    return j && Array.isArray(j.jobs) ? j.jobs.length : null;
  },
  // Greenhouse — { jobs: [...], meta: { total } }
  greenhouse: async (slug, f) => {
    const j = await okJson(await f(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`));
    return j && Array.isArray(j.jobs) ? j.jobs.length : null;
  },
  // Lever — a bare array of postings
  lever: async (slug, f) => {
    const j = await okJson(await f(`https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`));
    return Array.isArray(j) ? j.length : null;
  },
  // Workable — public widget feed (least-verified; see file header note)
  workable: async (slug, f) => {
    const j = await okJson(await f(`https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(slug)}?details=true`));
    return j && Array.isArray(j.jobs) ? j.jobs.length : null;
  },
};

export interface ResolveOpts {
  fetchFn?: FetchFn;
  order?: AtsPlatform[]; // override probe order (tests / tuning)
}

/**
 * Resolve a company to its ATS board. Walks the platform order; for each platform tries
 * domain-derived slugs before name-derived ones. Returns the first valid board (incl.
 * empty) as { platform, slug, job_count, via }, or null if nothing resolved. Network
 * errors on a single probe are swallowed (treated as a miss) so one dead host never
 * aborts resolution — a dead slug just 404s and is skipped, never fatal (handoff §5).
 */
export async function resolveAts(
  company: { name: string; domain?: string | null },
  opts: ResolveOpts = {},
): Promise<AtsResolution | null> {
  const f = opts.fetchFn ?? fetch;
  const order = opts.order ?? ORDER;
  const candidates = slugCandidates(company.name, company.domain);
  // domain candidates first across all platforms, then name candidates — domain is primary.
  for (const via of ["domain", "name"] as const) {
    for (const cand of candidates.filter((c) => c.via === via)) {
      for (const platform of order) {
        let count: number | null = null;
        try { count = await PROBES[platform](cand.slug, f); } catch { count = null; }
        if (count !== null) return { platform, slug: cand.slug, job_count: count, via };
      }
    }
  }
  return null;
}
