# Glob hardening implementation plan

Approved scope: work directly on main; no new pattern syntax or automatic commits.

- [ ] Matcher: reproduce `*a` repeated 18 times followed by `b` on `a` repeated 40 times in a separate process with a timeout. Replace segment RegExp matching with O(pattern length × filename length) dynamic programming, preserving literals, `*`, and whole-segment `**`. Test successful/unsuccessful wildcard combinations and punctuation/Unicode.
- [ ] Ignore isolation: reproduce `{snapshots/a.ts,**/*.ts}` leaking `snapshots/b.ts`. Keep active patterns and immutable ignore layers together per branch in the shared traversal; prune branches independently, retain one node budget and deduplicated results. Load each directory's rules once and share only immutable rule definitions.
- [ ] Output: reproduce mid-path truncation and tiny limits. Return only whole result/metadata lines. Require at least 64 output characters (otherwise a clear error); prioritize completeness status over results and compact its reason if necessary. Recompute Glob omitted count from actual displayed lines and total discovered matches; keep Grep notes separate from hits. Test backend outputs and UI digest integration.
- [ ] Verify targeted filesystem/UI tests, typecheck, full suite, build, pathological-pattern subprocess and real repository queries. Report any failing checks and remaining contract limitations; no claim of universal glob syntax.
