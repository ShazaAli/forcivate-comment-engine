/**
 * App.tsx
 *
 * The human review dashboard for the comment moderation queue.
 *
 * Design Decision Justifications:
 * - Single Component Architecture: Keeping the interface in a single file reduces project overhead
 *   for a time-boxed engineering assignment, maximizing structural visibility and simplicity. A
 *   real production app would split this into smaller components (QueueItem, Badge, EditPanel), but
 *   for a focused review queue with one screen, splitting adds indirection without adding clarity.
 * - Explicit TypeScript Interfaces: Aligns with the database schema contracts (ReviewItem mirrors
 *   queueRepository.ts's ReviewItem) to catch typos at compile time rather than at runtime.
 * - Local Optimistic State Invalidation: Items are removed from the local array immediately after the
 *   API confirms a decision, rather than re-fetching the whole queue. This avoids an extra round trip
 *   and keeps the UI feeling instant.
 * - Inline style objects instead of CSS modules or a styling library: this is a single-file dashboard
 *   with no shared design system to reuse across pages, so a separate stylesheet would only add an
 *   extra file to keep in sync with zero reuse benefit. Defining the style objects as plain JS objects
 *   keeps colors, spacing, and the JSX that uses them in one place.
 */

import { useState, useEffect } from "react";

// Mirrors the Express API response shape exactly (see backend/src/db/queueRepository.ts's
// ReviewItem interface). Why not import the type directly from the backend package?
// The frontend and backend are separate npm projects with no shared package boundary in this
// setup — duplicating the shape here is the simplest option for a two-package project this size.
// A monorepo with a shared `types` package would remove the duplication if this grew further.
interface ReviewItem {
  comment_id: string;
  post_id: string;
  platform: string;
  author: string;
  original_comment: string;
  triage_label: string;
  triage_reason: string;
  safety_label: string;
  safety_reason: string;
  draft: string;
  status: string;
}

