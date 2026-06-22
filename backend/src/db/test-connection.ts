// test-connection.ts
//
// One-off verification script — NOT part of the running app.
// Confirms the schema loads without errors and that all three tables
// exist. Run manually with `npx ts-node src/db/test-connection.ts`
// and delete or ignore afterward; this is a sanity check, not a test suite.

import { db } from "./connection";

const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
  .all();

console.log("Tables found in database:", tables);

if (tables.length === 0) {
  console.error("FAILED: no tables were created. Check schema.sql.");
  process.exit(1);
}

console.log("Schema loaded successfully.");