// Offline, declarative publication connectors. Strings are data, never instructions.
// No transport, executor, email probe, browser, login or CAPTCHA capability exists here.
import { createHash } from "node:crypto";
import type { PeopleSourceKind, PersonFinding, ProfessionalRole, PublishedChannel } from "./people-types.js";

export const PEOPLE_DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const deny = (): never => { throw new Error("people publication denied by source policy"); };
const kinds = new Set<PeopleSourceKind>(["job_post", "official_team", "official_api"]);
const social = ["linkedin.com", "linkedin.cn", "lnkd.in", "facebook.com", "instagram.com", "twitter.com", "x.com", "tiktok.com", "reddit.com"];
const forbiddenPath = /(?:^|[^a-z])(login|log-in|signin|sign-in|signup|sign-up|captcha|personal|social|bought|purchased|credentials|oauth|password|private)(?:[^a-z]|$)/i;
function decoded(raw: string): string {
  let result = raw;
  for (let n = 0; n < 4; n++) {
    let next: string;
    try { next = decodeURIComponent(result); } catch { return deny(); }
    if (next === result) return result;
    result = next;
  }
  if (/%[0-9a-f]{2}/i.test(result)) return deny();
  return result;
}

/** Validate a public professional publication address without fetching it. */
export function assertPeopleSourceUrl(raw: string): URL {
  if (typeof raw !== "string" || raw.length > 2048 || /[\x00-\x20\x7f\\]/.test(raw)) return deny();
  // Decode before parsing so encoded authority/path tricks cannot hide denied sites.
  let url: URL;
  try { url = new URL(decoded(raw)); } catch { return deny(); }
  const host = url.hostname.toLowerCase().replace(/\.+$/, "");
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash ||
      !host.includes(".") || host.startsWith("[") || /^[\d.]+$/.test(host) ||
      /(?:^|\.)(localhost|local|internal|lan|home|invalid)$/.test(host) ||
      social.some((site) => host === site || host.endsWith(`.${site}`)) ||
      forbiddenPath.test(`${url.pathname} ${url.search}`)) return deny();
  url.hostname = host;
  return url;
}

/** Only for explicitly operator-supplied inert references; never a read target. */
export function assertPeopleReferenceUrl(raw: string): URL {
  if (typeof raw !== "string" || /[\x00-\x20\x7f\\]/.test(raw)) return deny();
  let url: URL;
  try { url = new URL(decoded(raw)); } catch { return deny(); }
  const host = url.hostname.toLowerCase().replace(/\.+$/, "");
  if (url.protocol === "https:" && !url.username && !url.password && !url.port && !url.search && !url.hash &&
      (host === "linkedin.com" || host.endsWith(".linkedin.com")) && /^\/in\/[a-zA-Z0-9_-]+\/?$/.test(url.pathname)) {
    url.hostname = host;
    return url;
  }
  return assertPeopleSourceUrl(raw);
}

export interface PeoplePublication {
  companyId: string;
  sourceUrl: string;
  sourceKind: PeopleSourceKind;
  public: true;
  professional: true;
  fetchedAt?: number;
  text: string;
  contacts: Array<{
    name: string;
    role: ProfessionalRole;
    roleEvidence: string;
    match?: "source_reported" | "ambiguous";
    channels: PublishedChannel[];
    references?: string[];
  }>;
}

const shortText = (value: unknown, max = 2000): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);

/**
 * Normalize an explicitly supplied public job post, official team publication or
 * official API publication. Caller claims are validated as data; no text is run.
 * Ambiguous source-reported associations remain ambiguous for private review.
 */
