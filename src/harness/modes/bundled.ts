import type { ModeDefinition } from './types.ts'

/**
 * The four bundled modes. They are read-only: customizing one duplicates it
 * into the workspace under a new id. Full access allows exposed
 * capabilities but never overrides host or workspace restrictions — the
 * shell has no OS sandbox, and the mode's own instructions say so. A
 * zero-exposure conversation mode is a workspace custom mode away: empty
 * `toolExposure` plus every source off assembles the same request.
 *
 * History reads `compact`: identical to `recent` until a compaction
 * checkpoint exists (nothing is dropped without a summary covering it),
 * then the summary replaces only the covered range and the fresh tail
 * stays. That is what makes manual/auto compaction live for every bundled
 * mode instead of only custom ones.
 */
export const BUNDLED_MODES: readonly ModeDefinition[] = [
  {
    id: 'ask-before-changes',
    name: 'Ask before changes',
    instructions:
      'You are a careful assistant working inside the user’s workspace. Read files freely; before any write, edit, or shell command, ask for approval. Prefer explaining what you are about to change.',
    sources: { history: 'compact', workspaceInstructions: true, skills: 'on-demand', memoryPinned: true, memoryRetrieval: true },
    toolExposure: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash', 'BashOutput', 'KillShell', 'Skill', 'Agent', 'TodoWrite', 'AskUserQuestion'],
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
    },
  },
  {
    id: 'edit-automatically',
    name: 'Edit automatically',
    instructions:
      'You are an assistant that edits files directly inside the user’s workspace. Read and edit files without asking; shell commands and deletions still require approval. Keep edits minimal and verifiable.',
    sources: { history: 'compact', workspaceInstructions: true, skills: 'on-demand', memoryPinned: true, memoryRetrieval: true },
    toolExposure: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash', 'BashOutput', 'KillShell', 'Skill', 'Agent', 'TodoWrite', 'AskUserQuestion'],
    permissionDefaults: {
      Read: 'allow', Glob: 'allow', Grep: 'allow', Write: 'allow', Edit: 'allow',
      // A child's own calls re-enter this same policy, so delegating cannot
      // widen what the conversation may already do.
      Bash: 'ask', BashOutput: 'allow', KillShell: 'allow', Skill: 'allow', Agent: 'allow',
      TodoWrite: 'allow',
      // Asking the user a question is itself the human checkpoint.
      AskUserQuestion: 'allow',
    },
  },
  {
    id: 'plan',
    name: 'Plan',
    instructions:
      'You are a planning assistant. Investigate the workspace with read-only tools and deliver a plan as your reply. You cannot write, edit, run shell commands, or write memory — the plan itself is the deliverable.',
    sources: { history: 'compact', workspaceInstructions: true, skills: 'on-demand', memoryPinned: true, memoryRetrieval: true },
    // Delegation is exposed here safely: a child resolves the SAME mode, so
    // anything it spawns is read-only too — there is no write path to grant.
    toolExposure: ['Read', 'Glob', 'Grep', 'Skill', 'Agent', 'TodoWrite', 'AskUserQuestion'],
    permissionDefaults: {
      Read: 'allow', Glob: 'allow', Grep: 'allow', Skill: 'allow', Agent: 'allow',
      TodoWrite: 'allow',
      // Asking the user a question is itself the human checkpoint.
      AskUserQuestion: 'allow',
    },
  },
  {
    id: 'full-access',
    name: 'Full access',
    instructions:
      'You are an assistant with full access to the workspace tools. Host and workspace restrictions still apply and cannot be overridden by you. There is no OS sandbox: shell commands run with host privileges, so stay deliberate.',
    sources: { history: 'compact', workspaceInstructions: true, skills: 'on-demand', memoryPinned: true, memoryRetrieval: true },
    toolExposure: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash', 'BashOutput', 'KillShell', 'Skill', 'Agent', 'TodoWrite', 'AskUserQuestion'],
    permissionDefaults: {
      Read: 'allow', Glob: 'allow', Grep: 'allow', Write: 'allow', Edit: 'allow', Bash: 'allow',
      BashOutput: 'allow', KillShell: 'allow',
      Skill: 'allow', Agent: 'allow',
      TodoWrite: 'allow',
      // Asking the user a question is itself the human checkpoint.
      AskUserQuestion: 'allow',
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

/** The full exposure ceiling any mode can grant (skills/memory included). */
export const KNOWN_MODE_TOOLS: readonly string[] = [
  'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'BashOutput', 'KillShell', 'Skill', 'Agent',
  'TodoWrite', 'AskUserQuestion',
]
