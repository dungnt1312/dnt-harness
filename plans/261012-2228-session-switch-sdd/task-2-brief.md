# Task 2: Harden cached navigation handoff

Review source first. Fix independently reported cache eviction race: inactive a,b,c,d + active e; rendering selected a paints cache a, cleanup e then inserts e and evicts a before new effect restores it. Ensure selected cache is handed to effect without render-time mutation and without violating inactive cache count/budget. Add regression checking every render of selected a, cached cursor and current authoritative actions. Review React StrictMode/concurrent scope changes.

Add regression tests for cached thinking fold roundtrip, compacted resume including duplicate seq, empty replay cursor, snapshot replacement resetting event list (assert events too, not just items). Ensure no loss or duplicates and prior buffered cleanup remains safe.

Review/fix performance hot-path budget accounting if confirmed waste: current JSON.stringify(batch) runs per streaming frame; avoid allocating serialization solely for a conservative inactive cache estimate if a simpler bounded estimator works. Do not weaken cache budget safety.

Ownership: web/hooks/useSessionStream.ts, web/hooks/useSessionStream.switch.spec.tsx and narrowly needed companion tests; docs/web.md only if contract changes. Do not edit unrelated agent/MCP files, API/server code unless directly required and justified. Do not implement full virtualization. No commit, push, restart, deploy, delegation. cwd /Users/dungnt/workspace/dnt-harness; timezone Asia/Saigon; Vietnamese reports. Read docs/ and development conventions as needed.

Run affected hook/compactor/API/SSE tests and typecheck. Report actual failures, preserve unrelated changes. Write report plans/261012-2228-session-switch-sdd/task-2-report.md with fixes, commands/results, remaining concerns; return concise status and paths. Reviewer's pre-existing onerror/parse observations are not authorized speculative changes; only fix confirmed patch-relevant issues.
