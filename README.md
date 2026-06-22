# Forcivate Comment Response Engine

A full-stack comment moderation system: a Python pipeline drafts AI-powered replies guided by a brand voice config, runs them through a two-layer safety gate plus an LLM triage classifier, and surfaces the results in a web-based human review dashboard backed by a relational queue.

---

## Architecture

```
comments.json
     |
     v
[Python: Triage]              <- reply / skip / monitor classification
     |
     v
[Python: Safety Gate]         <- blocks spam, strips injections, flags hostile
     |
     v
[Python: Drafter]             <- brand voice config + few-shot examples -> LLM call
     |
     v
[Python: Risk-Tiered Queue]   <- auto-approves low-risk items, queues the rest
     |
     v
[Node/Express API]  --------------------------+
     |                                          |
     v                                          v
[SQLite: review_items, publish_log,    [React Dashboard]
 learning_examples]                      approve / edit / reject
     |                                          |
     +---------------- decisions ---------------+
                          |
                          v
                  [Mock Publish + Learning Examples]
```

**Three clear layers, three responsibilities:**
- **Python** — AI orchestration: triage, safety gate, brand-voice drafting.
- **Node + Express + SQLite** — persistence and a REST API over the review queue.
- **React + TypeScript** — the human review dashboard.

---

## Setup

### 1. Python pipeline

```bash
python -m venv venv
venv\Scripts\activate        # Mac/Linux: source venv/bin/activate
pip install anthropic
```

Optional — real LLM drafts and triage:
```bash
set ANTHROPIC_API_KEY=sk-ant-...     # Windows CMD
$env:ANTHROPIC_API_KEY="sk-ant-..."  # PowerShell
```
If no key is set, the system uses `MockDrafter` and a rule-based mock triage automatically — every feature still works.

### 2. Backend (Node + Express + SQLite)

```bash
cd backend
npm install
```

### 3. Frontend (React + TypeScript)

```bash
cd frontend
npm install
```

---

## Run

**1. Run the Python pipeline** to ingest fixture comments and populate the queue:
```bash
python -m src.main
```
This runs triage, the safety gate, and drafting, then opens the CLI human review loop. Low-risk comments (triage=reply + safety=ok) are auto-approved and published without review.

**2. Start the backend API:**
```bash
cd backend
npx ts-node src/server.ts
```
Runs at `http://localhost:3001`. On first boot it creates `data.sqlite` and applies the schema automatically.

**3. Start the frontend dashboard:**
```bash
cd frontend
npm run dev
```
Open the printed local URL (e.g. `http://localhost:5173`) to approve, edit, or reject queued items through the web UI — the same queue the Python CLI populates.

---

### Key Design Decisions

| Decision | Why |
|---|---|
| Python owns AI orchestration only | Triage, safety, and drafting stay isolated from persistence and serving concerns — swapping the LLM provider or adding a new safety rule never touches the Node or React layers. |
| Brand voice as JSON config, not hardcoded strings | Voice changes without touching code. |
| Two-layer safety gate (input + output) | Defense-in-depth; model output isn't trusted either. |
| LLM triage step before drafting | Skips spending tokens/time drafting replies to comments not worth replying to. |
| Risk-tiered auto-approval | Only triage=reply AND safety=ok items publish without a human — anything ambiguous or flagged still requires review. |
| SQLite instead of JSON files for the web layer | The dashboard needs concurrent read (GET /api/queue) and write (POST /decision) access — WAL mode handles this safely; a single review_items table with a status column is the idiomatic relational pattern for a queue's lifecycle. |
| One decision endpoint with a decision field, not three routes | Approve/edit/reject are the same underlying action — "resolve this item" — with shared validation (item exists, not already resolved). |
| API returns a plain JSON array, not a wrapped envelope | GET /api/queue returns res.json(items) directly. PowerShell's Invoke-RestMethod \| ConvertTo-Json adds its own { value, Count } display wrapper during manual testing, which is a PowerShell formatting artifact, not the actual response shape — the frontend parses the raw array. |
| Optimistic UI eviction | Once the API confirms a decision, the item is removed from the dashboard immediately rather than waiting on a re-fetch. |
| get_drafter() factory function | Swap LLM provider in one place; tests always use the mock. |

---

## What I'd Improve With More Time

- **Python to SQLite bridge automation** — currently the Python CLI and the web dashboard operate on separate stores; a one-way sync script (or having Python write directly to SQLite) would unify them into a single source of truth.
- **Async batch drafting** — asyncio + aiohttp to draft all comments in parallel rather than serially.
- **Tests** — pytest for the Python safety gate and drafter mock; a small test suite for the Express decision endpoint's validation branches.
- **Authentication** — the dashboard and API currently have no auth, appropriate for a local demo but not for shared use.
- **Real-time updates** — replace manual refresh with WebSockets or polling so multiple reviewers see a live queue.

---

## Project Structure

```
forcivate-comment-engine/
|-- data/                      <- Python fixture data + JSON outputs (gitignored)
|   |-- comments.json
|   `-- brand_voice.json
|-- src/                       <- Python AI pipeline
|   |-- triage.py
|   |-- safety_gate.py
|   |-- drafter.py
|   |-- queue_store.py
|   `-- main.py
|-- backend/                   <- Node + Express + SQLite API
|   `-- src/
|       |-- db/
|       |   |-- schema.sql
|       |   |-- connection.ts
|       |   `-- queueRepository.ts
|       `-- server.ts
|-- frontend/                  <- React + TypeScript dashboard
|   `-- src/
|       `-- App.tsx
|-- requirements.txt
|-- .gitignore
`-- README.md
```

---

