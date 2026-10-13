import type { ModeDefinition } from './types.ts'

/** Tool ceiling shared by every bundled mode that can change the workspace. */
const WORKSPACE_TOOLS: readonly string[] = ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash', 'BashOutput', 'KillShell', 'Skill', 'Agent', 'TodoWrite', 'AskUserQuestion', 'GenerateImage', 'EditImage', 'DescribeImage', 'GenerateVideo']

/**
 * The five bundled modes, in picker order (the ZCode ladder: Plan, Ask before
 * changes, Autonomous, Full access; Edit automatically sits between the
 * first two and is hidden from a new workspace's picker — see
 * `DEFAULT_HIDDEN_MODE_IDS`). They are read-only: customizing one duplicates
 * it into the workspace under a new id. Full access allows exposed
 * capabilities but never overrides host or workspace restrictions — the
 * shell has no OS sandbox, and the mode's own instructions say so. A
 * zero-exposure conversation mode is a workspace custom mode away: empty
 * `toolExposure` plus every source off assembles the same request.
 *
 * - Ask before changes / Edit automatically: read-only Bash that stays in the
 *   project folder (`readOnlyBash: allow`) runs without a question.
 * - Autonomous: everything runs, except a bulk-destructive Bash call
 *   (`riskyBash: ask`) and a path outside the granted folders, which ask.
 * - Full access: nothing asks beyond Dangerous Commands and interactive tools.
 *
 * History reads `compact`: identical to `recent` until a compaction
 * checkpoint exists (nothing is dropped without a summary covering it),
 * then the summary replaces only the covered range and the fresh tail
 * stays. That is what makes manual/auto compaction live for every bundled
 * mode instead of only custom ones.
 */
