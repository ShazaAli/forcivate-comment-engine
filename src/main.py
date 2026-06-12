"""
main.py

Entry point. Orchestrates the full pipeline:
  1. Load fixture data and brand voice config.
  2. For each comment: triage → safety check → draft → safety-check draft → enqueue.
  3. Auto-approve low-risk items (triage=reply AND safety=ok) without human review.
  4. Launch the interactive human review CLI for everything else.
  5. For approved items: mock-publish and save learning example.

Run with:
    python -m src.main                  # Full pipeline (ingest + review)
    python -m src.main --review-only    # Skip ingest, just review pending queue
    python -m src.main --no-auto        # Full pipeline, disable auto-approval

Design decision: We use argparse (stdlib) rather than Click or Typer.
No extra dependencies for a simple two-mode CLI.
"""

import json
import argparse
import sys
import os

from src.safety_gate import check_comment, check_draft
from src.drafter import get_drafter
from src.triage import triage_comment   # NEW: triage import
from src import queue_store


# ---------------------------------------------------------------------------
# HELPERS
# ---------------------------------------------------------------------------

def load_json_file(path: str):
    """Load and parse a JSON file. Exits with a clear error if file is missing."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        print(f"[ERROR] Required file not found: {path}")
        sys.exit(1)


def print_banner(text: str) -> None:
    """Print a clearly visible section header — makes CLI output scannable."""
    print(f"\n{'='*60}")
    print(f"  {text}")
    print(f"{'='*60}")


# ---------------------------------------------------------------------------
# STAGE 1: INGEST — process all comments and fill the queue
# ---------------------------------------------------------------------------

def run_ingest(posts: list, voice_configs: dict, drafter, auto_approve: bool) -> None:
    """
    For every comment in every post:
      - Run triage to decide if a reply is warranted at all.
      - Run safety gate on the comment text.
      - If not spam/skipped, draft a reply using the brand voice.
      - Run safety gate on the draft.
      - Add result to the review queue.
      - If auto_approve=True and risk is low, publish immediately without human review.

    Why does auto_approve live in run_ingest and not run_review?
    Because we want to auto-approve at write time — the item is published before
    it ever enters the human queue. This keeps the human queue clean: reviewers
    only see items that genuinely need attention.
    """
    print_banner("STAGE 1: Ingesting comments and generating drafts")

    few_shot_examples = queue_store.load_examples()
    auto_approved_count = 0

    for post in posts:
        post_id = post["post_id"]
        platform = post["platform"]
        post_text = post["post_text"]

        voice_config = voice_configs.get(platform, voice_configs.get("professional", {}))

        print(f"\n[Post {post_id} | Platform: {platform}]")
        print(f"Post: {post_text[:80]}...")

        for comment in post["comments"]:
            comment_id = comment["comment_id"]
            author = comment["author"]
            comment_text = comment["text"]

            # Skip  comments already processed in a previous run.
            # Why check by comment_id?
            # If the user runs the pipeline twice (e.g. after a crash), we must
            # not re-queue the same comment — it would appear multiple times in
            # the review queue and potentially get published twice.
            existing_ids = {item["comment_id"] for item in queue_store.load_queue()}
            if comment_id in existing_ids:
                print(f"\n  → Comment [{comment_id}] — already processed, skipping.")
                continue

            print(f"\n  → Comment [{comment_id}] by {author}")            
            print(f"    \"{comment_text[:60]}...\"" if len(comment_text) > 60 else f"    \"{comment_text}\"")

            # --- STAGE 1a: TRIAGE ---
            # Triage runs first, before safety and before the LLM drafter.
            # Why first? Because if triage says "skip", we spend zero tokens on
            # safety checking or drafting — maximum cost savings.
            triage = triage_comment(comment_text, post_text)
            triage_label = triage["label"]
            print(f"    Triage: [{triage_label.upper()}] ({triage['source']}) — {triage['reason']}")

            if triage_label == "skip":
                # Not worth replying to. Log it but don't queue it.
                # Why log at all? So the team can audit what got skipped and
                # tune the triage prompt if valuable comments are being dropped.
                print("    ⏭  Triage: skipping — comment not worth a reply.")
                queue_store.add_to_queue({
                    "comment_id": comment_id,
                    "post_id": post_id,
                    "platform": platform,
                    "author": author,
                    "original_comment": comment_text,
                    "triage_label": triage_label,
                    "triage_reason": triage["reason"],
                    "safety_label": "n/a",
                    "safety_reason": "Skipped at triage — no safety check performed.",
                    "draft": "[SKIPPED — triage determined no reply needed]",
                    "status": "skipped",  # A new terminal status — not pending, not published.
                })
                continue

            if triage_label == "monitor":
                # Flag for human attention without drafting.
                # Why no draft? The whole point of "monitor" is that we don't know
                # what to say yet — generating a draft could give false confidence.
                print("    👁  Triage: flagged for monitoring — no draft generated.")
                queue_store.add_to_queue({
                    "comment_id": comment_id,
                    "post_id": post_id,
                    "platform": platform,
                    "author": author,
                    "original_comment": comment_text,
                    "triage_label": triage_label,
                    "triage_reason": triage["reason"],
                    "safety_label": "n/a",
                    "safety_reason": "Flagged at triage — no safety check performed.",
                    "draft": "[MONITOR — human must decide whether to reply and what to say]",
                    "status": "monitor",  # Surfaces in the human queue with no draft to approve.
                })
                continue

            # triage_label == "reply" — proceed with full pipeline.

            # --- STAGE 1b: SAFETY CHECK ON INPUT ---
            gate_result = check_comment(comment_text)
            label = gate_result["label"]
            print(f"    Safety: [{label.upper()}] — {gate_result['reason']}")

            if label == "spam":
                print("    ⏭  Skipping spam comment — no draft generated.")
                continue

            text_for_llm = gate_result["sanitized"]
            is_hostile = (label == "hostile")

            # --- STAGE 1c: DRAFT GENERATION ---
            print("    ✍  Drafting reply...")
            draft = drafter.draft(
                post_text=post_text,
                comment_text=text_for_llm,
                voice_config=voice_config,
                is_hostile=is_hostile,
                few_shot_examples=few_shot_examples,
            )
            print(f"    Draft: \"{draft[:80]}...\"" if len(draft) > 80 else f"    Draft: \"{draft}\"")

            # --- STAGE 1d: SAFETY CHECK ON OUTPUT ---
            draft_gate = check_draft(draft)
            if not draft_gate["safe"]:
                print(f"    ⛔ Draft failed safety check: {draft_gate['reason']}")
                queue_store.add_to_queue({
                    "comment_id": comment_id,
                    "post_id": post_id,
                    "platform": platform,
                    "author": author,
                    "original_comment": comment_text,
                    "triage_label": triage_label,
                    "triage_reason": triage["reason"],
                    "safety_label": label,
                    "safety_reason": gate_result["reason"],
                    "draft": "[BLOCKED — draft failed output safety check]",
                    "draft_blocked_reason": draft_gate["reason"],
                    "status": "blocked",
                })
                continue

            # --- STAGE 1e: RISK TIER DECISION ---
            # A comment is "low risk" (eligible for auto-approval) if and only if:
            #   - triage said "reply" (not skip or monitor)
            #   - safety said "ok" (not hostile, not injection, not spam)
            #
            # Why require BOTH conditions?
            # triage=reply + safety=hostile → hostile comment. Needs a human to
            #   verify the de-escalating reply is appropriate.
            # triage=reply + safety=injection → the draft was generated from a
            #   sanitized payload. Human should see what happened.
            # triage=reply + safety=ok → clean comment, clean draft. Safe to auto-approve.
            is_low_risk = (triage_label == "reply" and label == "ok")

            if auto_approve and is_low_risk:
                # AUTO-APPROVE: publish immediately, save learning example,
                # write to queue with status "auto_approved" (not "pending").
                published = queue_store.publish_reply(comment_id, draft)
                if published:
                    queue_store.save_example(comment_text, draft)
                    queue_store.add_to_queue({
                        "comment_id": comment_id,
                        "post_id": post_id,
                        "platform": platform,
                        "author": author,
                        "original_comment": comment_text,
                        "triage_label": triage_label,
                        "triage_reason": triage["reason"],
                        "safety_label": label,
                        "safety_reason": gate_result["reason"],
                        "draft": draft,
                        "status": "auto_approved",  # Distinguishable from human "approved".
                    })
                    auto_approved_count += 1
                    print("    🤖 Auto-approved and published (low risk).")
                continue  # Skip the human queue entirely.

            # High-risk or auto_approve disabled → queue for human review.
            queue_store.add_to_queue({
                "comment_id": comment_id,
                "post_id": post_id,
                "platform": platform,
                "author": author,
                "original_comment": comment_text,
                "triage_label": triage_label,
                "triage_reason": triage["reason"],
                "safety_label": label,
                "safety_reason": gate_result["reason"],
                "draft": draft,
                "status": "pending",
            })
            print("    ✅ Added to human review queue.")

    if auto_approve:
        print(f"\n  [Auto-approval] {auto_approved_count} comment(s) published without human review.")


# ---------------------------------------------------------------------------
# STAGE 2: HUMAN REVIEW CLI
# ---------------------------------------------------------------------------

def run_review() -> None:
    """
    Interactive CLI for a human reviewer to approve, edit, or reject each draft.
    Only "pending" and "monitor" items appear here — auto_approved and skipped
    items are already resolved.

    Design decision: monitor items appear in the review queue with no draft.
    Why? The reviewer needs to know they exist and decide what to do.
    The CLI shows them clearly and lets the reviewer reject them with a note,
    or type a fully custom reply from scratch.
    """
    print_banner("STAGE 2: Human Review Queue")

    # We show pending AND monitor items — both need human attention.
    all_queue = queue_store.load_queue()
    review_items = [
        item for item in all_queue
        if item.get("status") in ("pending", "monitor", "blocked")
    ]

    if not review_items:
        print("  No items require human review.")
        return

    print(f"  {len(review_items)} item(s) to review.\n")

    for item in review_items:
        comment_id = item["comment_id"]
        status = item.get("status")

        print(f"\n{'─'*50}")
        print(f"Comment ID : {comment_id}")
        print(f"Platform   : {item['platform']}")
        print(f"Author     : {item['author']}")
        print(f"Triage     : [{item.get('triage_label', 'n/a').upper()}] {item.get('triage_reason', '')}")
        print(f"Safety     : [{item['safety_label'].upper()}] {item['safety_reason']}")
        print(f"\nOriginal comment:\n  {item['original_comment']}")
        print(f"\nDraft reply:\n  {item['draft']}")
        print()

        # BLOCKED items: can only be rejected.
        if status == "blocked":
            print("  ⚠  This draft was BLOCKED by the output safety gate.")
            print(f"  Reason: {item.get('draft_blocked_reason', 'unknown')}")
            input("  Press Enter to mark as rejected and continue... ")
            queue_store.update_queue_item(comment_id, {
                "status": "rejected",
                "rejection_reason": "Auto-rejected: blocked by output safety gate",
            })
            continue

        # MONITOR items: no pre-generated draft. Reviewer can write one or skip.
        if status == "monitor":
            print("  👁  This comment was flagged for MONITORING. No draft was generated.")
            print("  Options: [w]rite a custom reply / [s]kip (no reply)")
            while True:
                choice = input("  Decision — [w]rite / [s]kip: ").strip().lower()
                if choice == "w":
                    custom = input("  Your reply: ").strip()
                    if custom:
                        queue_store.publish_reply(comment_id, custom)
                        queue_store.save_example(item["original_comment"], custom)
                        queue_store.update_queue_item(comment_id, {
                            "status": "approved",
                            "edited_reply": custom,
                        })
                        print("  🚀 Custom reply published (mock).")
                    else:
                        print("  Empty — skipping.")
                        queue_store.update_queue_item(comment_id, {"status": "skipped"})
                    break
                elif choice == "s":
                    queue_store.update_queue_item(comment_id, {"status": "skipped"})
                    print("  ⏭  Skipped.")
                    break
                else:
                    print("  Invalid. Type 'w' or 's'.")
            continue

        # PENDING items: normal approve / edit / reject flow.
        while True:
            choice = input("  Decision — [a]pprove / [e]dit / [r]eject: ").strip().lower()

            if choice == "a":
                published = queue_store.publish_reply(comment_id, item["draft"])
                if published:
                    print("  🚀 Published (mock).")
                else:
                    print("  ⚠  Already published (duplicate detected — skipped).")
                queue_store.save_example(item["original_comment"], item["draft"])
                print("  📚 Saved as learning example.")
                queue_store.update_queue_item(comment_id, {"status": "approved"})
                break

            elif choice == "e":
                print(f"  Current draft:\n    {item['draft']}")
                edited = input("  Your edited reply: ").strip()
                if not edited:
                    print("  Empty input — keeping original draft.")
                    edited = item["draft"]
                published = queue_store.publish_reply(comment_id, edited)
                if published:
                    print("  🚀 Published edited reply (mock).")
                else:
                    print("  ⚠  Already published (duplicate detected — skipped).")
                queue_store.save_example(item["original_comment"], edited)
                print("  📚 Edited reply saved as learning example.")
                queue_store.update_queue_item(comment_id, {
                    "status": "approved",
                    "edited_reply": edited,
                })
                break

            elif choice == "r":
                reason = input("  Rejection reason (optional): ").strip()
                queue_store.update_queue_item(comment_id, {
                    "status": "rejected",
                    "rejection_reason": reason or "No reason given",
                })
                print("  ❌ Rejected.")
                break

            else:
                print("  Invalid choice. Please type 'a', 'e', or 'r'.")

    print_banner("Review complete. Check data/published.json for mock-published replies.")


# ---------------------------------------------------------------------------
# ENTRY POINT
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Forcivate Comment Response Engine"
    )
    parser.add_argument(
        "--review-only",
        action="store_true",
        help="Skip ingest; only run the human review loop on existing queue items.",
    )
    parser.add_argument(
        "--no-auto",
        action="store_true",
        help="Disable auto-approval of low-risk comments. All items go to human review.",
    )
    args = parser.parse_args()

    if not args.review_only:
        posts = load_json_file("data/comments.json")
        voice_configs = load_json_file("data/brand_voice.json")
        drafter = get_drafter()
        drafter_type = type(drafter).__name__
        print(f"[INFO] Using drafter: {drafter_type}")

        # auto_approve is True by default; --no-auto disables it.
        # Why default to True? The feature exists to reduce reviewer burden.
        # If you want to audit everything, you opt out explicitly.
        auto_approve = not args.no_auto
        if auto_approve:
            print("[INFO] Auto-approval ENABLED for low-risk comments (triage=reply + safety=ok).")
        else:
            print("[INFO] Auto-approval DISABLED — all items will go to human review.")

        run_ingest(posts, voice_configs, drafter, auto_approve)

    run_review()


if __name__ == "__main__":
    main()