"""
triage.py

Sits BEFORE the drafter in the pipeline. Asks a cheap LLM call:
"Is this comment worth replying to at all?"

Returns one of three categories:
  - "reply"   → normal comment, proceed to draft
  - "skip"    → reaction noise (e.g. "🔥", "nice", one-word praise),
                 not worth a public reply
  - "monitor" → needs human attention but no reply yet (e.g. off-topic
                 legal threat, journalist fishing for a quote)

Design decision: We use a separate, cheaper prompt rather than folding this
into the drafter's system prompt.
Why? Because triage runs on EVERY comment, including ones we'll ultimately skip.
Keeping it as a fast, structured JSON call (max_tokens=50) means low cost
and low latency. We never want to pay for a full draft on spam or one-word reactions.

Design decision: We return a structured dict, not just a string label.
Why? So the caller gets both the label AND the reason — useful for the reviewer
log and for debugging why a comment was skipped.
"""

import os
import json

try:
    import anthropic
    ANTHROPIC_AVAILABLE = True
except ImportError:
    ANTHROPIC_AVAILABLE = False


# The triage prompt is intentionally minimal.
# We do NOT inject the full brand voice here — triage only needs to answer
# one binary question: "is this worth a reply?"
# Smaller prompt = faster response = lower cost per comment.
TRIAGE_SYSTEM_PROMPT = """You are a social media triage classifier for a B2B SaaS company called Forcivate.

Your job: classify whether a comment on a company social media post is worth replying to.

Return ONLY a JSON object with exactly two keys:
  "label": one of "reply", "skip", or "monitor"
  "reason": one sentence explaining your choice

Label definitions:
  "reply"   → The comment asks a question, gives feedback, shares an experience,
               or engages meaningfully. We should respond.
  "skip"    → The comment is purely a reaction (emoji-only, one-word praise like
               "nice" or "congrats", generic filler). Replying adds no value.
  "monitor" → The comment is unusual and needs a human to decide — e.g. a legal
               threat, a journalist asking for a quote, or something deeply ambiguous.
               Do NOT reply yet.

CRITICAL: Return only valid JSON. No preamble, no explanation outside the JSON object."""


def triage_comment(comment_text: str, post_text: str) -> dict:
    """
    Classify a single comment.

    Parameters:
      comment_text: the raw comment from the user
      post_text:    the original post the comment is on (gives the LLM context)

    Returns a dict with:
      "label":  str — "reply", "skip", or "monitor"
      "reason": str — one-sentence explanation
      "source": str — "llm" or "mock" (so callers know how this was produced)

    Design decision: we pass post_text to the LLM.
    Why? A comment like "yes, definitely" means nothing without the post context.
    The LLM needs to know what the person is agreeing with to judge reply-worthiness.
    """
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")

    # Fallback to mock if no API key or library missing.
    # The mock always says "reply" so no comments are incorrectly skipped during testing.
    if not ANTHROPIC_AVAILABLE or not api_key or api_key == "mock":
        return _mock_triage(comment_text)

    client = anthropic.Anthropic(api_key=api_key)

    user_message = (
        f"Original post:\n{post_text}\n\n"
        f"Comment to classify:\n{comment_text}\n\n"
        f"Classify this comment."
    )

    try:
        response = client.messages.create(
            model="claude-haiku-4-5-20251001",  # Haiku: fastest + cheapest — appropriate for a classifier.
                                                 # We don't need Sonnet's reasoning depth here;
                                                 # this is a simple three-way classification.
            max_tokens=80,   # JSON label + one-sentence reason fits in 80 tokens easily.
                              # Setting a hard cap prevents runaway completions on weird inputs.
            system=TRIAGE_SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_message}],
        )

        raw = response.content[0].text.strip()

        # Parse the JSON response.
        # Why try/except around json.loads specifically?
        # The model might occasionally output slightly malformed JSON despite the prompt.
        # We catch that case and fall back to "reply" — fail open, not closed.
        # It's better to process a borderline comment than to silently drop it.
        try:
            result = json.loads(raw)
            label = result.get("label", "reply")
            reason = result.get("reason", "No reason provided.")

            # Validate the label is one of the three expected values.
            # If the model hallucinated a different label, default to "reply".
            if label not in ("reply", "skip", "monitor"):
                label = "reply"
                reason = f"[Triage returned unexpected label — defaulted to reply] {reason}"

            return {"label": label, "reason": reason, "source": "llm"}

        except json.JSONDecodeError:
            # The model didn't return valid JSON — default to "reply" (fail open).
            return {
                "label": "reply",
                "reason": f"[Triage JSON parse failed — defaulted to reply] Raw: {raw[:80]}",
                "source": "llm",
            }

    except Exception as e:
        # Network error, API error, etc. — always fail open.
        return {
            "label": "reply",
            "reason": f"[Triage API error — defaulted to reply] {str(e)[:80]}",
            "source": "llm",
        }


def _mock_triage(comment_text: str) -> dict:
    """
    Rule-based mock triage for when no API key is available.

    Why not just return "reply" for everything in the mock?
    Because then the triage step would be untestable without a key.
    This mock exercises the skip and monitor paths using simple heuristics,
    so developers can verify the pipeline handles all three labels correctly.
    """
    text = comment_text.strip()

    # Very short comments (≤3 words) that are all emoji or single words → skip.
    # Why word count and not character count?
    # "🔥🔥🔥" is 3 chars but clearly a reaction. "No" is 2 chars but might need a reply.
    # Word count + emoji check is more semantically accurate.
    words = text.split()
    if len(words) <= 2:
        return {
            "label": "skip",
            "reason": "Comment is too short to warrant a reply (mock heuristic).",
            "source": "mock",
        }

    # Comments mentioning "legal" or "lawyer" → monitor.
    if any(w in text.lower() for w in ["legal", "lawyer", "lawsuit", "sue"]):
        return {
            "label": "monitor",
            "reason": "Comment contains legal language — needs human review before reply (mock heuristic).",
            "source": "mock",
        }

    return {
        "label": "reply",
        "reason": "Comment appears to warrant a reply (mock heuristic).",
        "source": "mock",
    }