# Compaction continuity repair

Approved design: user confirmed “Chốt” on 2026-10-05.

## Evidence and goal

Session `session-muth6xq0uluol5` in workspace `ws-mur65pzr745ftn` projected 1,100,986 characters. The host summarized only the first 200,000 (cut inside tool result seq 337), but checkpoint covered through seq 46868. Summary omitted Phase 3, commit `44f6ada`, 60 suites / 1.204 tests, and outstanding work. Follow-up manifest contained the stale summary; the agent nonetheless called this a new session. Gateway handling is unproven.

Goal: preserve latest work and same-conversation continuation across completed-boundary compaction.

## Requirements

- Process the entire covered projection chronologically in bounded chunks, carrying an accumulated summary into later requests. Never silently truncate source or returned summary. A failed/empty/oversized response prevents checkpoint success.
- Preserve 200,000 characters as the maximum conversation-source payload per summarizer request, including accumulated summary; preserve 24,000 characters as the maximum returned summary. Validate output while collecting, not after discarding its suffix.
- No-model fallback must not silently claim full coverage when it cannot retain the entire source within the output bound; fail clearly in that case.
- Keep configurable recent covered completed turns raw (default four), plus ALL uncovered turns. `compactionTailTurns: 0` disables covered-tail duplication, not uncovered history. Whole-turn budget trimming remains permitted and explicitly recorded; open-turn/tool pairing protections remain unchanged.
- Explicitly frame compacted history as continuation of the same conversation, not a new session. Summary remains lower-trust reference data.
- Original JSONL is immutable as an existing prefix; normal lifecycle appends are permitted. Do not promote summaries into memory.
- Synthetic regressions model `44f6ada`, `60 suites / 1.204 tests`, audio browser acceptance, media smoke automation, production secret rotation and flake monitoring. Do not commit user logs or secrets.
- Recover the named live session only after verified implementation: back up old checkpoint and original log, recompact through updated server, never edit/truncate JSONL or automatically send a follow-up message.
- Validate local wire preservation of multiple system blocks separately. Do not claim external gateway compatibility without observed evidence.
- Keep existing API response and checkpoint schema compatible. Do not expand this patch into broad checkpoint durability, cancellation/admission lifecycle, or gateway rewrites.
- Preserve unrelated dirty UI changes. No automatic commits or live server restart without checking the running process and obtaining approval if it would interrupt other work.
