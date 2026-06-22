// seed-test-item.ts
//
// One-off script to insert a single pending item for manually testing
// the API's decision endpoint end-to-end. Not part of the running app.

import { insertItem } from "./queueRepository";

insertItem({
  comment_id: "api_test_001",
  post_id: "test_post",
  platform: "shortform",
  author: "@api_tester",
  original_comment: "Does this work with the new API?",
  triage_label: "reply",
  triage_reason: "Genuine question.",
  safety_label: "ok",
  safety_reason: "No issues detected.",
  draft: "Yes, it integrates directly with our new API!",
  status: "pending",
  edited_reply: null,
  rejection_reason: null,
  draft_blocked_reason: null,
});

console.log("Seeded api_test_001 as a pending item.");