-- schema.sql
--
-- Single table design: one row per comment, tracked through its lifecycle
-- via the `status` column rather than being moved between separate tables
-- or files. This mirrors how a real production queue table would look.
--
-- Why TEXT for comment_id instead of an auto-increment INTEGER primary key?
-- The Python pipeline already generates stable string IDs (e.g. "c1_genuine")
-- from the fixture data. Reusing that ID as the primary key means we never
-- need a separate mapping table between Python's IDs and a SQL-generated one.
CREATE TABLE IF NOT EXISTS review_items (
    comment_id          TEXT PRIMARY KEY,
    post_id             TEXT NOT NULL,
    platform            TEXT NOT NULL,
    author              TEXT NOT NULL,
    original_comment    TEXT NOT NULL,

    -- Triage and safety labels are stored as plain TEXT, not foreign keys
    -- to a lookup table. Why? There are only a handful of fixed values
    -- ("reply"/"skip"/"monitor", "ok"/"hostile"/"injection"/"spam"), and a
    -- lookup table would add a JOIN for no real query benefit at this scale.
    -- This is a deliberate scale-appropriate tradeoff, not an oversight.
    triage_label        TEXT,
    triage_reason        TEXT,
    safety_label         TEXT,
    safety_reason         TEXT,

    draft                TEXT,

    -- status drives the whole UI: pending items show in the reviewer's
    -- queue, everything else is historical record.
    -- Why TEXT instead of a SQL ENUM? SQLite has no native ENUM type;
    -- enforcing the allowed values is done at the application layer in
    -- the Node DB access module (next commit), which is the standard
    -- SQLite pattern.
    status                TEXT NOT NULL DEFAULT 'pending',

    edited_reply          TEXT,
    rejection_reason       TEXT,
    draft_blocked_reason    TEXT,

    -- queued_at uses SQLite's built-in datetime() function so every row
    -- gets a server-side timestamp — we never trust a client-supplied time.
    queued_at             TEXT NOT NULL DEFAULT (datetime('now')),
    decided_at             TEXT
);

-- Why an index on status?
-- The reviewer's main query is "give me all pending items" — that's a
-- full table scan without this index once the table grows beyond a
-- trivial size. For 8 fixture rows it makes zero performance difference,
-- but it's the correct habit for any queue-shaped table and worth having
-- ready to discuss in the interview.
CREATE INDEX IF NOT EXISTS idx_review_items_status ON review_items(status);

-- Separate table for published replies, mirroring published.json.
-- Why keep this separate from review_items instead of just checking
-- status = 'published' on the same row?
-- Duplicate-publish protection is a distinct concern from review state.
-- A row could theoretically be marked "approved" but fail to publish
-- (e.g. crash mid-write) — separating the tables means publish_log is
-- the single source of truth for "did this actually go out," independent
-- of the review workflow's own bookkeeping.
CREATE TABLE IF NOT EXISTS publish_log (
    comment_id      TEXT PRIMARY KEY,
    reply_text      TEXT NOT NULL,
    published_at    TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (comment_id) REFERENCES review_items(comment_id)
);

-- Learning examples table, mirroring approved_examples.json.
-- Why INTEGER PRIMARY KEY AUTOINCREMENT here but not on review_items?
-- This table has no natural unique key — the same comment text could
-- theoretically appear twice with different approved replies over time.
-- An autoincrement surrogate key is the right tool when there's no
-- natural identifier, versus review_items where comment_id already is one.
CREATE TABLE IF NOT EXISTS learning_examples (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    comment_text    TEXT NOT NULL,
    reply_text      TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);