export function parsePeoplePublication(publication: PeoplePublication, options: { now: number; ttlMs?: number }): PersonFinding[] {
  const ttl = options.ttlMs ?? PEOPLE_DEFAULT_TTL_MS;
  if (!Number.isSafeInteger(options.now) || options.now < 0 || !Number.isSafeInteger(ttl) || ttl <= 0 ||
      !publication || publication.public !== true || publication.professional !== true ||
      !kinds.has(publication.sourceKind) || !shortText(publication.companyId, 256) ||
      typeof publication.text !== "string" || publication.text.length > 1_000_000 ||
      !Array.isArray(publication.contacts) || publication.contacts.length > 1000) return deny();
  const source = assertPeopleSourceUrl(publication.sourceUrl).href;
  const fetchedAt = publication.fetchedAt ?? options.now;
  if (!Number.isSafeInteger(fetchedAt) || fetchedAt < 0 || fetchedAt > options.now || !Number.isSafeInteger(fetchedAt + ttl)) return deny();
  return publication.contacts.map((contact): PersonFinding => {
    if (!contact || !shortText(contact.name, 256) || !publication.text.includes(contact.name) ||
        !["recruiter", "hiring_manager"].includes(contact.role) ||
        !shortText(contact.roleEvidence) || !publication.text.includes(contact.roleEvidence) ||
        !contact.roleEvidence.includes(contact.name) ||
        (contact.match !== undefined && !["source_reported", "ambiguous"].includes(contact.match)) ||
        !Array.isArray(contact.channels) || contact.channels.length > 20 ||
        (contact.references !== undefined && (!Array.isArray(contact.references) || contact.references.length > 20))) return deny();
    // The role is a source assertion, never an inference based on a person's title.
    const roleText = contact.roleEvidence.toLowerCase();
    if (contact.role === "recruiter" ? !/\brecruit(?:er|ing)\b/.test(roleText) : !/\bhiring[ _-]manager\b/.test(roleText)) return deny();
    const channels = contact.channels.map((channel): PublishedChannel => {
      if (!channel || !["email", "professional_url"].includes(channel.kind) ||
          !shortText(channel.value, 2048) || !shortText(channel.evidence) ||
          !publication.text.includes(channel.evidence) || !channel.evidence.includes(channel.value) ||
          !channel.evidence.includes(contact.name) ||
          /\b(personal|private|guessed|inferred|purchased|bought)\b/i.test(channel.evidence)) return deny();
      if (channel.kind === "email") {
        if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(channel.value)) return deny();
        const publishedEmails: string[] = channel.evidence.match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}/gi) ?? [];
        if (!publishedEmails.includes(channel.value)) return deny();
        // Contact must be explicitly professional, not a personal mailbox/list.
        if (!/\b(professional|recruiting|recruiter|hiring|work|business)\b/i.test(channel.evidence)) return deny();
      } else {
        assertPeopleSourceUrl(channel.value);
        const publishedUrls = channel.evidence.match(/https:\/\/[^\s<>"'()]+/gi) ?? [];
        if (!publishedUrls.some((value) => value.replace(/[.,;!]+$/, "") === channel.value)) return deny();
        if (!/\b(professional|recruiting|recruiter|hiring|work|business)\b/i.test(channel.evidence)) return deny();
      }
      return { kind: channel.kind, value: channel.value, evidence: channel.evidence };
    });
    // Scraped references obey the same denylist. Operator-only references are
    // added separately by the collector, and never become transport targets.
    const references = (contact.references ?? []).map((raw) => assertPeopleSourceUrl(raw).href);
    const excerpt = [...new Set([contact.roleEvidence, ...channels.map((channel) => channel.evidence)])].join("\n");
    if (excerpt.length > 2000) return deny();
    // Stable across a source-page change, so suppression cannot be bypassed by
    // finding the same named professional on a second publication.
    const id = createHash("sha256").update(JSON.stringify([publication.companyId, contact.name.trim().toLowerCase()])).digest("hex");
    return {
      id, companyId: publication.companyId, name: contact.name, role: contact.role,
      roleEvidence: contact.roleEvidence, match: contact.match ?? "source_reported",
      channels, references,
      provenance: { sourceUrl: source, sourceKind: publication.sourceKind, fetchedAt, expiresAt: fetchedAt + ttl, excerpt },
    };
  });
}

function exactKeys(value: unknown, expected: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === expected.length && Object.keys(value).every((key) => expected.includes(key));
}

/** Recheck untrusted records at every private-store ingress, including reloads. */
export function validatePersonFinding(value: unknown): asserts value is PersonFinding {
  if (!exactKeys(value, ["id", "companyId", "name", "role", "roleEvidence", "match", "channels", "references", "provenance"]) ||
      !exactKeys(value.provenance, ["sourceUrl", "sourceKind", "fetchedAt", "expiresAt", "excerpt"]) ||
      !Array.isArray(value.channels) || !value.channels.every((channel) => exactKeys(channel, ["kind", "value", "evidence"])) ||
      !Array.isArray(value.references) || value.references.length > 20 ||
      !shortText(value.provenance.excerpt) || typeof value.provenance.fetchedAt !== "number" || typeof value.provenance.expiresAt !== "number") return deny();
  const person = value as unknown as PersonFinding;
  const rebuilt = parsePeoplePublication({
    companyId: person.companyId, sourceUrl: person.provenance.sourceUrl,
    sourceKind: person.provenance.sourceKind, public: true, professional: true,
    fetchedAt: person.provenance.fetchedAt, text: person.provenance.excerpt,
    contacts: [{ name: person.name, role: person.role, roleEvidence: person.roleEvidence, match: person.match, channels: person.channels }],
  }, { now: person.provenance.fetchedAt, ttlMs: person.provenance.expiresAt - person.provenance.fetchedAt })[0];
  if (person.id !== rebuilt.id || person.provenance.sourceUrl !== rebuilt.provenance.sourceUrl) return deny();
  person.references.forEach((reference) => assertPeopleReferenceUrl(reference));
}
