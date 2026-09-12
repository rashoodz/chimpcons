---
"@consultchimps/core": minor
"@consultchimps/files": minor
"@consultchimps/xlsx": minor
"@consultchimps/db": major
"@consultchimps/messages": minor
"consultchimps": minor
---

Create and reopen persistent SQLite and DuckDB databases, prepare workbook
imports for review, and retain source captures and separately recorded
deliveries. Add bounded workbook reading and file access for large imports.

Replace the database spike's synchronous in-memory API with asynchronous
persistent operations. Applications must migrate to the new database and runtime
entry points. Saved source files are not automatically rewritten.

Add the `consultchimps db` command group. Portable CLI distribution now includes
native engine assets in an archive for its operating system, architecture, and
Node major, rather than a single JavaScript file.