export default function App() {
  // --- STATE MANAGEMENT ---

  // The queue itself. Why an array in component state rather than a global store (Redux, Zustand)?
  // This is a single-screen dashboard with no state shared across routes or components — local
  // useState is the simplest tool that does the job. A global store would be unjustified overhead.
  const [queue, setQueue] = useState<ReviewItem[]>([]);

  // Loading and error are separate booleans/strings rather than one combined "status" enum.
  // Why? Because they're not mutually exclusive in time — we can be re-fetching (loading=true)
  // after a previous error, and want the error message to clear immediately rather than linger
  // alongside a fresh loading spinner. Two independent flags model that more simply than one enum.
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Tracks which specific item is currently in "Edit Mode". Why store the id rather than a boolean
  // per item? Only one item can be edited at a time in this UI, so a single "which one" value is
  // simpler than an array of per-item edit flags, and it naturally prevents editing two items at once.
  const [editingId, setEditingId] = useState<string | null>(null);
  // Holds the in-progress text while editing. Kept separate from the queue item itself so that
  // typing in the textarea doesn't mutate `queue` directly — the edit is only committed to state
  // (and to the server) when the reviewer explicitly clicks "Commit Changes & Approve".
  const [editText, setEditText] = useState<string>("");

  // Tracks which single item currently has a decision request in flight.
  // Why a single id rather than a per-item boolean map?
  // The UI only ever lets one decision happen at a time in practice (each button click disables
  // its own card), so a single "which item is processing" value is enough to drive every disabled
  // state below without a more complex per-item map for a small queue.
  const [processingId, setProcessingId] = useState<string | null>(null);

  // --- API DATA FETCHING ---
  const fetchQueue = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await fetch("http://localhost:3001/api/queue");
      if (!response.ok) {
        // Why throw here instead of just setting `error` directly?
        // Throwing lets the catch block below be the single place that sets error state,
        // regardless of whether the failure was a network error or a non-2xx response.
        throw new Error(`Server returned status code: ${response.status}`);
      }
      const data = await response.json();
      // The API returns the queue as a plain JSON array (see server.ts: res.json(items)) — not
      // wrapped in an envelope object. Earlier manual testing via PowerShell's
      // `Invoke-RestMethod | ConvertTo-Json` made it look like a { value: [...], Count: N } shape,
      // but that wrapping is added by PowerShell's own JSON formatting, not by the API itself.
      // Array.isArray() defends against any future shape change silently breaking the UI instead
      // of throwing a confusing ".filter is not a function" error deep in the render logic.
      setQueue(Array.isArray(data) ? data : []);
    } catch (err: any) {
      console.error("Queue fetch failed:", err);
      setError(err.message || "Unable to sync with the backend review API server.");
    } finally {
      // Why `finally` instead of setting loading=false in both the try and catch blocks?
      // It guarantees the loading state always clears exactly once, even if a future edit to this
      // function adds another return path — one less place to forget to reset a flag.
      setLoading(false);
    }
  };

  // Why fetch once on mount with an empty dependency array, rather than polling on an interval?
  // This is a single-reviewer local demo, not a multi-user production system — polling for live
  // updates from other reviewers isn't needed yet. Noted in the README under "What I'd improve."
  useEffect(() => {
    fetchQueue();
  }, []);

  // --- REVIEW ACTION ROUTER ---
  // Why one function handling approve/edit/reject rather than three separate handlers?
  // This mirrors the backend's design: server.ts exposes one POST /decision endpoint with a
  // `decision` field rather than three routes, because all three are the same underlying action
  // — "resolve this item" — with shared validation and shared cleanup. Splitting the frontend
  // handler into three would duplicate the try/catch/finally and the optimistic-eviction logic.
  const handleDecision = async (
    commentId: string,
    decision: "approve" | "reject" | "edit",
    customText?: string
  ) => {
    try {
      setProcessingId(commentId);

      // Why build the body conditionally rather than always sending replyText and reason?
      // The backend validates replyText is required only for "edit" and ignores extra fields
      // for "approve" — sending undefined fields is harmless, but omitting them keeps the
      // request payload honest about what each decision type actually needs.
      const bodyPayload: any = { decision };
      if (decision === "edit") {
        bodyPayload.replyText = customText;
      } else if (decision === "reject") {
        // Why a fixed reason string instead of an input field for the reviewer to type one?
        // The assignment's CLI version supports a free-text rejection reason; the web dashboard
        // simplifies this to a fixed string to keep the UI to a single click per decision rather
        // than an extra modal — a quick interaction-cost tradeoff. The backend still records it
        // in rejection_reason, so a future iteration could add a text field without changing the API.
        bodyPayload.reason = "Rejected via Human Review Panel Dashboard.";
      }

      const response = await fetch(`http://localhost:3001/api/queue/${commentId}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bodyPayload),
      });

      if (!response.ok) {
        // Why .catch(() => ({})) on the error body parse?
        // If the server crashed before producing JSON (e.g. a raw 500 with no body), trying to
        // parse it as JSON would throw a second, more confusing error that masks the original
        // HTTP failure. Falling back to an empty object means we always get to the message below.
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `Server returned error status: ${response.status}`);
      }

      // --- OPTIMISTIC EVICTION ---
      // Once the API confirms the decision succeeded, remove the item from local state immediately
      // rather than re-fetching the whole queue. Why is this safe here specifically?
      // Unlike a true "optimistic" update (which assumes success before the server responds), this
      // only fires after `response.ok` is confirmed true — so it's a confirmed update applied
      // locally to avoid a second network round trip, not a guess that could roll back on failure.
      setQueue((prevQueue) => prevQueue.filter((item) => item.comment_id !== commentId));

      // If the item being edited was the one just resolved, clear the edit UI state too —
      // otherwise the textarea and its buttons would linger pointing at an item no longer in the list.
      if (editingId === commentId) {
        setEditingId(null);
        setEditText("");
      }
    } catch (err: any) {
      // Why a plain `alert()` instead of an inline error banner per card?
      // Decision failures here are expected to be rare (mainly: item already resolved by a stale
      // page, or the server is down) and don't need a persistent UI element — a one-time alert is
      // enough to inform the reviewer without adding state to track per-card error messages.
      alert(`Decision Action Failed: ${err.message}`);
    } finally {
      setProcessingId(null);
    }
  };

  // --- RENDER CONDITIONALS ---
  // Why check loading and error as early returns rather than branching inside the main JSX tree?
  // Early returns keep the main render path below focused on the "happy path" — the list of
  // items — without nesting it three levels deep inside loading/error conditionals.
  if (loading) {
    return (
      <div style={styles.centerContainer}>
        <div style={styles.spinner}></div>
        <p>Syncing human review data layers...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div style={styles.centerContainer}>
        <div style={styles.errorAlert}>
          <strong>Backend Synchronization Error:</strong>
          <p>{error}</p>
          <button style={styles.primaryButton} onClick={fetchQueue}>Retry Connection</button>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      {/* Dashboard Top Header Control Panel */}
      <header style={styles.header}>
        <div>
          <h1 style={styles.title}>Forcivate Comment Moderation Panel</h1>
          <p style={styles.subtitle}>Human-in-the-Loop Safety Gate & AI Draft Reviewer</p>
        </div>
        {/* Why queue.length rather than a separate counter fetched from the API?
            The count IS the array length on the client — fetching a separate count would just be
            a second source of truth that could drift from what's actually rendered below. */}
        <div style={styles.badgeCount}>
          <strong>{queue.length}</strong> Pending Items
        </div>
      </header>

      <hr style={styles.divider} />

      {/* Queue State List Container */}
      {queue.length === 0 ? (
        <div style={styles.emptyState}>
          <h3>✨ Review Queue is Clear</h3>
          <p>All system comments have been fully triaged, evaluated, and published safely.</p>
          {/* Manual refresh button rather than auto-polling — see the useEffect comment above
              for why polling was deliberately left out for this local single-reviewer demo. */}
          <button style={styles.secondaryButton} onClick={fetchQueue}>Refresh Queue</button>
        </div>
      ) : (
        <div style={styles.list}>
          {queue.map((item) => {
            const isItemProcessing = processingId === item.comment_id;
            const isEditingThisItem = editingId === item.comment_id;

            return (
              <div key={item.comment_id} style={styles.card}>

                {/* Meta Header Information Section */}
                <div style={styles.cardHeader}>
                  <div>
                    <span style={styles.authorBadge}>{item.author}</span>
                    <span style={styles.platformBadge}>{item.platform.toUpperCase()}</span>
                  </div>
                  <span style={styles.timestampBadge}>ID: {item.comment_id}</span>
                </div>

                {/* Meta Labels for Triage and Safety Status Flags.
                    Why inline color logic here instead of a shared getSafetyColor() helper?
                    Each badge's color depends on a different field with different "good" values
                    (safety_label === "ok" vs triage_label === "reply") — two tiny one-line ternaries
                    inline are clearer to read at the call site than two near-identical helper
                    functions that only get called once each. */}
                <div style={styles.badgeRow}>
                  <span style={{
                    ...styles.statusBadge,
                    backgroundColor: item.safety_label === "ok" ? "#1b4332" : "#7f1d1d",
                    color: item.safety_label === "ok" ? "#52b788" : "#fca5a5"
                  }}>
                    🛡️ Safety: {item.safety_label.toUpperCase()}
                  </span>
                  <span style={{
                    ...styles.statusBadge,
                    backgroundColor: item.triage_label === "reply" ? "#1e3a8a" : "#374151",
                    color: item.triage_label === "reply" ? "#93c5fd" : "#d1d5db"
                  }}>
                    🎯 Triage: {item.triage_label.toUpperCase()}
                  </span>
                </div>

                {/* Split Context Section: Post context vs Raw Untrusted Inbound Comment.
                    Why labeled "Inbound Untrusted User Comment" explicitly in the UI?
                    This mirrors the same principle as the Python safety gate and the comment in
                    server.ts: comment text is untrusted input. Labeling it as such in the reviewer
                    UI keeps that mental model visible to the human in the loop, not just in code
                    comments nobody reviewing the dashboard will ever see. */}
                <div style={styles.contextBox}>
                  <div style={styles.contextColumn}>
                    <h5 style={styles.contextHeading}>Original Parent Post Context</h5>
                    <p style={styles.contextText}>{item.post_id || "No parent post metadata linked."}</p>
                  </div>
                  <div style={styles.contextColumn}>
                    <h5 style={styles.contextHeading}>Inbound Untrusted User Comment</h5>
                    <p style={styles.commentText}>"{item.original_comment}"</p>
                    {/* Only show the safety_reason line if one exists — "ok" items still have a
                        reason string ("No issues detected"), so this mainly guards against any
                        future item that omits the field entirely rather than hiding it for safe items. */}
                    {item.safety_reason && (
                      <p style={styles.reasonText}>⚠️ <em>Reasoning: {item.safety_reason}</em></p>
                    )}
                  </div>
                </div>

                {/* Actionable Generation Workspace Area */}
                <div style={styles.draftWorkspace}>
                  <h4 style={styles.workspaceTitle}>Generated Response Draft Workspace</h4>

                  {isEditingThisItem ? (
                    <div style={styles.editorContainer}>
                      <textarea
                        style={styles.textarea}
                        value={editText}
                        onChange={(e) => setEditText(e.target.value)}
                        placeholder="Rewrite draft reply text securely here..."
                        disabled={isItemProcessing}
                      />
                      <div style={styles.editorActions}>
                        <button
                          style={styles.saveButton}
                          // Why disable on !editText.trim() in addition to isItemProcessing?
                          // Mirrors the backend's own validation in server.ts (replyText must be a
                          // non-empty, non-whitespace string for an "edit" decision) — catching it
                          // here means the reviewer gets instant feedback instead of a round trip
                          // to the server just to learn the empty edit was rejected.
                          disabled={isItemProcessing || !editText.trim()}
                          onClick={() => handleDecision(item.comment_id, "edit", editText)}
                        >
                          {isItemProcessing ? "Saving..." : "💾 Commit Changes & Approve"}
                        </button>
                        <button
                          style={styles.cancelButton}
                          disabled={isItemProcessing}
                          onClick={() => {
                            setEditingId(null);
                            setEditText("");
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div>
                      <div style={styles.draftBlob}>
                        {item.draft || <em style={{ color: "#888" }}>No response draft was generated for this layout.</em>}
                      </div>

                      {/* Interactive Trigger Control Layout.
                          Why disable ALL three buttons (not just the one clicked) while processing?
                          A reviewer could otherwise click "Edit" while "Approve" is still in flight
                          for the same item, sending two conflicting decisions to the same comment_id.
                          The backend's status check (item.status !== "pending" etc.) would catch
                          this server-side with a 409, but disabling client-side avoids the wasted
                          request and the confusing error entirely. */}
                      <div style={styles.actionRow}>
                        <button
                          style={styles.approveButton}
                          disabled={isItemProcessing}
                          onClick={() => handleDecision(item.comment_id, "approve")}
                        >
                          {isItemProcessing && editingId !== item.comment_id ? "Processing..." : "✅ Fast Approve"}
                        </button>

                        <button
                          style={styles.editTriggerButton}
                          disabled={isItemProcessing}
                          onClick={() => {
                            setEditingId(item.comment_id);
                            // Pre-fill the textarea with the existing draft rather than starting
                            // blank — editing is almost always a tweak to the AI's draft, not a
                            // reply written from scratch, so starting from the draft text saves
                            // the reviewer from re-typing it.
                            setEditText(item.draft || "");
                          }}
                        >
                          📝 Edit Response
                        </button>

                        <button
                          style={styles.rejectButton}
                          disabled={isItemProcessing}
                          onClick={() => handleDecision(item.comment_id, "reject")}
                        >
                          ❌ Reject / Drop
                        </button>
                      </div>
                    </div>
                  )}
                </div>

              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// --- STYLE DEFINITIONS ---
// Why a single `styles` object keyed by purpose (card, badgeRow, draftBlob, etc.) rather than
// styled-components or Tailwind classes? No build-time CSS tooling needs configuring beyond what
// Vite already provides, and the dark theme's palette (slate/blue) only needs to be defined once
// here and reused by reference — adding Tailwind for a single-file dashboard this size would be
// a dependency with no real payoff.
const styles: Record<string, React.CSSProperties> = {
  container: {
    maxWidth: "1000px",
    margin: "40px auto",
    padding: "0 24px",
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    color: "#e2e8f0",
    backgroundColor: "#0f172a",
    minHeight: "100vh",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    paddingTop: "20px",
  },
  title: {
    fontSize: "2rem",
    fontWeight: 800,
    margin: 0,
    color: "#f8fafc",
    letterSpacing: "-0.025em",
  },
  subtitle: {
    margin: "4px 0 0 0",
    color: "#94a3b8",
    fontSize: "1rem",
  },
  badgeCount: {
    backgroundColor: "#1e293b",
    color: "#38bdf8",
    padding: "8px 16px",
    borderRadius: "20px",
    fontSize: "0.95rem",
    fontWeight: 600,
    border: "1px solid #334155",
  },
  divider: {
    border: 0,
    borderTop: "1px solid #334155",
    margin: "24px 0 32px 0",
  },
  centerContainer: {
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    alignItems: "center",
    minHeight: "80vh",
    backgroundColor: "#0f172a",
    color: "#94a3b8",
    fontFamily: "sans-serif",
  },
  spinner: {
    width: "40px",
    height: "40px",
    border: "4px solid #334155",
    borderTop: "4px solid #38bdf8",
    borderRadius: "50%",
    animation: "spin 1s linear infinite",
    marginBottom: "16px",
  },
  errorAlert: {
    backgroundColor: "#451a03",
    border: "1px solid #78350f",
    color: "#fef3c7",
    padding: "24px",
    borderRadius: "12px",
    maxWidth: "500px",
    textAlign: "center",
  },
  emptyState: {
    textAlign: "center",
    padding: "64px 32px",
    backgroundColor: "#1e293b",
    borderRadius: "16px",
    border: "1px dashed #475569",
    color: "#94a3b8",
  },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: "24px",
  },
  card: {
    backgroundColor: "#1e293b",
    borderRadius: "14px",
    border: "1px solid #334155",
    padding: "24px",
    boxShadow: "0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)",
  },
  cardHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: "14px",
  },
  authorBadge: {
    fontWeight: 700,
    color: "#f8fafc",
    fontSize: "1.05rem",
    marginRight: "10px",
  },
  platformBadge: {
    backgroundColor: "#334155",
    color: "#cbd5e1",
    fontSize: "0.75rem",
    fontWeight: 700,
    padding: "3px 8px",
    borderRadius: "6px",
    letterSpacing: "0.05em",
  },
  timestampBadge: {
    color: "#64748b",
    fontSize: "0.85rem",
    fontFamily: "monospace",
  },
  badgeRow: {
    display: "flex",
    gap: "10px",
    marginBottom: "18px",
  },
  statusBadge: {
    fontSize: "0.8rem",
    fontWeight: 600,
    padding: "4px 10px",
    borderRadius: "8px",
  },
  contextBox: {
    display: "flex",
    gap: "20px",
    backgroundColor: "#0f172a",
    padding: "16px",
    borderRadius: "10px",
    border: "1px solid #1e293b",
    marginBottom: "20px",
  },
  contextColumn: {
    flex: 1,
  },
  contextHeading: {
    margin: "0 0 6px 0",
    fontSize: "0.75rem",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    color: "#64748b",
  },
  contextText: {
    margin: 0,
    fontSize: "0.9rem",
    color: "#94a3b8",
  },
  commentText: {
    margin: 0,
    fontSize: "0.95rem",
    color: "#e2e8f0",
    fontWeight: 500,
    fontStyle: "italic",
  },
  reasonText: {
    margin: "6px 0 0 0",
    fontSize: "0.8rem",
    color: "#cbd5e1",
  },
  draftWorkspace: {
    borderTop: "1px solid #334155",
    paddingTop: "18px",
  },
  workspaceTitle: {
    margin: "0 0 12px 0",
    fontSize: "0.95rem",
    fontWeight: 600,
    color: "#38bdf8",
  },
  draftBlob: {
    backgroundColor: "#0f172a",
    padding: "16px",
    borderRadius: "10px",
    borderLeft: "4px solid #38bdf8",
    fontSize: "1rem",
    lineHeight: "1.5",
    color: "#f1f5f9",
    marginBottom: "16px",
  },
  actionRow: {
    display: "flex",
    gap: "12px",
  },
  approveButton: {
    backgroundColor: "#16a34a",
    color: "#ffffff",
    border: 0,
    padding: "10px 18px",
    borderRadius: "8px",
    fontWeight: 600,
    cursor: "pointer",
    transition: "background 0.2s",
  },
  editTriggerButton: {
    backgroundColor: "#475569",
    color: "#ffffff",
    border: 0,
    padding: "10px 18px",
    borderRadius: "8px",
    fontWeight: 600,
    cursor: "pointer",
    transition: "background 0.2s",
  },
  rejectButton: {
    backgroundColor: "#dc2626",
    color: "#ffffff",
    border: 0,
    padding: "10px 18px",
    borderRadius: "8px",
    fontWeight: 600,
    cursor: "pointer",
    transition: "background 0.2s",
  },
  editorContainer: {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
  },
  textarea: {
    backgroundColor: "#0f172a",
    color: "#f8fafc",
    border: "1px solid #38bdf8",
    borderRadius: "10px",
    padding: "14px",
    fontSize: "1rem",
    fontFamily: "inherit",
    minHeight: "100px",
    resize: "vertical",
  },
  editorActions: {
    display: "flex",
    gap: "12px",
  },
  saveButton: {
    backgroundColor: "#0284c7",
    color: "#ffffff",
    border: 0,
    padding: "10px 18px",
    borderRadius: "8px",
    fontWeight: 600,
    cursor: "pointer",
  },
  cancelButton: {
    backgroundColor: "transparent",
    color: "#94a3b8",
    border: "1px solid #475569",
    padding: "10px 18px",
    borderRadius: "8px",
    fontWeight: 600,
    cursor: "pointer",
  },
  primaryButton: {
    backgroundColor: "#38bdf8",
    color: "#0f172a",
    border: 0,
    padding: "10px 20px",
    borderRadius: "8px",
    fontWeight: 700,
    cursor: "pointer",
    marginTop: "12px",
  },
  secondaryButton: {
    backgroundColor: "#334155",
    color: "#f8fafc",
    border: 0,
    padding: "10px 20px",
    borderRadius: "8px",
    fontWeight: 600,
    cursor: "pointer",
    marginTop: "12px",
  },
};
