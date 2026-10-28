import type { PersonFinding } from "./people-types.js";
export interface DraftProfile {
  name: string;
  verifiedFloor: string;
  claims: { id: string; text: string; level: string; verified: boolean }[];
  interview: { status: "complete"; verifiedCeiling: string; summary: string; verifiedClaimIds: string[] };
}
export interface DraftEvidence {
  approved: true;
  companyId: string;
  roleId: string;
  companyName: string;
  roleTitle: string;
  sourceUrl: string;
  description: string;
  fetchedAt: number;
  expiresAt: number;
  terms: { allowed: true; reference: string; checkedAt: number; expiresAt: number };
  roleFit: { band: string; desireAlignment: string; rationale: string };
}
export interface DraftRecipe {
  profile: DraftProfile;
  evidence: DraftEvidence;
  channel: "email" | "manual_application";
  contact?: PersonFinding;
  contactApproved?: true;
  destination: string;
  claimIds: string[];
  requestedLevel: string;
  requiredFields: string[];
}
export interface PreparedDraft {
  id: string;
  companyRoleKey: string;
  channel: "email" | "manual_application";
  destination: string;
  subject: string;
  body: string;
  formFields: Record<string, string>;
  manualCompletion: string[];
  recipe: DraftRecipe;
}
export interface QueueAttachmentInput { id: string; name: string; bytes: Uint8Array }
