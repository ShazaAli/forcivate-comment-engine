// queueRepository.ts
//
// All SQL lives here. Every other module (API routes, future scripts)
// calls these functions instead of writing raw SQL — this mirrors the
// role queue_store.py plays in the Python pipeline.

import { db } from "./connection";

// Why a TypeScript interface mirroring the table columns instead of
// using `any`? Strong typing here means the API route handlers and the
// eventual React frontend all get autocomplete and compile-time checks
// on every field — catching typos like `commnet_id` before runtime.
export interface ReviewItem {
  comment_id: string;
  post_id: string;
  platform: string;
  author: string;
  original_comment: string;
  triage_label: string | null;
  triage_reason: string | null;
  safety_label: string | null;
  safety_reason: string | null;
  draft: string | null;
  status: string;
  edited_reply: string | null;
  rejection_reason: string | null;
  draft_blocked_reason: string | null;
  queued_at: string;
  decided_at: string | null;
}

// Why .prepare() once per query shape rather than calling db.prepare()
// inline inside every function?
// better-sqlite3 caches prepared statements internally regardless, but
// preparing at module scope makes the intent clearer: these are fixed,
// known queries, not dynamically built SQL strings (which would risk
// SQL injection if we ever interpolated user input directly).
const selectPendingStmt = db.prepare(
  `SELECT * FROM review_items WHERE status IN ('pending', 'monitor', 'blocked') ORDER BY queued_at ASC`
);

const selectAllStmt = db.prepare(
  `SELECT * FROM review_items ORDER BY queued_at DESC`
);

const selectByIdStmt = db.prepare(
  `SELECT * FROM review_items WHERE comment_id = ?`
);

const insertItemStmt = db.prepare(`
  INSERT INTO review_items (
    comment_id, post_id, platform, author, original_comment,
    triage_label, triage_reason, safety_label, safety_reason,
    draft, status
  ) VALUES (
    @comment_id, @post_id, @platform, @author, @original_comment,
    @triage_label, @triage_reason, @safety_label, @safety_reason,
    @draft, @status
  )
  -- Why ON CONFLICT DO NOTHING instead of letting a duplicate insert throw?
  -- The Python ingest step can be re-run multiple times against the same
  -- fixture data. Re-running ingest should be a safe no-op for comments
  -- already in the queue, not a crash. This mirrors the "already
  -- processed, skipping" guard you added to main.py.
  ON CONFLICT(comment_id) DO NOTHING
`);

const updateStatusStmt = db.prepare(`
  UPDATE review_items
  SET status = ?, edited_reply = ?, rejection_reason = ?, decided_at = datetime('now')
  WHERE comment_id = ?
`);

const insertPublishStmt = db.prepare(`
  INSERT INTO publish_log (comment_id, reply_text)
  VALUES (?, ?)
  ON CONFLICT(comment_id) DO NOTHING
`);

const selectPublishedStmt = db.prepare(
  `SELECT comment_id FROM publish_log WHERE comment_id = ?`
);

const insertExampleStmt = db.prepare(`
  INSERT INTO learning_examples (comment_text, reply_text)
  VALUES (?, ?)
`);

/**
 * Returns all items needing human attention: pending, monitor, and blocked.
 * Mirrors the filtering logic in Python's run_review().
 */
export function getPendingItems(): ReviewItem[] {
  return selectPendingStmt.all() as ReviewItem[];
}

/** Returns every row regardless of status — used for an admin/history view. */
export function getAllItems(): ReviewItem[] {
  return selectAllStmt.all() as ReviewItem[];
}

export function getItemById(commentId: string): ReviewItem | undefined {
  return selectByIdStmt.get(commentId) as ReviewItem | undefined;
}

/**
 * Insert a new review item (called by the Python->SQLite bridge script,
 * not by the API directly). Silently no-ops on duplicate comment_id.
 */
export function insertItem(item: Omit<ReviewItem, "queued_at" | "decided_at">): void {
  insertItemStmt.run(item);
}

/**
 * Apply a reviewer's decision: approve, edit, or reject.
 *
 * Why one function with a `status` parameter instead of three separate
 * functions (approveItem, editItem, rejectItem)?
 * All three decisions are really the same SQL UPDATE with different
 * values — splitting into three functions would just mean three thin
 * wrappers around identical logic. One function keeps the SQL in one
 * place; the API route layer is where the three distinct HTTP actions
 * (and their validation) belong.
 */
export function updateItemStatus(
  commentId: string,
  status: "approved" | "rejected",
  editedReply: string | null = null,
  rejectionReason: string | null = null
): void {
  updateStatusStmt.run(status, editedReply, rejectionReason, commentId);
}

/**
 * Mock-publish a reply. Returns true if newly published, false if it
 * was already published (duplicate protection), mirroring Python's
 * publish_reply() behavior exactly.
 */
export function publishReply(commentId: string, replyText: string): boolean {
  const alreadyPublished = selectPublishedStmt.get(commentId);
  if (alreadyPublished) {
    return false;
  }
  insertPublishStmt.run(commentId, replyText);
  return true;
}

/** Saves an approved/edited reply as a future few-shot example. */
export function saveExample(commentText: string, replyText: string): void {
  insertExampleStmt.run(commentText, replyText);
}