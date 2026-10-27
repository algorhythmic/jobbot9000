// Stage b contracts: collection for private review only; no transport/executor.
export type PeopleSourceKind = "job_post" | "official_team" | "official_api";
export type ProfessionalRole = "recruiter" | "hiring_manager";
export interface PublishedChannel {
  kind: "email" | "professional_url";
  value: string;
  evidence: string;
}
export interface PersonFinding {
  id: string;
  companyId: string;
  name: string;
  role: ProfessionalRole;
  roleEvidence: string;
  match: "source_reported" | "ambiguous";
  channels: PublishedChannel[];
  references: string[]; // Operator-provided LinkedIn links are references only.
  provenance: {
    sourceUrl: string;
    sourceKind: PeopleSourceKind;
    fetchedAt: number;
    expiresAt: number;
    excerpt: string;
  };
}
export interface PeopleReviewItem { person: PersonFinding; stale: boolean; needsReview: true }
export interface PeopleStore {
  collect(person: PersonFinding): boolean;
  review(now: number): PeopleReviewItem[];
  suppress(id: string): void;
  delete(id: string): void;
  purgeExpired(now: number): number;
}
