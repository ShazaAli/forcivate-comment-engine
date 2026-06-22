// connection.ts
//
// Single responsibility: open the SQLite database file and ensure the
// schema exists. Every other module imports `db` from here rather than
// constructing its own connection — this guarantees the whole app shares
// one connection and one source of truth for the schema.

import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";

// Why __dirname-relative paths instead of a hardcoded absolute path?
// This file gets compiled into backend/dist/db/connection.js. Using
// __dirname means the path resolves correctly relative to wherever the
// compiled file actually lives, regardless of which directory the
// `node` process was launched from.
const DB_PATH = path.join(__dirname, "..", "..", "data.sqlite");
const SCHEMA_PATH = path.join(__dirname, "schema.sql");

// Why open the connection once at module load time, not inside a function?
// better-sqlite3 connections are cheap, synchronous, and meant to be
// long-lived for the life of the process — unlike, say, a typical HTTP
// connection pool. Opening once and exporting it is the documented,
// recommended pattern for this library.
export const db = new Database(DB_PATH);

// Why enable WAL mode explicitly?
// Write-Ahead Logging lets reads happen concurrently with a write,
// which matters here because our API will have a GET /queue endpoint
// (read) potentially overlapping with a POST /decision endpoint (write).
// Without WAL, SQLite's default rollback-journal mode locks the whole
// file during writes, which would block reads unnecessarily even for
// our small scale.
db.pragma("journal_mode = WAL");

// Why run the schema file on every startup instead of a separate
// "migrate" command you have to remember to run?
// All our statements use `CREATE TABLE IF NOT EXISTS` and
// `CREATE INDEX IF NOT EXISTS` — they're idempotent. Running them on
// every boot means the schema is always in sync with the source file
// with zero extra steps, which is the right tradeoff for a project this
// size. A production system with real migrations (adding columns to
// existing tables, etc.) would need a proper migration tool instead —
// noted as a future improvement.
function initSchema(): void {
  const schemaSql = fs.readFileSync(SCHEMA_PATH, "utf-8");
  db.exec(schemaSql);
}

initSchema();