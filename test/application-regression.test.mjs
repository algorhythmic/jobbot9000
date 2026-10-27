// Application metadata/journal regressions. All data is synthetic; no network or
// real candidate state is accessed. Run: tsx test/application-regression.test.mjs
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixtureRoot = mkdtempSync(join(tmpdir(), "jobbot-application-regression-"));
const privateRoot = join(fixtureRoot, ".private");
const stateDir = join(privateRoot, "state");
mkdirSync(stateDir, { recursive: true });
const previousStateDir = process.env.STATE_DIR;
const previousPrivateDir = process.env.JOBBOT_PRIVATE_DIR;
process.env.STATE_DIR = stateDir;
process.env.JOBBOT_PRIVATE_DIR = privateRoot;
const DB = await import("../src/db.ts");

after(() => {
  DB.db.close();
  if (previousStateDir === undefined) delete process.env.STATE_DIR;
  else process.env.STATE_DIR = previousStateDir;
  if (previousPrivateDir === undefined) delete process.env.JOBBOT_PRIVATE_DIR;
  else process.env.JOBBOT_PRIVATE_DIR = previousPrivateDir;
  rmSync(fixtureRoot, { recursive: true, force: true });
});

const companyId = DB.upsertCompany({ name: "Synthetic Example Company", domain: "example.invalid" }).id;
let fixtureSequence = 0;
function newJob() {
  const url = `https://example.invalid/jobs/synthetic-${++fixtureSequence}`;
  DB.upsertJobs(companyId, [{ source_url: url, title: "Synthetic test role" }]);
  return DB.db.prepare("SELECT id FROM jobs WHERE source_url=?").get(url).id;
}
const events = (id) => DB.db.prepare("SELECT * FROM events WHERE ref=? ORDER BY id").all(String(id));
const countRows = () => DB.db.prepare("SELECT count(*) AS n FROM applications").get().n;
const changes = (event) => JSON.parse(event.summary.slice(event.summary.indexOf("; changes ") + 10));
const originalMetadata = {
  applied_at: "2026-01-02T03:04:05Z",
  next_action: "Review synthetic packet",
  next_action_at: "2026-01-03T03:04:05Z",
  notes: "  Synthetic note\nwith deliberate spacing.  ",
};
const metadataFields = ["applied_at", "next_action", "next_action_at", "notes"];

test("initial application reports every changed field and journals exact synthetic values", () => {
  const id = newJob();
  const before = countRows();
  assert.deepEqual(DB.recordApplication(id, { status: "interested", ...originalMetadata }), {
    changed: true, transitioned: true, changed_fields: ["status", ...metadataFields],
  });
  assert.equal(countRows(), before + 1);
  const row = DB.getApplication(id);
  for (const field of metadataFields) assert.equal(row[field], originalMetadata[field]);
  const journal = events(id);
  assert.equal(journal.length, 1);
  assert.equal(journal[0].kind, "applied");
  assert.equal(journal[0].ref, String(id));
  assert.deepEqual(changes(journal[0]), Object.fromEntries(
    Object.entries({ status: "interested", ...originalMetadata }).map(([key, value]) => [key, { from: null, to: value }]),
  ));
});

test("omitted metadata preserves stored values while a supplied field changes", () => {
  const id = newJob();
  DB.recordApplication(id, { status: "interested", ...originalMetadata });
  assert.deepEqual(DB.recordApplication(id, { status: "interested", notes: "New synthetic note" }), {
    changed: true, transitioned: false, changed_fields: ["notes"],
  });
  const row = DB.getApplication(id);
  for (const field of metadataFields.filter((field) => field !== "notes")) {
    assert.equal(row[field], originalMetadata[field]);
  }
  assert.equal(row.notes, "New synthetic note");
  assert.deepEqual(changes(events(id).at(-1)), {
    notes: { from: originalMetadata.notes, to: "New synthetic note" },
  });
  assert.equal(events(id).at(-1).kind, "application_updated");
});

