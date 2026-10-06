/** Pure unit coverage for the skill rule model: validation, resolution, protection. */
import { homedir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  MAX_SKILL_RULES,
  SkillError,
  absoluteRuleBase,
  absoluteRuleTooBroad,
  assertSkillName,
  assertWritableSkillName,
  defaultSkillRules,
  projectRuleBase,
  protectedRootsForRules,
  resolveSkillLayers,
  validateSkillRules,
  validateSkillRulesForWrite,
} from 'dnt-harness'

describe('defaultSkillRules', () => {
  it('orders .claude, .agents, workspace, user and omits the user row without a dir', () => {
    const rules = defaultSkillRules('C:/Users/x/.claude/skills')
    expect(rules.map((rule) => rule.id)).toEqual(['project-claude', 'project-agents', 'workspace', 'user'])
    expect(rules[3]).toMatchObject({ kind: 'absolute', path: 'C:/Users/x/.claude/skills', enabled: true })
    expect(defaultSkillRules(undefined).map((rule) => rule.id)).toEqual(['project-claude', 'project-agents', 'workspace'])
  })
})

describe('validateSkillRules', () => {
  it('accepts a well-formed list and forces the workspace row path off', () => {
    const rules = validateSkillRules({ rules: [
      { id: 'a', kind: 'project', path: '.claude/skills', enabled: true },
      { id: 'ws', kind: 'workspace', path: 'C:/ignored', enabled: false },
      { id: 'b', kind: 'absolute', path: '~/shared-skills', enabled: true },
    ] })
    expect(rules).toHaveLength(3)
    expect(rules[1]).toEqual({ id: 'ws', kind: 'workspace', enabled: false })
  })

  it('rejects malformed payloads with SkillError invalid', () => {
    const bad: unknown[] = [
      null,
      {},
      { rules: 'no' },
      { rules: [{ id: 'a', kind: 'project', path: '../escape', enabled: true }] },
      { rules: [{ id: 'a', kind: 'project', path: 'C:/abs', enabled: true }] },
      { rules: [{ id: 'a', kind: 'project', path: '', enabled: true }] },
      { rules: [{ id: 'a', kind: 'absolute', path: 'relative/path', enabled: true }] },
      { rules: [{ id: 'a', kind: 'galactic', enabled: true }] },
      { rules: [{ id: 'a', kind: 'workspace', enabled: true }, { id: 'b', kind: 'workspace', enabled: true }] },
      { rules: [{ id: 'a', kind: 'workspace', enabled: true }, { id: 'a', kind: 'project', path: 'x', enabled: true }] },
      { rules: [{ id: 'A', kind: 'workspace', enabled: true }] },
      { rules: [{ id: 'a', kind: 'workspace' }] },
      { rules: [{ id: 'a', kind: 'project', path: 'x' }] },
      { rules: Array.from({ length: MAX_SKILL_RULES + 1 }, (_, i) => ({ id: `r${i}`, kind: 'project', path: '.x', enabled: true })) },
    ]
    for (const payload of bad) expect(() => validateSkillRules(payload)).toThrow(SkillError)
  })
})

describe('projectRuleBase / absoluteRuleBase', () => {
  it('resolves a relative rule inside the project and refuses escapes', () => {
    expect(projectRuleBase('C:/proj', '.claude/skills')).toBe(path.resolve('C:/proj', '.claude/skills'))
    expect(projectRuleBase('C:/proj', 'sub/../.agents/skills')).toBe(path.resolve('C:/proj', '.agents/skills'))
    expect(projectRuleBase('C:/proj', '../outside')).toBeUndefined()
    expect(projectRuleBase('C:/proj', 'C:/abs')).toBeUndefined()
    expect(projectRuleBase('C:/proj', '')).toBeUndefined()
    expect(projectRuleBase('C:/proj', '.')).toBeUndefined()
  })

  it('expands ~ against the home dir and refuses relative absolute rules', () => {
    // A drive-anchored path is only absolute where drive letters exist.
    expect(absoluteRuleBase('D:/shared')).toBe(process.platform === 'win32' ? path.normalize('D:/shared') : undefined)
    expect(absoluteRuleBase('~')).toBe(homedir())
    expect(absoluteRuleBase('relative')).toBeUndefined()
  })
})

