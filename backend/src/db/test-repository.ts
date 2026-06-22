// test-repository.ts
//
// One-off verification script — NOT part of the running app.
// Inserts a fake row, fetches it, updates its status, and publishes it,
// confirming every queueRepository function works end-to-end before
// it's wired into the Express API.

import {
  insertItem,
  getItemById,
  getPendingItems,
  updateItemStatus,
  publishReply,
  saveExample,
} from "./queueRepository";

const testId = "test_comment_001";

console.log("1. Inserting test item...");
insertItem({
  comment_id: testId,
  post_id: "test_post",
  platform: "shortform",
  author: "@test_user",
  original_comment: "This is a test comment.",
  triage_label: "reply",
  triage_reason: "Test reason.",
  safety_label: "ok",
  safety_reason: "No issues detected.",
  draft: "Thanks for the test comment!",
  status: "pending",
  // These three fields are only populated later in the item's lifecycle
  // (after a human decision or a blocked-draft event) — at insert time
  // they're always null. Passing them explicitly here satisfies the
  // ReviewItem type and matches what queueRepository's insertItemStmt
  // actually expects (better-sqlite3's named parameters require every
  // @field referenced in the SQL to be present in the object).
  edited_reply: null,
  rejection_reason: null,
  draft_blocked_reason: null,
});

console.log("2. Fetching by ID...");
const fetched = getItemById(testId);
console.log(fetched);

if (!fetched) {
  console.error("FAILED: item was not inserted correctly.");
  process.exit(1);
}

console.log("3. Checking it appears in pending items...");
const pending = getPendingItems();
const found = pending.some((item) => item.comment_id === testId);
console.log(`Found in pending list: ${found}`);

console.log("4. Approving the item...");
updateItemStatus(testId, "approved");
const afterApproval = getItemById(testId);
console.log(`Status after approval: ${afterApproval?.status}`);

console.log("5. Publishing the reply...");
const publishedFirst = publishReply(testId, "Thanks for the test comment!");
const publishedSecond = publishReply(testId, "Thanks for the test comment!");
console.log(`First publish (should be true): ${publishedFirst}`);
console.log(`Second publish, duplicate (should be false): ${publishedSecond}`);

console.log("6. Saving a learning example...");
saveExample("This is a test comment.", "Thanks for the test comment!");

console.log("\nAll repository functions executed without errors.");
// Clean up: remove the test row so it doesn't pollute the real queue data.
// Why delete here rather than leaving it?
// This script gets run again every time we want to re-verify the
// repository layer (e.g. after a future schema change) — leaving stale
// test rows behind would cause duplicate-key conflicts on the next run
// and clutter any real queue data with fake entries.
import { db } from "./connection";
// Delete child rows before the parent row — publish_log has a foreign
// key pointing at review_items.comment_id, so SQLite refuses to delete
// the parent while a child still references it. This ordering mirrors
// the real constraint and is the correct cleanup pattern any time a
// foreign key relationship like this exists.
db.prepare("DELETE FROM publish_log WHERE comment_id = ?").run(testId);
db.prepare("DELETE FROM review_items WHERE comment_id = ?").run(testId);
db.prepare("DELETE FROM learning_examples WHERE comment_text = ?").run(
  "This is a test comment."
);
console.log("Test data cleaned up.");