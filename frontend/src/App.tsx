/**
 * App.tsx
 * * Design Decision Justifications:
 * - Single Component Architecture: Keeping the interface in a single file reduces project overhead
 * for a time-boxed engineering interview, maximizing structural visibility and simplicity.
 * - Explicit TypeScript Interfaces: Aligns perfectly with the database schema contracts to catch typos.
 * - Local Optimistic State Invalidation: Items are immediately filtered from view upon processing,
 * delivering an instantaneous, responsive user interface without requiring heavy polling layers.
 */

import { useState, useEffect } from "react";

// Mirror the Express API response contract exactly for compile-time safety checks.
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
  const [queue, setQueue] = useState<ReviewItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Tracks which specific item is currently in "Edit Mode"
  const [editingId, setEditingId] = useState<string | null>(null);
  // Holds temporary text modifications during an active inline edit session
  const [editText, setEditText] = useState<string>("");

  // Tracks individual action loading spinners to prevent double clicks during network roundtrips
  const [processingId, setProcessingId] = useState<string | null>(null);

  // --- API DATA FETCHING ---
  const fetchQueue = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await fetch("http://localhost:3001/api/queue");
      if (!response.ok) {
        throw new Error(`Server returned status code: ${response.status}`);
      }
      const data = await response.json();
      // Safely access the 'value' array payload sent by the Express API layer
      // The API returns the queue as a plain JSON array (see server.ts:
      // res.json(items)) — not wrapped in an envelope object. Earlier testing
      // via PowerShell's Invoke-RestMethod | ConvertTo-Json made it look like
      // a { value: [...], Count: N } shape, but that wrapping is added by
      // PowerShell's own JSON formatting, not by the API itself.
      setQueue(Array.isArray(data) ? data : []);
    } catch (err: any) {
      console.error("Queue fetch failed:", err);
      setError(err.message || "Unable to sync with the backend review API server.");
    } finally {
      setLoading(false);
    }
  };

  // Run the fetch operation on mount to populate the review queue dashboard immediately
  useEffect(() => {
    fetchQueue();
  }, []);

  // --- REVIEW ACTION ROUTER ---
  const handleDecision = async (
    commentId: string,
    decision: "approve" | "reject" | "edit",
    customText?: string
  ) => {
    try {
      setProcessingId(commentId);
      
      const bodyPayload: any = { decision };
      if (decision === "edit") {
        bodyPayload.replyText = customText;
      } else if (decision === "reject") {
        bodyPayload.reason = "Rejected via Human Review Panel Dashboard.";
      }

      const response = await fetch(`http://localhost:3001/api/queue/${commentId}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bodyPayload),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `Server returned error status: ${response.status}`);
      }

      // --- OPTIMISTIC EVICTION ---
      // Once the API database operation succeeds, immediately filter out the item locally.
      // This minimizes unnecessary asset downloads and eliminates visual lag.
      setQueue((prevQueue) => prevQueue.filter((item) => item.comment_id !== commentId));
      
      // Clean up local editing state focus points if the edited item was successfully pushed
      if (editingId === commentId) {
        setEditingId(null);
        setEditText("");
      }
    } catch (err: any) {
      alert(`Decision Action Failed: ${err.message}`);
    } finally {
      setProcessingId(null);
    }
  };

  // --- RENDER CONDITIONALS ---
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

                {/* Meta Labels for Triage and Safety Status Flags */}
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

                {/* Split Context Section: Post context vs Raw Untrusted Inbound Comment */}
                <div style={styles.contextBox}>
                  <div style={styles.contextColumn}>
                    <h5 style={styles.contextHeading}>Original Parent Post Context</h5>
                    <p style={styles.contextText}>{item.post_id || "No parent post metadata linked."}</p>
                  </div>
                  <div style={styles.contextColumn}>
                    <h5 style={styles.contextHeading}>Inbound Untrusted User Comment</h5>
                    <p style={styles.commentText}>"{item.original_comment}"</p>
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
                      
                      {/* Interactive Trigger Control Layout */}
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

// --- EXPLANTATION-READY UI STYLESHEET BLOCKS ---
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