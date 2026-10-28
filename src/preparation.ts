// Offline recipe compiler. Source strings are inert data; no model or transport.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { assertPeopleSourceUrl, validatePersonFinding } from "./people-sources.js";
import type { DraftRecipe, PreparedDraft } from "./preparation-types.js";

const denied = (): never => { throw new Error("draft preparation denied by evidence, honesty or suppression policy"); };
const mode = (name: string) => JSON.parse(readFileSync(new URL(`../modes/${name}.json`, import.meta.url), "utf8")).constraints;
const interview = mode("interview"), roleFit = mode("role_fit"), letter = mode("cover_letter");
const levels: string[] = interview.verified_ceiling_must_be_one_of;
if (!Array.isArray(levels) || letter.content_required !== true || letter.no_invented_experience !== true) throw new Error("draft mode contract unavailable");
const text = z.string().min(1).max(100_000).refine((value) => value.trim().length > 0 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value));
const line = text.refine((value) => !/[\r\n]/.test(value));
const time = z.number().int().nonnegative().safe();
const level = z.string().refine((value) => levels.includes(value));
const recipeSchema = z.object({
  profile: z.object({ name: line, verifiedFloor: level,
    claims: z.array(z.object({ id: line, text, level, verified: z.boolean() }).strict()).min(1).max(100),
    interview: z.object({ status: z.literal("complete"), verifiedCeiling: level, summary: text, verifiedClaimIds: z.array(line).min(1).max(100) }).strict(),
  }).strict(),
  evidence: z.object({ approved: z.literal(true), companyId: line, roleId: line, companyName: line, roleTitle: line,
    sourceUrl: line, description: text, fetchedAt: time, expiresAt: time,
    terms: z.object({ allowed: z.literal(true), reference: line, checkedAt: time, expiresAt: time }).strict(),
    roleFit: z.object({ band: z.string().refine((value) => roleFit.band_must_be_one_of.includes(value)), desireAlignment: z.string().refine((value) => roleFit.desire_alignment_must_be_one_of.includes(value)), rationale: text }).strict(),
  }).strict(),
  channel: z.enum(["email", "manual_application"]), contact: z.unknown().optional(), contactApproved: z.literal(true).optional(),
  destination: line, claimIds: z.array(line).min(1).max(100), requestedLevel: level, requiredFields: z.array(line).max(100),
}).strict();

export interface PreparationPolicy { now: number; isSuppressed: (contactId: string, destination: string) => boolean }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const fresh = (start: number, end: number, now: number) => start <= now && start < end && end > now;
/** Contact evidence must be refreshed within 24 hours of preparing proposed outreach. */
export const PREPARATION_CONTACT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
function compile(input: DraftRecipe, policy: PreparationPolicy): PreparedDraft {
  if (!policy || !Number.isSafeInteger(policy.now) || policy.now < 0 || typeof policy.isSuppressed !== "function") return denied();
  const checked = recipeSchema.safeParse(input);
  if (!checked.success) return denied();
  // Omit optional undefined fields so output remains canonical JSON data.
  const recipe = JSON.parse(JSON.stringify(checked.data)) as DraftRecipe;
  const { profile, evidence, destination } = recipe;
  const ceiling = levels.indexOf(profile.interview.verifiedCeiling), floor = levels.indexOf(profile.verifiedFloor);
  const requested = levels.indexOf(recipe.requestedLevel);
  if (floor > ceiling || requested > floor || requested > ceiling ||
      !fresh(evidence.fetchedAt, evidence.expiresAt, policy.now) ||
      !fresh(evidence.terms.checkedAt, evidence.terms.expiresAt, policy.now)) return denied();
  assertPeopleSourceUrl(evidence.sourceUrl); assertPeopleSourceUrl(evidence.terms.reference);
  const ids = profile.claims.map((claim) => claim.id);
  if (new Set(ids).size !== ids.length || new Set(recipe.claimIds).size !== recipe.claimIds.length ||
      new Set(profile.interview.verifiedClaimIds).size !== profile.interview.verifiedClaimIds.length ||
      profile.interview.verifiedClaimIds.some((id) => !ids.includes(id))) return denied();
  const claims = recipe.claimIds.map((id) => {
    const claim = profile.claims.find((value) => value.id === id);
    if (!claim || !claim.verified || !profile.interview.verifiedClaimIds.includes(id) || levels.indexOf(claim.level) > floor || levels.indexOf(claim.level) > ceiling) return denied();
    return claim;
  });
  let contactId = "";
  if (recipe.channel === "email") {
    if (!recipe.contact || recipe.contactApproved !== true) return denied();
    validatePersonFinding(recipe.contact);
    const contact = recipe.contact;
    contactId = contact.id;
    if (contact.companyId !== evidence.companyId || contact.match !== "source_reported" ||
        !fresh(contact.provenance.fetchedAt, contact.provenance.expiresAt, policy.now) ||
        policy.now - contact.provenance.fetchedAt > PREPARATION_CONTACT_MAX_AGE_MS ||
        !contact.channels.some((channel) => channel.kind === "email" && channel.value === destination)) return denied();
  } else {
    if (recipe.contact || recipe.contactApproved !== undefined) return denied();
    if (assertPeopleSourceUrl(destination).href !== assertPeopleSourceUrl(evidence.sourceUrl).href) return denied();
  }
  if (policy.isSuppressed(contactId, destination) !== false) return denied();
  const companyRoleKey = hash([evidence.companyId, evidence.roleId]);
  const subject = `Application: ${evidence.roleTitle} — ${profile.name}`;
  const body = [
    `I am interested in the ${evidence.roleTitle} role at ${evidence.companyName}.`,
    `My verified level is ${recipe.requestedLevel}.`,
    ...claims.map((claim) => claim.text),
    `Thank you,\n${profile.name}`,
  ].join("\n\n");
  const supported: Record<string, string> = { name: profile.name, cover_letter: body };
  const formFields: Record<string, string> = {};
  const manualCompletion: string[] = [];
  for (const field of [...new Set(recipe.requiredFields)].sort()) {
    if (Object.hasOwn(supported, field)) Object.defineProperty(formFields, field, { value: supported[field], enumerable: true, writable: true, configurable: true });
    else manualCompletion.push(field);
  }
  return { id: hash(recipe), companyRoleKey, channel: recipe.channel, destination, subject, body, formFields, manualCompletion, recipe };
}
/** Pure, deterministic, bounded dry-run; each company/role recipe has independent state. */
export function prepareDrafts(recipes: DraftRecipe[], policy: PreparationPolicy): PreparedDraft[] {
  if (!Array.isArray(recipes) || recipes.length < 1 || recipes.length > 25) return denied();
  const drafts = recipes.map((recipe) => compile(recipe, policy));
  const keys = new Set<string>(), destinations = new Set<string>(), contacts = new Set<string>();
  for (const draft of drafts) {
    const address = draft.destination.toLowerCase(), contact = draft.recipe.contact?.id;
    if (keys.has(draft.companyRoleKey) || destinations.has(address) || (contact && contacts.has(contact))) return denied();
    keys.add(draft.companyRoleKey); destinations.add(address); if (contact) contacts.add(contact);
  }
  return drafts;
}
/** Queue ingress must recompile, recheck freshness/suppression and reject arbitrary caller text. */
export function validatePreparedDraft(draft: PreparedDraft, policy: PreparationPolicy): void {
  try {
    if (!draft || canonical(draft) !== canonical(compile(draft.recipe, policy))) return denied();
  } catch { return denied(); }
}