test("null explicitly clears each metadata field and journals prior values", () => {
  const id = newJob();
  DB.recordApplication(id, { status: "applied", ...originalMetadata });
  const clears = Object.fromEntries(metadataFields.map((field) => [field, null]));
  assert.deepEqual(DB.recordApplication(id, { status: "applied", ...clears }), {
    changed: true, transitioned: false, changed_fields: metadataFields,
  });
  const row = DB.getApplication(id);
  for (const field of metadataFields) assert.equal(row[field], null);
  assert.deepEqual(changes(events(id).at(-1)), Object.fromEntries(
    metadataFields.map((field) => [field, { from: originalMetadata[field], to: null }]),
  ));
});

test("empty strings and whitespace are stored verbatim, distinct from null", () => {
  const id = newJob();
  DB.recordApplication(id, { status: "interested" });
  const verbatim = { applied_at: "", next_action: "  ", next_action_at: "", notes: "\n Synthetic text\n\t" };
  assert.deepEqual(DB.recordApplication(id, { status: "interested", ...verbatim }), {
    changed: true, transitioned: false, changed_fields: metadataFields,
  });
  const row = DB.getApplication(id);
  for (const field of metadataFields) assert.equal(row[field], verbatim[field]);
  assert.deepEqual(changes(events(id).at(-1)), Object.fromEntries(
    metadataFields.map((field) => [field, { from: null, to: verbatim[field] }]),
  ));
});

test("exact repeats and omitted identical metadata are true no-ops", () => {
  const id = newJob();
  const input = { status: "interested", ...originalMetadata };
  DB.recordApplication(id, input);
  const beforeRow = DB.getApplication(id);
  const beforeEvents = events(id);
  const beforeCount = countRows();
  // A successful no-op must avoid even a redundant UPDATE, not merely leave
  // the row looking unchanged after writing it.
  DB.db.exec(`CREATE TEMP TRIGGER reject_redundant_application_update
    BEFORE UPDATE ON applications WHEN OLD.job_id=${id}
    BEGIN SELECT RAISE(ABORT, 'unexpected redundant application update'); END`);
  try {
    for (const repeated of [input, { status: "interested" }]) {
      assert.deepEqual(DB.recordApplication(id, repeated), {
        changed: false, transitioned: false, changed_fields: [],
      });
    }
    assert.deepEqual(DB.getApplication(id), beforeRow);
    assert.deepEqual(events(id), beforeEvents);
    assert.equal(countRows(), beforeCount);
  } finally {
    DB.db.exec("DROP TRIGGER reject_redundant_application_update");
  }
});

test("repeating null and empty values does not add a journal event", () => {
  const id = newJob();
  const input = { status: "applied", applied_at: null, next_action: "", next_action_at: null, notes: "" };
  DB.recordApplication(id, input);
  const before = events(id);
  assert.deepEqual(DB.recordApplication(id, input), {
    changed: false, transitioned: false, changed_fields: [],
  });
  assert.deepEqual(events(id), before);
});

test("metadata changes preserve the last status-transition timestamp", () => {
  const id = newJob();
  DB.recordApplication(id, { status: "rejected", ...originalMetadata });
  const transitionTime = "2001-02-03 04:05:06";
  DB.db.prepare("UPDATE applications SET updated_at=? WHERE job_id=?").run(transitionTime, id);
  const beforeEvents = events(id).length;
  assert.deepEqual(DB.recordApplication(id, {
    status: "rejected", next_action: null, notes: "Synthetic feedback for later review",
  }), { changed: true, transitioned: false, changed_fields: ["next_action", "notes"] });
  assert.equal(DB.getApplication(id).updated_at, transitionTime);
  assert.equal(events(id).length, beforeEvents + 1);
  assert.equal(events(id).at(-1).kind, "application_updated");
});

