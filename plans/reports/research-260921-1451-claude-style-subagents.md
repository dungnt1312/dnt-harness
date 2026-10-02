# Research — why the delegation work went the wrong way

Date: 2026-09-21 · Branch: `feat/workbench-terminal` · Scope: analysis only, no code changed.

> Later decision, 2026-09-22: `plans/260921-1457-claude-style-subagents/` accepted items
> 1–6 of the recommendation below, then cut token accounting (item 11) out of that plan
> and locked the bundled catalog at four roles. Follow the plan's Decisions section, not
> the open questions at the bottom of this report.

Follows `research-260921-1403-model-driven-delegation.md`,
`brainstorm-260921-1414-multi-agent-gaps.md` and the shipped plan
`plans/260921-1414-agent-delegation-tool/` (status `done`).

## Question

The delegation work shipped and passes its own acceptance criteria. The user says it is
still the wrong direction and asks for multi-agent "like Claude". What is actually wrong?

## The answer

**A child in dnt-harness is not a different agent. It is the same agent with fewer tools.**

Everything that makes a Claude Code subagent a *subagent* — its own system prompt, a
free-form brief, and a defined deliverable — is missing. What was built instead is a
correct, well-tested **process supervisor**: lifecycle, capacity caps, writer leases,
model pinning, tool ceilings, restart recovery. The plumbing is good. It just does not
carry an agent.

The previous research asked "how does the root model start a child?" and answered it
well. Nobody asked "what does the child know, and what does it hand back?" Both answers
are: almost nothing.

## Evidence

### 1. The role's instructions never reach the child's system prompt

`buildContext` is the single context assembly path (`src/harness/context/builder.ts:133`).
Its input type `BuildContextInput` (`builder.ts:32-52`) has **no field for a child or a
definition**. The only call site (`src/web/server.ts:1344-1357`) passes none.

`scope.childOf` exists and is read in four places — MCP denial (`server.ts:1150`),
`Agent` denial (`server.ts:1169`), the tool ceiling (`server.ts:1176`, `1275`) and skill
preload (`server.ts:1298`). **Never for the prompt.**

So a child's system prompt is byte-identical in shape to a root's:

```
You are dnt-harness, a local coding assistant. Answer helpfully and precisely.

Mode — <mode name>: <mode instructions>

<untrusted kind="workspace-instructions" …>
```

The role's actual identity arrives through `renderPacket` (`executor.ts:524-536`) as
**text inside the first user message**:

```
<definition name="explorer">
You are a read-only explorer. Investigate with read tools only…
</definition>

## Task
…
```

### 2. Consequence: the mode instructions outrank the role, and they conflict

Mode text sits in the authoritative system block; the role sits in user data below it.
From `src/harness/modes/bundled.ts`:

| Child | Mode | What its **system prompt** says it is | What its role says |
|---|---|---|---|
| `explorer` spawned to grep for a symbol | Plan | "You are a planning assistant… **the plan itself is the deliverable**" (`bundled.ts:53`) | a read-only explorer reporting findings |
| `worker` with no `Bash` in its ceiling | Full access | "full access to the workspace tools… **shell commands run with host privileges**" (`bundled.ts:67`) | "stay within the granted tools" |

An explorer asked for three file paths is told by its system prompt to deliver a plan.
This is not a theoretical mis-framing; it is what the request contains today.

### 3. The child is never told what its deliverable is

`BASE_SYSTEM` (`builder.ts:115`) is "You are dnt-harness, a local coding assistant. Answer
helpfully and precisely." Nothing anywhere tells a child that:

- it is a subagent working for another agent, not for a human;
- its **final message** is the only thing the parent will read;
- the user never sees its intermediate work, so anything that matters must be restated;
- it cannot delegate (it will discover this as a tool denial if it tries).

Claude Code states all four in its subagent framing. dnt-harness states none.

### 4. The result digest keeps the narration and throws away the conclusion

`ChildExecutor.withResult` (`executor.ts:477-489`):

```ts
for (const event of child.events) {
  if (event.type === 'assistant/message' && event.content.trim() !== '') summary.push(event.content.trim())
  if (event.type === 'tool/call') {
    const filePath = event.call.args['path']
    if (typeof filePath === 'string') files.add(filePath)
  }
}
child.result = { summary: summary.join('\n\n').slice(0, 4_000), fileReferences: [...files].slice(0, 20) }
```

Three defects in six lines:

1. **`.slice(0, 4_000)` truncates from the front.** A child's conclusion is its *last*
   message. Every "let me check X", "now I'll look at Y" narration step is an
   `assistant/message` and is kept ahead of it. A chatty child loses exactly the part the
   parent asked for. This compounds §3: nobody told the child to stop narrating.
2. **Concatenation is not a report.** The parent receives interleaved thinking-aloud, not
   an answer. `requiredResult` (`executor.ts:23`) is accepted, rendered into the packet,
   and then not honoured by anything that builds the digest.
