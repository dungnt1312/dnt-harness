# Filesystem search reliability

Approved scope: implement on `main`, following checkpoint `ea56309`. Do not modify unrelated concurrent edits or commit the fix without explicit request.

1. Add failing backend regression tests for shallow/exact/prefix traversal, brace choices, project `.gitignore` semantics and overrides, budget exhaustion, cancellation and grant containment. Add UI digest tests for incomplete search.
2. Use the `ignore` parser for project `.gitignore` (not `.zcodeignore`), retain default generated-directory pruning and explicit path/pattern overrides. Load configuration only through granted, non-symlink paths. Scope Glob traversal by expanded pattern prefixes and finite depth; retain a shared bounded walk and containment checks.
3. Return explicit incomplete-search notes when budget or filesystem errors stop traversal; never use bare `no matches` for an incomplete search. Preserve notes under output truncation. Support bounded `{a,b}` choices and validate malformed patterns.
4. Update tool descriptions and UI digest parsing so notes are not counted as files/matches, and incomplete searches remain visible.
5. Run targeted tests, filesystem containment suites, typecheck, broader suite/build and actual workspace queries. Review changed files and report evidence and limitations.
