// Offline regressions for interview preflight, atomic writes and registered MCP reads.
// All names, questions and URLs are synthetic; no network or real user state is used.
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "jb-interview-"));
const PRIVATE = join(TMP, ".private");
process.env.JOBBOT_PRIVATE_DIR = PRIVATE;
process.env.STATE_DIR = join(PRIVATE, "state");
mkdirSync(process.env.STATE_DIR, { recursive: true });
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("interview regression tests must not use the network"); };

let pass = 0, fail = 0;
const eq = (got, want, msg) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"} ${msg}${ok ? "" : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};
const errorCode = (got, want, msg) => eq([got.ok, got.code], [false, want], msg);
const jres = (result) => JSON.parse(result.content[0].text);
const src = (f) => new URL(`../src/${f}`, import.meta.url).href;
let DB;

try {
  const { validateInterviewRequest: validate, resolveInterviewRequest: resolve } = await import(src("interview.ts"));
  const item = { question: "Explain a synthetic queue", answer_summary: "bounded queue", score: "adequate" };
  const base = { type: "competency", items: [item] };

  // Every validation error, including numeric edge cases and completion whitespace.
  const invalid = [
    [{ ...base, type: "other" }, undefined, "invalid_type", "unknown type"],
    [{ ...base, type: "role_fit" }, undefined, "missing_job_id", "role fit needs a job"],
    [{ ...base, job_id: 77 }, false, "job_not_found", "unknown job"],
    [{ ...base, job_id: 77 }, undefined, "job_not_found", "job must explicitly exist"],
    [{ ...base, items: [] }, undefined, "missing_items", "empty items"],
    [{ ...base, items: null }, undefined, "missing_items", "non-array items"],
    [{ ...base, items: undefined }, undefined, "missing_items", "omitted items"],
    [{ ...base, done: true }, undefined, "missing_summary", "completion needs summary"],
    [{ ...base, done: true, summary: " \t\n " }, undefined, "missing_summary", "completion rejects whitespace"],
  ];
  for (const field of ["job_id", "interview_id"]) {
    for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
      invalid.push([{ ...base, [field]: value }, true, field === "job_id" ? "invalid_job_id" : "invalid_interview_id", `${field} rejects ${value}`]);
  }
  for (const [request, exists, code, label] of invalid)
    errorCode(validate(request, exists), code, `preflight: ${label}`);
  eq(validate(base), { type: "competency", job_id: null, items: [item], done: false }, "preflight: normalizes no-job competency");
  eq(validate({ ...base, type: "role_fit", job_id: 3, done: true, summary: "  synthetic summary  ", verified_ceiling: "mid" }, true),
     { type: "role_fit", job_id: 3, items: [item], done: true, summary: "synthetic summary", verified_ceiling: "mid" }, "preflight: valid role completion trims summary");
  eq(validate({ ...base, summary: "   " }).summary, undefined, "preflight: unfinished interview needs no summary");
  const normalized = validate(base);
  eq(normalized.items === base.items, false, "preflight: copies item array");
  eq(base, { type: "competency", items: [item] }, "preflight: does not mutate request");

  // Context routing never borrows another job/type or silently chooses among matches.
  const sessions = [
    { id: 9, type: "role_fit", job_id: 3, status: "in_progress" },
    { id: 5, type: "competency", job_id: null, status: "in_progress" },
    { id: 7, type: "competency", job_id: null, status: "complete" },
    { id: 4, type: "role_fit", job_id: 4, status: "in_progress" },
  ];
  const snap = { sessions, jobExists: true };
  eq([resolve(base, snap).action, resolve(base, snap).interview_id], ["resume", 5], "routing: unique competency session resumes despite newer other type");
  eq([resolve({ ...base, type: "role_fit", job_id: 3 }, snap).action, resolve({ ...base, type: "role_fit", job_id: 3 }, snap).interview_id], ["resume", 9], "routing: resumes exact job context");
  eq(resolve({ ...base, type: "role_fit", job_id: 8 }, snap).action, "start", "routing: other job opens new context");
  eq(resolve(base, { sessions: [] }).action, "start", "routing: empty snapshot starts");
  eq(resolve(base, { sessions: [sessions[2]] }).action, "start", "routing: complete session does not resume");
  errorCode(resolve({ ...base, interview_id: 999 }, snap), "interview_not_found", "routing: unknown explicit ID never falls back");
  errorCode(resolve({ ...base, interview_id: 7 }, snap), "interview_not_open", "routing: completed explicit session rejected");
  errorCode(resolve({ ...base, interview_id: 9 }, snap), "interview_context_mismatch", "routing: explicit wrong type rejected");
  errorCode(resolve({ ...base, type: "role_fit", job_id: 3, interview_id: 4 }, snap), "interview_context_mismatch", "routing: explicit wrong job rejected");
  errorCode(resolve({ ...base, job_id: 3, interview_id: 5 }, snap), "interview_context_mismatch", "routing: competency job and null contexts differ");
  const ambiguous = { sessions: [...sessions, { id: 2, type: "competency", job_id: null, status: "in_progress" }] };
  errorCode(resolve(base, ambiguous), "ambiguous_open_interviews", "routing: ambiguous context requires selection");
  eq(resolve(base, ambiguous).candidate_interview_ids, [2, 5], "routing: ambiguous candidate IDs are sorted");
  eq(resolve({ ...base, interview_id: 5 }, ambiguous).interview_id, 5, "routing: explicit ID disambiguates");
  errorCode(resolve({ ...base, done: true }, ambiguous), "missing_summary", "routing: invalid completion fails before selecting session");

  DB = await import(src("db.ts"));
  const { registerTools } = await import(src("tools.ts"));
  const handlers = new Map();
  registerTools({ registerTool(name, config, handler) { handlers.set(name, { config, handler }); } });
  const call = async (name, args) => jres(await handlers.get(name).handler(args));
  const company = DB.upsertCompany({ name: "Synthetic Interview Company", domain: "interview.example", ats_platform: "greenhouse", ats_slug: "synthetic-interview" }).id;
  DB.upsertJobs(company, [
    { source_url: "https://interview.example/jobs/1", title: "Synthetic Engineer" },
    { source_url: "https://interview.example/jobs/2", title: "Synthetic Analyst" },
  ]);
  const [job1, job2] = DB.db.prepare("SELECT id FROM jobs ORDER BY id").all().map((r) => r.id);
  const reset = () => DB.db.exec("DELETE FROM interview_items; DELETE FROM interviews; DELETE FROM events;");
  const snapshot = () => Object.fromEntries(["interviews", "interview_items", "events"].map((table) => [table, DB.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));

  // DB preflight is part of the write API, not merely a prompt/tool convention.
  for (const [request, exists, code, label] of invalid) {
    // Pure job 77 intentionally remains absent in this fixture.
    const before = snapshot();
    errorCode(DB.recordInterview(request), code, `DB preflight: ${label}`);
    eq(snapshot(), before, `DB preflight: ${label} leaves sessions/items/journal untouched`);
  }
  const started = DB.recordInterview(base);
  eq([started.ok, started.items_recorded, started.completed], [true, 1, false], "DB: starts interview with one item");
  eq(DB.getEvents().map((e) => e.kind), ["interviewed"], "DB: session start journal committed");
  const unrelated = DB.recordInterview({ ...base, type: "role_fit", job_id: job2 });
  const resumed = DB.recordInterview({ ...base, items: [{ question: "Second synthetic question" }] });
  eq(resumed.interview_id, started.interview_id, "DB: implicit resume selects matching context, not latest global interview");
  eq(DB.getInterviewItems(started.interview_id).length, 2, "DB: resume appends items");
  eq(DB.getInterviewItems(unrelated.interview_id).length, 1, "DB: resume preserves unrelated session");
  const complete = DB.recordInterview({ ...base, interview_id: started.interview_id, done: true, summary: "  synthetic completion  ", verified_ceiling: "mid" });
  eq(complete.completed, true, "DB: completes explicitly selected interview");
  eq([DB.getInterview(started.interview_id).status, DB.getInterview(started.interview_id).summary, DB.getInterview(started.interview_id).verified_ceiling],
     ["complete", "synthetic completion", "mid"], "DB: completion persists trimmed summary and ceiling");
  eq(DB.getEvents().filter((e) => e.ref === String(started.interview_id)).length, 2, "DB: completed session has start and completion journal events");
  const afterComplete = snapshot();
  errorCode(DB.recordInterview({ ...base, interview_id: started.interview_id }), "interview_not_open", "DB: cannot append to closed session");
  eq(snapshot(), afterComplete, "DB: closed-session request writes nothing");
  const duplicate = DB.startInterview("role_fit", job2);
  const beforeAmbiguous = snapshot();
  errorCode(DB.recordInterview({ ...base, type: "role_fit", job_id: job2 }), "ambiguous_open_interviews", "DB: ambiguity is a read-only failure");
  eq(snapshot(), beforeAmbiguous, "DB: ambiguous write preserves all state");
  eq(DB.recordInterview({ ...base, type: "role_fit", job_id: job2, interview_id: duplicate }).interview_id, duplicate, "DB: explicit selection resolves duplicate open context");

  // SQLite triggers inject real database failures at each composite-write boundary.
  // Complete snapshots prove session/items/events roll back together and other data survives.
  const faults = [
    ["start", "BEFORE INSERT ON interviews", "1", false],
    ["start journal", "BEFORE INSERT ON events", "NEW.kind = 'interviewed' AND NEW.summary LIKE 'started %'", false],
    ["second item", "BEFORE INSERT ON interview_items", "NEW.question = 'fault-item'", false],
    ["completion", "BEFORE UPDATE ON interviews", "NEW.status = 'complete'", false],
    ["completion journal", "BEFORE INSERT ON events", "NEW.kind = 'interviewed' AND NEW.summary LIKE 'completed interview %'", false],
    ["resumed second item", "BEFORE INSERT ON interview_items", "NEW.question = 'fault-item'", true],
    ["resumed completion", "BEFORE UPDATE ON interviews", "NEW.status = 'complete'", true],
    ["resumed completion journal", "BEFORE INSERT ON events", "NEW.kind = 'interviewed' AND NEW.summary LIKE 'completed interview %'", true],
  ];
  for (const [label, boundary, condition, resume] of faults) {
    reset();
    DB.recordInterview({ ...base, type: "role_fit", job_id: job2 });
    const open = resume ? DB.recordInterview(base).interview_id : undefined;
    const before = snapshot();
    DB.db.exec(`CREATE TEMP TRIGGER synthetic_interview_fault ${boundary} WHEN ${condition} BEGIN SELECT RAISE(ABORT, 'synthetic interview fault'); END;`);
    let message;
    try {
      DB.recordInterview({ ...base, ...(open ? { interview_id: open } : {}), items: [item, { question: "fault-item" }], done: true, summary: "Synthetic fault rollback" });
    } catch (error) { message = error.message; }
    finally { DB.db.exec("DROP TRIGGER synthetic_interview_fault"); }
    eq(message?.includes("synthetic interview fault"), true, `atomicity: ${label} exposes injected error`);
    eq(snapshot(), before, `atomicity: ${label} rolls back every interview/item/journal change`);
    eq(DB.recordInterview({ ...base, ...(open ? { interview_id: open } : {}) }).ok, true, `atomicity: connection usable after ${label} rollback`);
  }

  // Invoke the actual registered look handler against persisted sessions.
  reset();
  const noSessions = await call("look", { at: "interview" });
  eq(noSessions.all_sessions, [], "look: empty interview catalog has explicit empty session list");
  eq(noSessions.interview, undefined, "look: empty catalog has no invented interview");
  const competency = DB.recordInterview(base).interview_id;
  const role1 = DB.recordInterview({ ...base, type: "role_fit", job_id: job1 }).interview_id;
  DB.recordInterview({ ...base, type: "role_fit", job_id: job1, interview_id: role1, done: true, summary: "Synthetic role complete" });
  const role2 = DB.recordInterview({ ...base, type: "role_fit", job_id: job2 }).interview_id;
  const beforeReads = snapshot();
  eq((await call("look", { at: "interview" })).interview.id, role2, "look: unscoped read selects latest open session");
  const exact = await call("look", { at: "interview", interview_id: competency });
  eq(exact.interview.id, competency, "look: explicit ID selects older competency session");
  eq(exact.items.map((x) => x.question), [item.question], "look: explicit ID returns only its own items");
  eq(exact.all_sessions.map((x) => x.id), [role2, role1, competency], "look: session selection includes every available session");
  const absent = await call("look", { at: "interview", interview_id: 999999 });
  eq(absent.interview, undefined, "look: missing explicit ID never falls back to open session");
  eq(absent.note.includes("999999"), true, "look: missing explicit ID explains exact missing session");
  eq(absent.all_sessions.length, 3, "look: missing explicit ID offers selection list");
  eq((await call("look", { at: "interview", job_id: job1 })).interview.id, role1, "look: job scope falls back to its latest completed session");
  eq((await call("look", { at: "interview", job_id: job2 })).interview.id, role2, "look: job scope selects matching open session");
  eq((await call("look", { at: "interview", job_id: job1, interview_id: role1 })).interview.id, role1, "look: matching explicit job/session reads completed session");
  const wrongJob = await call("look", { at: "interview", job_id: job1, interview_id: role2 });
  eq([wrongJob.ok, wrongJob.interview], [false, undefined], "look: explicit job/session mismatch rejects without fallback");
  eq(wrongJob.all_sessions.length, 3, "look: mismatched context retains selection list");
  const nullJob = await call("look", { at: "interview", job_id: job1, interview_id: competency });
  eq(nullJob.ok, false, "look: no-job competency session cannot satisfy job scope");
  const missingJob = await call("look", { at: "interview", job_id: 999999 });
  eq([missingJob.interview, missingJob.all_sessions.length], [undefined, 3], "look: empty job scope never borrows another session");
  eq(snapshot(), beforeReads, "look: all registered read paths leave sessions/items/journal unchanged");
  const newerCompleted = DB.startInterview("role_fit", job2);
  DB.completeInterview(newerCompleted, "mid", "Synthetic newer completed session");
  eq((await call("look", { at: "interview", job_id: job2 })).interview.id, role2, "look: scoped open session wins over newer completed session");

  // Exercise registered write dispatch and schemas rather than bypassing its DB path.
  const writeBefore = snapshot();
  const rejected = await call("record_interview", { ...base, done: true, summary: " " });
  errorCode(rejected, "missing_summary", "tool: record_interview returns preflight error");
  eq(snapshot(), writeBefore, "tool: rejected completion writes nothing");
  const wrote = await call("record_interview", { ...base, interview_id: competency });
  eq([wrote.ok, wrote.interview_id, wrote.items_recorded], [true, competency, 1], "tool: record_interview dispatches exact resume through DB");
  const schema = handlers.get("record_interview").config.inputSchema;
  eq(schema.interview_id.safeParse(0).success, false, "tool schema: zero explicit ID rejected");
  eq(schema.job_id.safeParse(Number.MAX_SAFE_INTEGER + 1).success, false, "tool schema: unsafe job ID rejected");
  eq(schema.items.safeParse([]).success, false, "tool schema: empty item batch rejected");
  eq(schema.verified_ceiling.safeParse("senior").success, true, "tool schema: ladder ceiling accepted");
  eq(schema.verified_ceiling.safeParse("expert").success, false, "tool schema: unknown ceiling rejected");
} finally {
  try { DB?.db.close(); } finally {
    globalThis.fetch = originalFetch;
    rmSync(TMP, { recursive: true, force: true });
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
