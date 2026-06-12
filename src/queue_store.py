"""
queue_store.py

Handles all persistence: reading/writing the review queue, the published log,
and the approved examples (learning signal).

Design decision: We use plain JSON files stored in data/.
Why not SQLite?
For a 4-8 hour assignment, JSON files are transparent (you can open them in
any editor), require zero setup, and are sufficient for the data volume.
The interface (load/save functions) is identical to what a DB layer would
expose — swapping is straightforward later.

Design decision: We write atomically using a temp file + rename.
Why? If the process crashes mid-write, we never end up with a corrupted file.
os.replace() is atomic on all POSIX systems (and Windows since Python 3.3).
"""

import json
import os
import tempfile  # For atomic writes — built into Python's standard library.
from datetime import datetime, timezone  # For timestamping queue entries.

# Paths are relative to the project root, not this file's location.
# Why? So you can run the script from any directory using `python -m src.main`.
QUEUE_PATH = "data/review_queue.json"
PUBLISHED_PATH = "data/published.json"
EXAMPLES_PATH = "data/approved_examples.json"


def _load_json(path: str, default):
    """
    Load a JSON file, returning `default` if the file doesn't exist yet.
    Why a helper? DRY — every load call needs the same try/except pattern.
    """
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def _save_json(path: str, data) -> None:
    """
    Save data to a JSON file atomically.

    Steps:
      1. Write to a temp file in the same directory (same filesystem = fast rename).
      2. os.replace() atomically swaps the temp file into place.
    If step 1 fails, the original file is untouched.
    If step 2 fails (extremely rare), worst case is a leftover temp file — not corruption.
    """
    # Ensure the directory exists before writing.
    os.makedirs(os.path.dirname(path), exist_ok=True)
    # NamedTemporaryFile with delete=False so we control when it's removed.
    dir_name = os.path.dirname(path)
    with tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", dir=dir_name, delete=False, suffix=".tmp"
    ) as tmp:
        json.dump(data, tmp, indent=2, ensure_ascii=False)
        tmp_path = tmp.name  # Save the temp path before closing.
    # Atomic rename: the OS does this as a single syscall.
    os.replace(tmp_path, path)


# ---------------------------------------------------------------------------
# REVIEW QUEUE
# ---------------------------------------------------------------------------

def load_queue() -> list:
    """Load all items currently waiting for human review."""
    return _load_json(QUEUE_PATH, [])


def add_to_queue(entry: dict) -> None:
    """
    Append one entry to the review queue.

    Why append-only rather than update-in-place?
    Queues are naturally append-only. If we need to update (approve/reject),
    we load the full list, modify the matching entry, and save — which is
    what update_queue_item() does below.
    """
    queue = load_queue()
    # Stamp every entry with an ISO 8601 UTC timestamp for traceability.
    entry["queued_at"] = datetime.now(timezone.utc).isoformat()
    queue.append(entry)
    _save_json(QUEUE_PATH, queue)


def update_queue_item(comment_id: str, updates: dict) -> bool:
    """
    Find the queue item with the given comment_id and merge `updates` into it.
    Returns True if found, False if not found.

    Why merge (dict.update) rather than replace?
    The existing entry has the original draft, safety label, etc.
    We want to ADD the reviewer decision on top — not erase the history.
    """
    queue = load_queue()
    for item in queue:
        if item.get("comment_id") == comment_id:
            item.update(updates)  # Non-destructive merge.
            _save_json(QUEUE_PATH, queue)
            return True
    return False


def get_pending_items() -> list:
    """Return only items that haven't been reviewed yet."""
    # Why filter here rather than in the caller?
    # Callers shouldn't know about the internal "status" field schema.
    # This is the single place that knows what "pending" means.
    return [item for item in load_queue() if item.get("status") == "pending"]


# ---------------------------------------------------------------------------
# PUBLISHED LOG
# ---------------------------------------------------------------------------

def load_published() -> dict:
    """
    Load the published log as a dict keyed by comment_id.
    Why a dict (not a list)?
    O(1) lookup for duplicate detection — see publish_reply() below.
    """
    return _load_json(PUBLISHED_PATH, {})


def publish_reply(comment_id: str, reply_text: str) -> bool:
    """
    Mock-publish a reply. Handles duplicates safely.

    Why check for duplicates?
    The assignment explicitly requires it. In a real system, double-publishing
    a reply to Twitter would be embarrassing and potentially spam-flagged.

    Returns True if published (new), False if already published (duplicate).
    """
    published = load_published()

    if comment_id in published:
        # Already published — silently return False. Do NOT raise an exception.
        # Why? Duplicate attempts shouldn't crash the workflow; they should just no-op.
        return False

    published[comment_id] = {
        "reply": reply_text,
        "published_at": datetime.now(timezone.utc).isoformat(),
        "mock": True,  # Explicit marker that this is a simulation, not a real post.
    }
    _save_json(PUBLISHED_PATH, published)
    return True


# ---------------------------------------------------------------------------
# LEARNING SIGNAL — APPROVED EXAMPLES
# ---------------------------------------------------------------------------

def load_examples() -> list:
    """Load previously approved or edited examples for few-shot prompting."""
    return _load_json(EXAMPLES_PATH, [])


def save_example(comment_text: str, approved_reply: str) -> None:
    """
    Save an approved (or human-edited) reply as a few-shot example.

    Why save edited replies specifically?
    If a reviewer edits a draft, that edit IS the ground truth for what
    good looks like. Capturing it means future drafts get better over time.
    This is the "minimal learning signal" the assignment asks for.

    We cap at 50 examples to avoid the few-shot section growing unbounded
    and eating into the model's context window.
    """
    examples = load_examples()
    examples.append({"comment": comment_text, "reply": approved_reply})
    # Keep only the most recent 50 — a simple sliding window.
    examples = examples[-50:]
    _save_json(EXAMPLES_PATH, examples)