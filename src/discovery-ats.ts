// Offline bridge only: the caller supplies synthetic replies. The discovery loop
// performs every read through its policy, budget, retry and cancellation gates.
import { normalizeAtsBoard, type AtsPlatform } from "./ats.js";
import type { Candidate, FixtureAdapter, Phase, Reply } from "./discovery.js";

const BOARDS: [AtsPlatform, string, RegExp][] = [
  ["greenhouse", "boards-api.greenhouse.io", /^\/v1\/boards\/[a-zA-Z0-9_-]+\/jobs$/],
  ["lever", "api.lever.co", /^\/v0\/postings\/[a-zA-Z0-9_-]+$/],
  ["ashby", "api.ashbyhq.com", /^\/posting-api\/job-board\/[a-zA-Z0-9_-]+$/],
  ["workable", "apply.workable.com", /^\/api\/v1\/widget\/accounts\/[a-zA-Z0-9_-]+$/],
];

function platformFor(raw: string): AtsPlatform | undefined {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) return;
  return BOARDS.find(([, host, path]) => url.hostname === host && path.test(url.pathname))?.[0];
}
const object = (body: unknown): Record<string, unknown> => {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid fixture page");
  return body as Record<string, unknown>;
};

/**
 * Constructor contract: leadUrl points at a synthetic page; read returns only
 * caller-owned synthetic replies and is never installed by default. Lead bodies
 * are {companies: Candidate[], next?: absoluteUrl}; career bodies are {boardUrl}.
 * A manually supplied company.boardUrl is an explicit pinned API endpoint.
 * Board bodies retain each official ATS JSON shape. This is not an HTML crawler,
 * live adapter, slug prober, credentials reader or executor.
 */
export function atsFixtureAdapter(options: {
  leadUrl: string;
  read: (url: string, signal: AbortSignal) => Promise<Reply>;
}): FixtureAdapter {
  return {
    fixtureOnly: true,
    url(phase: Phase, company?: Candidate, cursor?: string) {
      if (phase === "discover") return cursor ?? options.leadUrl;
      if (!company) throw new Error("company required");
      if (phase === "resolve") return new URL("/careers", `https://${company.domain}`).href;
      if (!company.boardUrl || !platformFor(company.boardUrl)) throw new Error("unsupported pinned ATS board endpoint");
      return company.boardUrl;
    },
    async read(url, signal) {
      const reply = await options.read(url, signal);
      const platform = platformFor(url);
      return platform ? { ...reply, body: { platform, payload: reply.body } } : reply;
    },
    companies(body) {
      const page = object(body);
      if (!Array.isArray(page.companies) || (page.next !== undefined && typeof page.next !== "string")) throw new Error("invalid company fixture page");
      const items = page.companies.map((raw): Candidate => {
        const item = object(raw);
        if (typeof item.name !== "string" || typeof item.domain !== "string" || (item.boardUrl !== undefined && typeof item.boardUrl !== "string")) throw new Error("invalid fixture company");
        return { name: item.name, domain: item.domain, ...(item.boardUrl ? { boardUrl: item.boardUrl as string } : {}) };
      });
      return { items, ...(page.next ? { next: page.next as string } : {}) };
    },
    resolved(body, company) {
      const page = object(body);
      const boardUrl = company.boardUrl ?? page.boardUrl;
      if (typeof boardUrl !== "string" || !platformFor(boardUrl)) throw new Error("unsupported pinned ATS board endpoint");
      return { ...company, boardUrl };
    },
    jobs(body) {
      const page = object(body);
      if (!BOARDS.some(([platform]) => page.platform === platform)) throw new Error("invalid ATS fixture envelope");
      const postings = normalizeAtsBoard(page.platform as AtsPlatform, page.payload);
      if (postings === null) throw new Error("malformed ATS fixture board");
      return { items: postings.filter((job) => job.title !== null).map((job) => ({ url: job.source_url, title: job.title! })) };
    },
  };
}
