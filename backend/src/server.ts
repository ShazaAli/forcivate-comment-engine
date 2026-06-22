// server.ts
//
// Express API server exposing the review queue over HTTP for the React
// frontend to consume. This file only handles HTTP concerns (routing,
// status codes, request/response shapes) — all actual logic lives in
// queueRepository.ts. Keeping that boundary clean means the repository
// functions stay testable and reusable outside of an HTTP context
// (e.g. from a future CLI tool or background job).

import express, { Request, Response } from "express";
import cors from "cors";
import {
  getPendingItems,
  getItemById,
  updateItemStatus,
  publishReply,
  saveExample,
} from "./db/queueRepository";

const app = express();
const PORT = 3001;

// Why cors() with no options (allow-all) rather than a restricted
// origin list?
// This is a local development tool running on a developer's own
// laptop, not a deployed production service handling real user data.
// Restricting origins would add complexity with zero security benefit
// in this context — it's a reasonable, explicitly-justified tradeoff
// rather than an oversight.
app.use(cors());

// Why express.json() middleware?
// Our POST endpoint receives a JSON body (the reviewer's decision).
// Without this, req.body would be undefined — Express doesn't parse
// JSON bodies by default.
app.use(express.json());

/**
 * GET /api/queue
 *
 * Returns all items needing human review (pending, monitor, blocked).
 * Why return all three statuses from one endpoint rather than three
 * separate endpoints?
 * The frontend's job is to render "everything the reviewer needs to
 * look at right now" — splitting that into three API calls would just
 * push the merging logic onto the client for no benefit. One endpoint,
 * one array, the UI decides how to group/display by status if it wants to.
 */
app.get("/api/queue", (req: Request, res: Response) => {
  try {
    const items = getPendingItems();
    res.json(items);
  } catch (error) {
    console.error("Failed to fetch queue:", error);
    res.status(500).json({ error: "Failed to fetch queue items." });
  }
});

/**
 * POST /api/queue/:id/decision
 *
 * Body: { decision: "approve" | "edit" | "reject", replyText?: string, reason?: string }
 *
 * Why one endpoint with a `decision` field instead of three separate
 * routes (POST /approve, POST /edit, POST /reject)?
 * All three are the same underlying action from the API's perspective:
 * "resolve this queue item." Three routes would mean three copies of
 * the same not-found/already-resolved checks. One route with a
 * discriminated body is less repetition and matches how a REST
 * resource's state transition is commonly modeled.
 */
app.post("/api/queue/:id/decision", (req: Request, res: Response) => {
  // Express types route params as `string | string[]` to account for
  // patterns that could theoretically repeat (e.g. `/:id/:id`). Our
  // route only ever has one `:id` segment, so it's always a plain
  // string in practice — this cast documents that guarantee rather
  // than silently widening the type or sprinkling `as string` at every
  // call site below.
  const commentId = req.params.id as string;
  const { decision, replyText, reason } = req.body;

  // Validate the item exists before doing anything else.
  // Why check here instead of letting the UPDATE silently affect 0 rows?
  // A silent no-op would return a 200 OK to the frontend even though
  // nothing happened — the reviewer would think their decision was
  // saved when it wasn't. Failing loudly with a 404 is the honest response.
  const item = getItemById(commentId);
  if (!item) {
    return res.status(404).json({ error: `No queue item found with id ${commentId}` });
  }

  // Why check status here too?
  // Prevents a reviewer from double-submitting a decision (e.g. clicking
  // "approve" twice quickly) from corrupting the decided_at timestamp
  // or re-publishing. Once resolved, an item is immutable through this
  // endpoint — matching the real-world expectation that a decision,
  // once made, isn't silently overwritten.
  if (item.status !== "pending" && item.status !== "monitor" && item.status !== "blocked") {
    return res.status(409).json({
      error: `Item ${commentId} was already resolved with status "${item.status}".`,
    });
  }

  if (decision === "approve") {
    // Approve uses the existing draft as-is.
    const finalReply = item.draft ?? "";
    updateItemStatus(commentId, "approved");
    publishReply(commentId, finalReply);
    saveExample(item.original_comment, finalReply);
    return res.json({ status: "approved", publishedReply: finalReply });
  }

  if (decision === "edit") {
    // Edit requires the reviewer to supply replacement text.
    if (!replyText || typeof replyText !== "string" || replyText.trim() === "") {
      return res.status(400).json({ error: "replyText is required for an edit decision." });
    }
    updateItemStatus(commentId, "approved", replyText);
    publishReply(commentId, replyText);
    saveExample(item.original_comment, replyText);
    return res.json({ status: "approved", publishedReply: replyText });
  }

  if (decision === "reject") {
    updateItemStatus(commentId, "rejected", null, reason ?? "No reason given");
    return res.json({ status: "rejected" });
  }

  // Why validate `decision` against a known set rather than trusting
  // the client?
  // The request body is untrusted input, same principle as treating
  // comment text as untrusted in the Python safety gate. We never let
  // an unexpected value silently fall through to a default behavior.
  return res.status(400).json({
    error: `Invalid decision "${decision}". Must be "approve", "edit", or "reject".`,
  });
});

app.listen(PORT, () => {
  console.log(`API server running at http://localhost:${PORT}`);
});