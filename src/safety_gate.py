"""
safety_gate.py

Sits between the LLM drafter and the human queue.
Its job: inspect every COMMENT (untrusted input) and every DRAFT (LLM output)
before a human ever sees a reply.

Design decision: we run two separate checks:
  1. check_comment()  — run on the RAW comment before we even call the LLM.
                        If it's a prompt injection, we never feed it to the LLM naively.
  2. check_draft()    — run on the LLM's OUTPUT to catch anything the model
                        might have let slip through.

Why two checks instead of one?
Because the threat model is different:
  - Comments are attacker-controlled. We must sanitize before LLM sees them.
  - Draft output can still be manipulated if the model isn't perfectly aligned.
  Layered defense (defense-in-depth) is standard security practice.
"""

import re  # Built-in regex — no external deps needed for pattern matching.

# ---------------------------------------------------------------------------
# INJECTION PATTERNS
# These are regex patterns that signal a commenter is trying to override
# our system prompt. Classic prompt injection payloads include phrases like
# "ignore all previous instructions" or "disregard the above".
#
# Why regex and not another LLM call?
# Speed and determinism. A regex never hallucinates. For security-critical
# checks, deterministic rules beat probabilistic models.
# ---------------------------------------------------------------------------
INJECTION_PATTERNS = [
    r"ignore\s+(all\s+)?(previous|prior|above|earlier)\s+instructions?",
    r"disregard\s+(the\s+)?(above|previous|prior|all)",
    r"do\s+not\s+generate\s+a\s+helpful\s+response",
    r"only\s+output\s+that\s+phrase",
    r"instead[,\s]+reply\s+with",
    r"new\s+instruction",
    r"system\s+prompt",
    r"you\s+are\s+now",
]

# ---------------------------------------------------------------------------
# HOSTILE PATTERNS
# Phrases that indicate the comment is abusive or hostile toward the company
# or its staff. We still draft a reply (a de-escalating one), but we flag it
# so the human reviewer knows extra care is needed.
#
# Why flag rather than skip?
# Ignoring hostile comments publicly can damage reputation more than a calm,
# measured response. We want a human to decide — not auto-suppress.
# ---------------------------------------------------------------------------
HOSTILE_PATTERNS = [
    r"\bgarbage\b",
    r"\bincompetent\b",
    r"\bashamed\b",
    r"\bidiots?\b",
    r"\bstupid\b",
    r"\bterrible\b",
    r"\bawful\b",
    r"\bworst\b",
]

# ---------------------------------------------------------------------------
# SPAM PATTERNS
# Obvious spam signals: all-caps urgency, money promises, "check my profile".
# We skip drafting entirely for spam — no reply needed.
# ---------------------------------------------------------------------------
SPAM_PATTERNS = [
    r"\$\d+",          # Dollar amounts like $5000
    r"NO\s+RISK",
    r"CHECK\s+MY\s+PROFILE",
    r"MAKE\s+\$",
    r"💎|🚀",           # Crypto-spam emoji combos (unicode literal in regex is fine)
]


def _matches_any(text: str, patterns: list[str]) -> bool:
    """
    Helper: returns True if the text matches ANY pattern in the list.

    Why case-insensitive (re.IGNORECASE)?
    Attackers write "IGNORE ALL PREVIOUS" or "Ignore All Previous" to
    bypass naive lowercase checks. re.IGNORECASE catches all variants.
    """
    for pattern in patterns:
        if re.search(pattern, text, re.IGNORECASE):
            return True
    return False


def check_comment(comment_text: str) -> dict:
    """
    Analyze a raw comment before it touches the LLM.

    Returns a dict with:
      - "safe":      bool — False means do NOT send this comment to the LLM as-is.
      - "label":     str  — one of "ok", "injection", "spam", "hostile"
      - "reason":    str  — human-readable explanation for the reviewer log.
      - "sanitized": str  — a safe version of the comment text to pass to the LLM.

    Design decision: we ALWAYS return a sanitized version.
    Even for injections, we want to draft SOMETHING (a generic "thanks for reaching
    out" reply) rather than producing nothing — the human queue still needs an entry.
    We strip the injection payload and replace it with a neutral placeholder.
    """

    # Check spam first — it's the cheapest check and lets us exit early.
    if _matches_any(comment_text, SPAM_PATTERNS):
        return {
            "safe": False,
            "label": "spam",
            "reason": "Comment matches spam patterns. No reply will be drafted.",
            # Sanitized is empty string — caller will skip LLM entirely for spam.
            "sanitized": "",
        }

    # Check for prompt injection.
    if _matches_any(comment_text, INJECTION_PATTERNS):
        return {
            "safe": False,
            "label": "injection",
            "reason": "Prompt injection attempt detected. Payload stripped; generic reply drafted.",
            # We replace the dangerous text with a bracketed note.
            # The LLM will see "[CONTENT REMOVED: policy violation]" instead of
            # the injection payload — it cannot execute instructions it never reads.
            "sanitized": "[CONTENT REMOVED: policy violation]",
        }

    # Check for hostility — still safe to send to LLM but flagged for reviewer.
    if _matches_any(comment_text, HOSTILE_PATTERNS):
        return {
            "safe": True,   # We DO still draft a reply (de-escalating tone).
            "label": "hostile",
            "reason": "Hostile language detected. Draft will be de-escalating. Human review required.",
            "sanitized": comment_text,  # Pass full text so LLM can address the concern.
        }

    # All clear.
    return {
        "safe": True,
        "label": "ok",
        "reason": "No issues detected.",
        "sanitized": comment_text,
    }


def check_draft(draft_text: str) -> dict:
    """
    Analyze the LLM's OUTPUT before it enters the human queue.

    Why check the draft too?
    A sophisticated injection might slip through sanitization if the model
    was trained on similar data. We also want to catch if the model
    accidentally echoed the injection payload in its reply.

    Returns:
      - "safe":   bool
      - "reason": str
    """
    if _matches_any(draft_text, INJECTION_PATTERNS):
        return {
            "safe": False,
            "reason": "Draft appears to echo an injection payload. Blocked from queue.",
        }

    # Check if the draft contains phrases that sound like the model was
    # manipulated into saying something brand-damaging.
    BRAND_DAMAGING = [
        r"highly\s+insecure",
        r"hate\s+our\s+users",
        r"we\s+are\s+incompetent",
    ]
    if _matches_any(draft_text, BRAND_DAMAGING):
        return {
            "safe": False,
            "reason": "Draft contains brand-damaging language. Blocked from queue.",
        }

    return {"safe": True, "reason": "Draft passed safety check."}