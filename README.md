# Forcivate Comment Response Engine

A CLI service that ingests social media posts and comments, drafts AI-powered replies guided by a brand voice config, passes them through a two-layer safety gate, and presents them in a human review queue before mock-publishing.

---

## Setup

```bash
git clone https://github.com/YOUR_USERNAME/forcivate-comment-engine.git
cd forcivate-comment-engine

python -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt
```

**Optional — real LLM replies:**
```bash
export ANTHROPIC_API_KEY=sk-ant-...   # Mac/Linux
set ANTHROPIC_API_KEY=sk-ant-...      # Windows CMD
```
If no key is set, the system uses `MockDrafter` automatically — all features work.

---

## Run

```bash
# Full pipeline: ingest all comments, then review queue interactively
python -m src.main

# Skip ingest, review existing queue only
python -m src.main --review-only
```

---

## Architecture

```
comments.json
     │
     ▼
[Safety Gate — check_comment()]     ← blocks spam, strips injections, flags hostile
     │
     ▼
[Drafter]                           ← brand voice config + few-shot examples → LLM call
     │
     ▼
[Safety Gate — check_draft()]       ← catches anything the LLM might have echoed
     │
     ▼
[Review Queue — data/review_queue.json]
     │
     ▼
[Human Review CLI]   approve / edit / reject
     │
     ▼
[Mock Publish — data/published.json]  +  [Learning Examples — data/approved_examples.json]
```

### Key Design Decisions

| Decision | Why |
|---|---|
| Brand voice as JSON config, not hardcoded strings | Voice changes without touching code |
| Two-layer safety gate (input + output) | Defense-in-depth; model output isn't trusted either |
| Spam → skip entirely, no queue entry | No reviewer time wasted on obvious spam |
| Injection → strip payload, draft generic reply | Still produces a reviewable entry without executing attacker instructions |
| Atomic file writes (tempfile + os.replace) | Crash-safe — no corrupted JSON |
| `get_drafter()` factory function | Swap LLM provider in one place |
| Few-shot examples capped at 50 | Prevents context window bloat |

---

## What I'd Improve With More Time

- **SQLite instead of JSON files** — concurrent access, proper indexing, no load-whole-file-to-update pattern.
- **Triage step** — use a cheap classifier call to skip comments genuinely not worth replying to (e.g., one-word reactions like "nice").
- **Risk-tiered queue** — auto-approve comments labeled "ok" with high confidence; only surface hostile/injection to humans.
- **Web UI** — replace the CLI review loop with a simple Flask/FastAPI page with approve/reject buttons.
- **Async batch drafting** — `asyncio` + `aiohttp` to draft all comments in parallel rather than serially.
- **Tests** — `pytest` unit tests for the safety gate patterns and drafter mock, integration test for the full pipeline.
- **Rate limiting** — exponential backoff on the Anthropic API calls.

---

## Data Files (auto-generated, gitignored)

| File | Contents |
|---|---|
| `data/review_queue.json` | All queue entries with status |
| `data/published.json` | Mock-published replies |
| `data/approved_examples.json` | Few-shot learning examples |
