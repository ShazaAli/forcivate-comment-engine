"""
main.py

Entry point. Orchestrates the full pipeline:
  1. Load fixture data and brand voice config.
  2. For each comment: run safety check → draft → safety-check draft → enqueue.
  3. Launch the interactive human review CLI.
  4. For approved items: mock-publish and save learning example.

Run with:
    python -m src.main                  # Full pipeline (ingest + review)
    python -m src.main --review-only    # Skip ingest, just review pending queue

Design decision: We use argparse (stdlib) rather than Click or Typer.
No extra dependencies for a simple two-mode CLI.
"""

import json
import argparse  # Built-in argument parsing — no deps needed.
import sys
import os

# We import our own modules using absolute-style imports from the package root.
# This works because we run with `python -m src.main` from the project root.
from src.safety_gate import check_comment, check_draft
from src.drafter import get_drafter
from src import queue_store


# ---------------------------------------------------------------------------
# HELPERS
# ---------------------------------------------------------------------------

def load_json_file(path: str) -> any:
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

def run_ingest(posts: list, voice_configs: dict, drafter) -> None:
    """
    For every comment in every post:
      - Run safety gate on the comment text.
      - If not spam, draft a reply using the brand voice.
      - Run safety gate on the draft.
      - Add result to the review queue.

    Why process ALL comments before entering the review loop?
    Because ingest can be a batch job (run overnight) while review is
    interactive (done by a human during business hours). Separating them
    allows each to run independently — see --review-only flag.
    """
    print_banner("STAGE 1: Ingesting comments and generating drafts")

    # Load approved examples once before the loop — not inside, for efficiency.
    few_shot_examples = queue_store.load_examples()

    for post in posts:
        post_id = post["post_id"]
        platform = post["platform"]
        post_text = post["post_text"]

        # Look up the voice config for this platform.
        # Why .get() with a fallback to "professional"?
        # Defensive coding — if a new platform is added to comments.json before
        # its voice config exists, we degrade gracefully rather than KeyError.
        voice_config = voice_configs.get(platform, voice_configs.get("professional", {}))

        print(f"\n[Post {post_id} | Platform: {platform}]")
        print(f"Post: {post_text[:80]}...")  # Truncate long posts in the log.

        for comment in post["comments"]:
            comment_id = comment["comment_id"]
            author = comment["author"]
            comment_text = comment["text"]

            print(f"\n  → Comment [{comment_id}] by {author}")
            print(f"    \"{comment_text[:60]}...\"" if len(comment_text) > 60 else f"    \"{comment_text}\"")

            # --- SAFETY CHECK ON INPUT ---
            gate_result = check_comment(comment_text)
            label = gate_result["label"]
            print(f"    Safety label: [{label.upper()}] — {gate_result['reason']}")

            # SPAM: skip entirely — no reply drafted, no queue entry.
            # Why? Replying to spam gives spammers engagement. No entry means
            # no reviewer time wasted.
            if label == "spam":
                print("    ⏭  Skipping spam comment — no draft generated.")
                continue

            # INJECTION: we use the sanitized text (payload stripped), not the original.
            # This means the LLM sees "[CONTENT REMOVED: policy violation]" — harmless.
            text_for_llm = gate_result["sanitized"]
            is_hostile = (label == "hostile")

            # --- DRAFT GENERATION ---
            print("    ✍  Drafting reply...")
            draft = drafter.draft(
                post_text=post_text,
                comment_text=text_for_llm,
                voice_config=voice_config,
                is_hostile=is_hostile,
                few_shot_examples=few_shot_examples,
            )
            print(f"    Draft: \"{draft[:80]}...\"" if len(draft) > 80 else f"    Draft: \"{draft}\"")

            # --- SAFETY CHECK ON OUTPUT ---
            draft_gate = check_draft(draft)
            if not draft_gate["safe"]:
                print(f"    ⛔ Draft failed safety check: {draft_gate['reason']}")
                # Add to queue with a blocked status — visible to reviewer but not publishable.
                queue_store.add_to_queue({
                    "comment_id": comment_id,
                    "post_id": post_id,
                    "platform": platform,
                    "author": author,
                    "original_comment": comment_text,
                    "safety_label": label,
                    "safety_reason": gate_result["reason"],
                    "draft": "[BLOCKED — draft failed output safety check]",
                    "draft_blocked_reason": draft_gate["reason"],
                    "status": "blocked",   # Blocked items show in review but can't be approved.
                })
                continue

            # --- ENQUEUE FOR HUMAN REVIEW ---
            queue_store.add_to_queue({
                "comment_id": comment_id,
                "post_id": post_id,
                "platform": platform,
                "author": author,
                "original_comment": comment_text,  # Store original (not sanitized) for reviewer context.
                "safety_label": label,
                "safety_reason": gate_result["reason"],
                "draft": draft,
                "status": "pending",
            })
            print("    ✅ Added to review queue.")