test("status transition advances timestamp and preserves omitted metadata", () => {
  const id = newJob();
  DB.recordApplication(id, { status: "interested", ...originalMetadata });
  const oldTime = "2001-02-03 04:05:06";
  DB.db.prepare("UPDATE applications SET updated_at=? WHERE job_id=?").run(oldTime, id);
  const earliest = DB.nowStr();
  const beforeEvents = events(id).length;
  assert.deepEqual(DB.recordApplication(id, { status: "applied" }), {
    changed: true, transitioned: true, changed_fields: ["status"],
  });
  const row = DB.getApplication(id);
  assert.notEqual(row.updated_at, oldTime);
  assert.ok(row.updated_at >= earliest && row.updated_at <= DB.nowStr());
  for (const field of metadataFields) assert.equal(row[field], originalMetadata[field]);
  assert.equal(events(id).length, beforeEvents + 1);
  assert.equal(events(id).at(-1).kind, "applied");
  assert.deepEqual(changes(events(id).at(-1)), { status: { from: "interested", to: "applied" } });
});

test("combined status and metadata update emits one complete from/to event", () => {
  const id = newJob();
  DB.recordApplication(id, { status: "interested", ...originalMetadata });
  const next = { status: "applied", applied_at: "2026-02-03", next_action: "", next_action_at: null, notes: "Synthetic submitted packet reference" };
  const beforeEvents = events(id).length;
  assert.deepEqual(DB.recordApplication(id, next), {
    changed: true, transitioned: true, changed_fields: ["status", ...metadataFields],
  });
  const journal = events(id);
  assert.equal(journal.length, beforeEvents + 1);
  assert.equal(journal.at(-1).kind, "applied");
  const before = { status: "interested", ...originalMetadata };
  assert.deepEqual(changes(journal.at(-1)), Object.fromEntries(
    Object.entries(next).map(([field, value]) => [field, { from: before[field], to: value }]),
  ));
});

function withJournalFailure(id, fn) {
  // Fault only this test's synthetic application journal insert, after the
  // application row write has run, to verify the surrounding transaction.
  DB.db.exec(`CREATE TEMP TRIGGER reject_application_journal
    BEFORE INSERT ON events WHEN NEW.ref='${id}' AND NEW.kind IN ('applied','application_updated')
    BEGIN SELECT RAISE(ABORT, 'synthetic application journal failure'); END`);
  try { fn(); }
  finally { DB.db.exec("DROP TRIGGER reject_application_journal"); }
}

test("journal failure rolls back a newly inserted application", () => {
  const id = newJob();
  const beforeCount = countRows();
  const beforeEvents = events(id);
  withJournalFailure(id, () => {
    assert.throws(() => DB.recordApplication(id, { status: "applied", ...originalMetadata }), /synthetic application journal failure/);
  });
  assert.equal(DB.getApplication(id), undefined);
  assert.equal(countRows(), beforeCount);
  assert.deepEqual(events(id), beforeEvents);
  assert.equal(DB.recordApplication(id, { status: "interested" }).changed, true, "connection remains usable after rollback");
});

test("journal failure rolls back status, metadata, timestamp and journal together", () => {
  const id = newJob();
  DB.recordApplication(id, { status: "interested", ...originalMetadata });
  DB.db.prepare("UPDATE applications SET updated_at=? WHERE job_id=?").run("2001-02-03 04:05:06", id);
  const beforeRow = DB.getApplication(id);
  const beforeEvents = events(id);
  const beforeCount = countRows();
  withJournalFailure(id, () => {
    for (const patch of [
      { status: "applied", notes: "Synthetic failed status transition", next_action: null },
      { status: "interested", notes: "Synthetic failed metadata edit" },
    ]) {
      assert.throws(() => DB.recordApplication(id, patch), /synthetic application journal failure/);
      assert.deepEqual(DB.getApplication(id), beforeRow);
      assert.deepEqual(events(id), beforeEvents);
      assert.equal(countRows(), beforeCount);
    }
  });
  assert.equal(DB.recordApplication(id, { status: "interested", notes: "Synthetic successful retry" }).changed, true);
});