export const BUNDLED_MODES: readonly ModeDefinition[] = [
  {
    id: 'plan',
    name: 'Plan',
    instructions:
      'You are a planning assistant. Investigate the workspace with read-only tools and deliver a plan as your reply. You cannot write, edit, run shell commands, or write memory — the plan itself is the deliverable.',
    sources: { history: 'compact', workspaceInstructions: true, skills: 'on-demand', memoryPinned: true, memoryRetrieval: true },
    // Delegation is exposed here safely: a child resolves the SAME mode, so
    // anything it spawns is read-only too — there is no write path to grant.
    toolExposure: ['Read', 'Glob', 'Grep', 'Skill', 'Agent', 'TodoWrite', 'AskUserQuestion', 'DescribeImage'],
    permissionDefaults: {
      Read: 'allow', Glob: 'allow', Grep: 'allow', Skill: 'allow', Agent: 'allow',
      TodoWrite: 'allow',
      // Asking the user a question is itself the human checkpoint.
      AskUserQuestion: 'allow', DescribeImage: 'allow',
    },
    // A property, not an id check: a duplicated Plan keeps it.
    mcpExposure: 'read-safe',
  },
  {
    id: 'ask-before-changes',
    name: 'Ask before changes',
    instructions:
      'You are a careful assistant working inside the user’s workspace. Read files freely; before any write, edit, or shell command that changes something, ask for approval — read-only inspection commands such as `ls`, `git status`, or `rg` inside the project run without asking. Prefer explaining what you are about to change. Saving Markdown notes inside the memory folders may proceed without a separate approval.',
    sources: { history: 'compact', workspaceInstructions: true, skills: 'on-demand', memoryPinned: true, memoryRetrieval: true },
    toolExposure: WORKSPACE_TOOLS,
    permissionDefaults: {
      Read: 'allow', Glob: 'allow', Grep: 'allow',
      Write: 'ask', Edit: 'ask', Bash: 'ask',
      // Background-process control only touches processes the agent itself
      // spawned, so it stays allowed even where Bash asks.
      BashOutput: 'allow', KillShell: 'allow',
      // Delegation asks here for the same reason a write does: this mode's
      // premise is that the user sees consequential work before it starts.
      Skill: 'allow', Agent: 'ask',
      // The session task list touches no workspace state, so it never asks.
      TodoWrite: 'allow',
      // Asking the user a question is itself the human checkpoint.
      AskUserQuestion: 'allow',
      // Paid external calls: the user sees the prompt before it is spent.
      GenerateImage: 'ask', EditImage: 'ask', DescribeImage: 'allow', GenerateVideo: 'ask',
    },
    readOnlyBash: 'allow',
  },
  {
    id: 'edit-automatically',
    name: 'Edit automatically',
    instructions:
      'You are an assistant that edits files directly inside the user’s workspace. Read and edit files without asking; shell commands that change something, and deletions, still require approval — read-only inspection commands inside the project run without asking. Keep edits minimal and verifiable.',
    sources: { history: 'compact', workspaceInstructions: true, skills: 'on-demand', memoryPinned: true, memoryRetrieval: true },
    toolExposure: WORKSPACE_TOOLS,
    permissionDefaults: {
      Read: 'allow', Glob: 'allow', Grep: 'allow', Write: 'allow', Edit: 'allow',
      // A child's own calls re-enter this same policy, so delegating cannot
      // widen what the conversation may already do.
      Bash: 'ask', BashOutput: 'allow', KillShell: 'allow', Skill: 'allow', Agent: 'allow',
      TodoWrite: 'allow',
      // Asking the user a question is itself the human checkpoint.
      AskUserQuestion: 'allow',
      GenerateImage: 'ask', EditImage: 'ask', DescribeImage: 'allow', GenerateVideo: 'ask',
    },
    readOnlyBash: 'allow',
  },
  {
    id: 'autonomous',
    name: 'Autonomous',
    instructions:
      'You are an autonomous assistant working inside the user’s workspace. Read, edit, and run commands without asking; the host asks the user before commands that destroy data in bulk (recursive deletes, `git reset --hard`, forced pushes, disk tools) and before touching paths outside the granted folders. There is no OS sandbox: shell commands run with host privileges, so prefer reversible steps.',
    sources: { history: 'compact', workspaceInstructions: true, skills: 'on-demand', memoryPinned: true, memoryRetrieval: true },
    toolExposure: WORKSPACE_TOOLS,
    permissionDefaults: {
      Read: 'allow', Glob: 'allow', Grep: 'allow', Write: 'allow', Edit: 'allow', Bash: 'allow',
      BashOutput: 'allow', KillShell: 'allow',
      Skill: 'allow', Agent: 'allow',
      TodoWrite: 'allow',
      AskUserQuestion: 'allow',
      // Paid external calls still show their prompt first.
      GenerateImage: 'ask', EditImage: 'ask', DescribeImage: 'allow', GenerateVideo: 'ask',
      // Workspace MCP tools run like the built-ins; interactive ones still ask.
      '*': 'allow',
    },
    riskyBash: 'ask',
  },
  {
    id: 'full-access',
    name: 'Full access',
    instructions:
      'You are an assistant with full access to the workspace tools. Host and workspace restrictions still apply and cannot be overridden by you. There is no OS sandbox: shell commands run with host privileges, so stay deliberate.',
    sources: { history: 'compact', workspaceInstructions: true, skills: 'on-demand', memoryPinned: true, memoryRetrieval: true },
    toolExposure: WORKSPACE_TOOLS,
    permissionDefaults: {
      Read: 'allow', Glob: 'allow', Grep: 'allow', Write: 'allow', Edit: 'allow', Bash: 'allow',
      BashOutput: 'allow', KillShell: 'allow',
      Skill: 'allow', Agent: 'allow',
      TodoWrite: 'allow',
      // Asking the user a question is itself the human checkpoint.
      AskUserQuestion: 'allow',
      GenerateImage: 'allow', EditImage: 'allow', DescribeImage: 'allow', GenerateVideo: 'allow',
      // Full access means the workspace's MCP tools too: without a catch-all,
      // every mcp__* name falls to the defaultMode fallback and asks forever.
      // Host blockedTools, interactive annotations, and explicit denies still
      // win over this.
      '*': 'allow',
    },
    // Paths outside the granted folders run without an extra approval here;
    // unsafe paths are still refused by the host.
    outOfGrant: 'allow',
  },
]

export const DEFAULT_MODE_ID = 'ask-before-changes'

/**
 * Bundled modes a workspace's picker hides until the user turns them on in
 * Settings → Modes (ZCode dropped "Edit automatically" from its menu). The
 * mode stays selectable and every saved conversation keeps it.
 */
export const DEFAULT_HIDDEN_MODE_IDS: readonly string[] = ['edit-automatically']

/** The full exposure ceiling any mode can grant (skills/memory included). */
export { KNOWN_MODE_TOOLS } from './known-tools.ts'