3. **`args['path']` only matches `Read`/`Write`/`Edit`.** `Glob`/`Grep` use `pattern`,
   `Bash` uses `command`. So `fileReferences` silently misses the read-only tools an
   `explorer` — the one role that parallelizes — actually uses.

### 5. The brief is a rigid four-field form, and the child starts blind

`TaskPacket` (`executor.ts:19-24`) is `{ objective, constraints[], references[],
requiredResult }`. The root must compress everything it knows into those four fields.
There is no free-form prompt and **no context inheritance of any kind** — a child's log
starts empty except for the packet. The root has just read twenty files; the child
cannot see one of them unless the root retypes the path into `references[]`.

Claude Code passes a free-form `prompt` the parent writes with full knowledge, and its
`fork` subagent type inherits the parent's entire conversation.

### 6. Two roles, and they are permission tiers, not specialists

`BUNDLED_AGENT_ROLES = ['explorer', 'worker']` (`definition-service.ts:13`).
Their descriptions (`definition-service.ts:135`, `145`) are "read-only explorer" and
"bounded worker… with file tools" — i.e. *read* and *write*. They describe a capability
level, not an expertise.

The whole value of Claude Code's agent library is that `description` drives selection:
the main model reads "use this for X" and picks. With two tiers there is nothing to
select — the model is choosing a permission level and then writing the entire specialist
prompt itself, inside `objective`, every single time.

### 7. No accounting

`grep -E 'usage|promptTokens|inputTokens|totalTokens' src/**/*.ts` → **0 matches**. No
token or cost figure exists in the LLM seam or in any session event. A feature whose
premise is running N models at once cannot show what it spent.

## Why the earlier plan could pass and still be wrong

Its acceptance criteria (`plans/260921-1414-agent-delegation-tool/plan.md:115-129`) are
all mechanism:

- two children run concurrently ✓
- one `wait` returns both digests ✓
- the child runs on exactly the requested `provider:model` ✓
- a child calling `Agent` is denied ✓

Not one of them asks whether the delegation produced a usable answer. A feature can pass
all of these and still return truncated narration from a child that was told it is a
planning assistant. It does.

## What "like Claude" actually means, ranked by what it buys

| # | Claude Code | dnt-harness today | Cost |
|---|---|---|---|
| 1 | definition body **is** the child's system prompt | body is user-message text; system prompt identical to the root's | small |
| 2 | child is told its final message is the whole deliverable | told nothing | small |
| 3 | report = the child's **final** message | concat of all messages, first 4 000 chars | small |
| 4 | free-form `prompt` | rigid 4-field packet | small |
| 5 | `fork` inherits the parent's context | no inheritance | medium |
| 6 | library of named specialists picked by `description` | 2 permission tiers | medium (mostly prose) |
| 7 | per-subagent worktree ⇒ real parallel writers | one throwing lease per folder (`workspace/service.ts:457-465`) | large |
| 8 | parallel tool batches (~10) ⇒ blocking `Task` fans out | sequential `for` loop (`agent.ts:405-455`) | large, touches G1 |
| 9 | background + notify in a later turn | `inject()` does not wake the driver (`agent.ts:129`) | large, changes turn semantics |
| 10 | nesting depth 3, ~20 concurrent | depth 1, 3 global (`executor.ts:72`, `110`) | medium |
| 11 | token/cost per subagent | none | medium, touches the LLM seam |

**Items 1-4 are the re-direction.** They are cheap, they are confined to
`builder.ts` / `executor.ts` / `agent-delegation.ts`, and without them nothing else
matters. Items 7-9 are what the previous research already deferred, correctly — they are
scaling work, and scaling a broken contract just spends more money faster.

## Recommendation

Fix the contract, then the plumbing:

1. **The child is a real agent** — `buildContext` becomes child-aware: the definition's
   instructions become system instructions, and a subagent preamble states the
   deliverable rule and the one-level ceiling. Drop the `<definition>` blob from
   `renderPacket`.
2. **The result is the child's final message**, with per-tool file-reference extraction
   and an honest failure when the child produced no final message.
3. **A free-form `prompt`**, with the four-field packet kept as a compatible alternative
   for the existing HTTP route and tests.
4. **Context inheritance** (`inherit: 'none' | 'brief'`) so a child can start from what
   the root already knows.
5. **A real role library** with descriptions that drive selection.
6. **Then** per-root caps and token accounting.

Deferred to their own plans, unchanged from the earlier research: parallel tool batches,
worktree-isolated writers, background children with driver wake, depth > 1.

## Unresolved questions

1. Should a child's system prompt keep the **mode** instructions at all? Dropping them
   removes the Plan/Full-access mis-framing, but the mode is also what makes a child in
   Plan read-only — that is enforced by the exposure gate, not the prompt, so dropping
   the text is safe. Keeping a one-line capability statement instead is the middle path;
   this plan takes the middle path.
2. Token accounting touches the LLM seam and every session, not just delegation. Its own
   plan, or a phase here? This plan scopes it as a final phase, cuttable.
3. `references[]` vs `inherit: 'brief'` overlap once inheritance exists. Keep both, or
   let inheritance subsume references?