# ---------------------------------------------------------------------------
# STAGE 2: HUMAN REVIEW CLI
# ---------------------------------------------------------------------------

def run_review() -> None:
    """
    Interactive CLI for a human reviewer to approve, edit, or reject each draft.

    Design decision: We process one item at a time, saving after each decision.
    Why? If the reviewer closes the terminal halfway through, all previous
    decisions are already persisted. No work is lost.
    """
    print_banner("STAGE 2: Human Review Queue")

    pending = queue_store.get_pending_items()

    if not pending:
        print("  No pending items in the review queue.")
        return

    print(f"  {len(pending)} item(s) to review.\n")

    for item in pending:
        comment_id = item["comment_id"]
        print(f"\n{'─'*50}")
        print(f"Comment ID : {comment_id}")
        print(f"Platform   : {item['platform']}")
        print(f"Author     : {item['author']}")
        print(f"Safety     : [{item['safety_label'].upper()}] {item['safety_reason']}")
        print(f"\nOriginal comment:\n  {item['original_comment']}")
        print(f"\nDraft reply:\n  {item['draft']}")
        print()

        # Blocked items cannot be approved — only rejected.
        if item.get("status") == "blocked":
            print("  ⚠  This draft was BLOCKED by the output safety gate.")
            print(f"  Reason: {item.get('draft_blocked_reason', 'unknown')}")
            input("  Press Enter to mark as rejected and continue... ")
            queue_store.update_queue_item(comment_id, {
                "status": "rejected",
                "rejection_reason": "Auto-rejected: blocked by output safety gate",
            })
            continue

        # Prompt the reviewer for a decision.
        # We loop until a valid choice is made — no silent failures.
        while True:
            choice = input("  Decision — [a]pprove / [e]dit / [r]eject: ").strip().lower()

            if choice == "a":
                # Approve: publish mock + save as learning example.
                published = queue_store.publish_reply(comment_id, item["draft"])
                if published:
                    print("  🚀 Published (mock).")
                else:
                    print("  ⚠  Already published (duplicate detected — skipped).")

                # Save the approved draft as a few-shot example for future drafts.
                queue_store.save_example(item["original_comment"], item["draft"])
                print("  📚 Saved as learning example.")

                queue_store.update_queue_item(comment_id, {"status": "approved"})
                break

            elif choice == "e":
                # Edit: show the draft, let the reviewer type a replacement.
                print("  Current draft:")
                print(f"    {item['draft']}")
                edited = input("  Your edited reply: ").strip()
                if not edited:
                    print("  Empty input — keeping original draft.")
                    edited = item["draft"]

                # Publish the EDITED version, not the original draft.
                published = queue_store.publish_reply(comment_id, edited)
                if published:
                    print("  🚀 Published edited reply (mock).")
                else:
                    print("  ⚠  Already published (duplicate detected — skipped).")

                # The human-edited reply is the most valuable learning signal.
                # It's what the brand ACTUALLY wants to say.
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
                # Invalid input — re-prompt. Don't crash; humans make typos.
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
    args = parser.parse_args()

    if not args.review_only:
        # Load data files.
        posts = load_json_file("data/comments.json")
        voice_configs = load_json_file("data/brand_voice.json")

        # Get the appropriate drafter (real or mock) via the factory function.
        # Why call get_drafter() here and not inside run_ingest?
        # So we initialize the HTTP client once and pass it in — not once per comment.
        drafter = get_drafter()
        drafter_type = type(drafter).__name__
        print(f"[INFO] Using drafter: {drafter_type}")
        if drafter_type == "MockDrafter":
            print("[INFO] Set ANTHROPIC_API_KEY in your environment to use the real LLM.")

        run_ingest(posts, voice_configs, drafter)

    run_review()


if __name__ == "__main__":
    # This guard means the file can be imported without running main().
    # `python src/main.py` and `python -m src.main` both work.
    main()