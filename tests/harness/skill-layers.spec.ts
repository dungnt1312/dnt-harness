/** Pure unit coverage for the skill rule model: validation, resolution, protection. */
import { homedir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  MAX_SKILL_RULES,
  SkillError,
  absoluteRuleBase,
  defaultSkillRules,
  projectRuleBase,
  protectedRootsForRules,
  resolveSkillLayers,
  validateSkillRules,
} from 'mini-dsh'

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
    expect(absoluteRuleBase('D:/shared')).toBe(path.normalize('D:/shared'))
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

describe('protectedRootsForRules', () => {
  it('collects enabled absolute rule folders only', () => {
    expect(protectedRootsForRules([
      { id: 'u', kind: 'absolute', path: 'D:/skills', enabled: true },
      { id: 'off', kind: 'absolute', path: 'E:/off', enabled: false },
      { id: 'p', kind: 'project', path: '.claude/skills', enabled: true },
    ])).toEqual([path.normalize('D:/skills')])
  })
})