describe('resolveSkillLayers', () => {
  const rules = [
    { id: 'p1', kind: 'project', path: '.claude/skills', enabled: true },
    { id: 'p2', kind: 'project', path: '.agents/skills', enabled: true },
    { id: 'off', kind: 'project', path: '.hidden/skills', enabled: false },
    { id: 'ws', kind: 'workspace', enabled: true },
    { id: 'u', kind: 'absolute', path: '~/skills-u', enabled: true },
  ] as const

  it('emits enabled rules in order with sources and rule ids', () => {
    const layers = resolveSkillLayers(rules, { workspaceDir: 'C:/home/workspaces/ws/skills', projectPath: 'C:/proj' })
    expect(layers.map((layer) => layer.source)).toEqual(['project', 'project', 'workspace', 'user'])
    expect(layers[0]).toMatchObject({ base: path.resolve('C:/proj', '.claude/skills'), ruleId: 'p1' })
    expect(layers[2]).toMatchObject({ base: path.resolve('C:/home/workspaces/ws/skills') })
    expect(layers[2]?.ruleId).toBeUndefined()
  })

  it('skips project rules without a bound project and escaping rules', () => {
    const layers = resolveSkillLayers(rules, { workspaceDir: 'C:/ws-skills' })
    expect(layers.map((layer) => layer.source)).toEqual(['workspace', 'user'])
    const escape = resolveSkillLayers(
      [{ id: 'x', kind: 'project', path: '../..', enabled: true }],
      { workspaceDir: 'C:/ws', projectPath: 'C:/proj' },
    )
    expect(escape).toEqual([])
  })
})

describe('absoluteRuleTooBroad / too-broad absolute rules', () => {
  it('flags drive roots, the home folder, and its ancestors only', () => {
    const home = path.resolve('/Users/someone')
    expect(absoluteRuleTooBroad(path.parse(home).root, home)).toBe(true)
    expect(absoluteRuleTooBroad(home, home)).toBe(true)
    expect(absoluteRuleTooBroad(path.dirname(home), home)).toBe(true)
    expect(absoluteRuleTooBroad(path.join(home, '.claude', 'skills'), home)).toBe(false)
    expect(absoluteRuleTooBroad(path.resolve('/opt/skills'), home)).toBe(false)
    // A sibling whose name merely starts with the home path is not an ancestor.
    expect(absoluteRuleTooBroad(`${home}-other`, home)).toBe(false)
  })

  it('folds case on case-insensitive volumes only', () => {
    const home = path.resolve('/Users/someone')
    const lowerParent = path.resolve('/users')
    expect(absoluteRuleTooBroad(lowerParent, home, true)).toBe(true)
    expect(absoluteRuleTooBroad(path.resolve('/USERS/SOMEONE'), home, true)).toBe(true)
    expect(absoluteRuleTooBroad(lowerParent, home, false)).toBe(false)
  })

  it('writes refuse enabled ~, drive root, and home rules; disabled ones may stay', () => {
    for (const bad of ['~', path.parse(homedir()).root, homedir()]) {
      expect(() => validateSkillRulesForWrite({ rules: [{ id: 'a', kind: 'absolute', path: bad, enabled: true }] })).toThrow(/too broad/)
      expect(validateSkillRulesForWrite({ rules: [{ id: 'a', kind: 'absolute', path: bad, enabled: false }] })).toHaveLength(1)
    }
  })

  it('a stored broad rule still reads (no reset to defaults); resolution and protection skip it', () => {
    const stored = { rules: [
      { id: 'home', kind: 'absolute', path: '~', enabled: true },
      { id: 'proj', kind: 'project', path: 'custom/skills', enabled: true },
      { id: 'ws', kind: 'workspace', enabled: false },
    ] }
    const rules = validateSkillRules(stored)
    expect(rules.map((rule) => rule.id)).toEqual(['home', 'proj', 'ws'])
    const layers = resolveSkillLayers(rules, { workspaceDir: '/ws', projectPath: '/proj' })
    expect(layers.map((layer) => layer.ruleId)).toEqual(['proj'])
    expect(protectedRootsForRules(rules)).toEqual([])
  })
})

describe('assertSkillName', () => {
  it('accepts kebab-case names and refuses traversal or separators', () => {
    expect(() => assertSkillName('deploy-notes')).not.toThrow()
    for (const bad of ['..', '../..', 'a/b', 'a\\b', '', 'Upper', '-lead', '.hidden']) {
      expect(() => assertSkillName(bad, 'invalid')).toThrow(SkillError)
    }
  })

  it('writes refuse reserved names that collide with API routes', () => {
    expect(() => assertWritableSkillName('sources')).toThrow(/reserved/)
    expect(() => assertWritableSkillName('sources-notes')).not.toThrow()
    // Reads stay permissive: the name is well-formed.
    expect(() => assertSkillName('sources')).not.toThrow()
  })
})

describe('protectedRootsForRules', () => {
  it('collects enabled absolute rule folders only', () => {
    // A real temp dir keeps this cross-platform; 'D:/skills' is undefined off Windows.
    const enabled = path.join(homedir(), 'skills-protected-root')
    expect(protectedRootsForRules([
      { id: 'u', kind: 'absolute', path: enabled, enabled: true },
      { id: 'off', kind: 'absolute', path: path.join(homedir(), 'skills-off'), enabled: false },
      { id: 'p', kind: 'project', path: '.claude/skills', enabled: true },
    ])).toEqual([path.normalize(enabled)])
  })
})
