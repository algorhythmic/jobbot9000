// Pure preflight and session routing for record_interview. The caller supplies a
// snapshot of persisted sessions and job existence, then performs any DB writes.

export type InterviewType = "competency" | "role_fit";

// The mode-backed tool schema validates the judgment vocabularies before calling
// this helper. Keep those vocabularies in the mode rather than duplicating them.
export interface InterviewItemInput {
  dimension?: string | null;
  claim?: string | null;
  question: string;
  answer_summary?: string | null;
  exemplar?: string | null;
  score?: string | null;
  ownership?: string | null;
  understanding?: string | null;
  delta_notes?: string | null;
}

export interface InterviewRequest {
  // enumOf() in tools.ts returns string at the TypeScript boundary.
  type: string;
  job_id?: number;
  interview_id?: number;
  items: readonly InterviewItemInput[];
  verified_ceiling?: string;
  summary?: string;
  done?: boolean;
}

export interface InterviewSession {
  id: number;
  type: string;
  job_id: number | null;
  status: string;
}

export interface InterviewSnapshot {
  sessions: readonly InterviewSession[];
  // When job_id is provided, this is the caller's read of that exact job.
  jobExists?: boolean;
}

export type InterviewErrorCode =
  | "invalid_type"
  | "invalid_job_id"
  | "missing_job_id"
  | "job_not_found"
  | "invalid_interview_id"
  | "missing_items"
  | "missing_summary"
  | "interview_not_found"
  | "interview_not_open"
  | "interview_context_mismatch"
  | "ambiguous_open_interviews";

export interface InterviewError {
  ok: false;
  code: InterviewErrorCode;
  error: string;
  candidate_interview_ids?: number[];
}

export interface NormalizedInterviewRequest {
  type: InterviewType;
  job_id: number | null;
  interview_id?: number;
  items: InterviewItemInput[];
  done: boolean;
  summary?: string;
  verified_ceiling?: string;
}

export interface InterviewChoice extends NormalizedInterviewRequest {
  ok: true;
  action: "start" | "resume";
}

export type InterviewResolution = InterviewChoice | InterviewError;

const error = (code: InterviewErrorCode, message: string): InterviewError =>
  ({ ok: false, code, error: message });

const positiveId = (value: number): boolean => Number.isSafeInteger(value) && value > 0;

/** Validate everything that can fail before startInterview/addInterviewItems. */
export function validateInterviewRequest(
  request: InterviewRequest,
  jobExists?: boolean,
): NormalizedInterviewRequest | InterviewError {
  if (request.type !== "competency" && request.type !== "role_fit")
    return error("invalid_type", "interview type must be competency or role_fit.");

  if (request.job_id !== undefined && !positiveId(request.job_id))
    return error("invalid_job_id", "job_id must be a positive integer.");
  if (request.type === "role_fit" && request.job_id === undefined)
    return error("missing_job_id", "role_fit interviews need a job_id.");
  if (request.job_id !== undefined && jobExists !== true)
    return error("job_not_found", `no job ${request.job_id} — find a valid job_id via look({ at: 'jobs' }).`);

  if (request.interview_id !== undefined && !positiveId(request.interview_id))
    return error("invalid_interview_id", "interview_id must be a positive integer.");
  if (!Array.isArray(request.items) || request.items.length === 0)
    return error("missing_items", "record_interview needs at least one interview item.");

  const done = request.done === true;
  const summary = request.summary?.trim();
  if (done && !summary)
    return error("missing_summary", "completing an interview (done:true) needs a nonempty summary — the honest read after questioning.");

  return {
    type: request.type,
    job_id: request.job_id ?? null,
    ...(request.interview_id !== undefined ? { interview_id: request.interview_id } : {}),
    items: [...request.items],
    done,
    ...(summary ? { summary } : {}),
    ...(request.verified_ceiling !== undefined ? { verified_ceiling: request.verified_ceiling } : {}),
  };
}

/** Resolve an explicit session, or uniquely resume the open session in this context. */
export function resolveInterviewRequest(
  request: InterviewRequest,
  snapshot: InterviewSnapshot,
): InterviewResolution {
  const normalized = validateInterviewRequest(request, snapshot.jobExists);
  if ("ok" in normalized) return normalized;

  const matchesContext = (session: InterviewSession): boolean =>
    session.type === normalized.type && session.job_id === normalized.job_id;

  if (normalized.interview_id !== undefined) {
    const session = snapshot.sessions.find((candidate) => candidate.id === normalized.interview_id);
    if (!session) return error("interview_not_found", `no interview ${normalized.interview_id}.`);
    if (session.status !== "in_progress")
      return error("interview_not_open", `interview ${normalized.interview_id} is ${session.status}; only in_progress interviews can be resumed.`);
    if (!matchesContext(session))
      return error("interview_context_mismatch", `interview ${normalized.interview_id} belongs to ${session.type}${session.job_id === null ? "" : ` for job ${session.job_id}`}; requested ${normalized.type}${normalized.job_id === null ? "" : ` for job ${normalized.job_id}`}.`);
    return { ok: true, action: "resume", ...normalized };
  }

  const open = snapshot.sessions.filter((session) =>
    session.status === "in_progress" && matchesContext(session));
  if (open.length > 1) {
    const ids = open.map((session) => session.id).sort((a, b) => a - b);
    return {
      ...error("ambiguous_open_interviews", `multiple open ${normalized.type} interviews match this context (${ids.join(", ")}); pass interview_id to choose one.`),
      candidate_interview_ids: ids,
    };
  }
  if (open.length === 1)
    return { ok: true, action: "resume", ...normalized, interview_id: open[0].id };
  return { ok: true, action: "start", ...normalized };
}
