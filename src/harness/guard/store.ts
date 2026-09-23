import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { replaceFileAtomic } from '../storage/events-jsonl.ts'
import { DEFAULT_CONFIG, PRESET_IDS } from './defaults.ts'
import type { DangerousCommandsConfig, PresetId, GuardAction, CustomRuleAction } from './types.ts'

const PRESET_SET = new Set<string>(PRESET_IDS as readonly string[])
const PRESET_ACTIONS = new Set<string>(['deny', 'ask', 'off'])
const CUSTOM_ACTIONS = new Set<string>(['deny', 'ask', 'allow'])

type ReadResult =
  | { kind: 'missing' }
  | { kind: 'valid'; config: DangerousCommandsConfig; hash: string }
  | { kind: 'corrupt'; warning: string }

export interface GuardLoadResult {
  readonly config: DangerousCommandsConfig
  readonly hash: string
  readonly warning?: string
}

export class DangerousCommandsStore {
  private readonly mutationTails = new Map<string, Promise<void>>()

  constructor(private readonly home: string) {}

  private workspaceFile(workspaceId: string): string {
    return path.join(this.home, 'workspaces', workspaceId, 'dangerous-commands.json')
  }

  private globalFile(): string {
    return path.join(this.home, 'dangerous-commands.json')
  }

  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.mutationTails.get(key) ?? Promise.resolve()
    let release!: () => void
    const cur = new Promise<void>((r) => { release = r })
    const tail = prev.then(() => cur)
    this.mutationTails.set(key, tail)
    await prev
    try {
      return await fn()
    } finally {
      release()
      if (this.mutationTails.get(key) === tail) this.mutationTails.delete(key)
    }
  }

  async load(workspaceId: string): Promise<GuardLoadResult> {
    const wsResult = await this.readFile(this.workspaceFile(workspaceId))
    if (wsResult.kind === 'valid') return { config: wsResult.config, hash: wsResult.hash }
    if (wsResult.kind === 'corrupt') {
      return { config: clone(DEFAULT_CONFIG), hash: hashConfig(DEFAULT_CONFIG), warning: wsResult.warning }
    }
    // missing -> try global
    const gResult = await this.readFile(this.globalFile())
    if (gResult.kind === 'valid') return { config: gResult.config, hash: gResult.hash }
    if (gResult.kind === 'corrupt') {
      return { config: clone(DEFAULT_CONFIG), hash: hashConfig(DEFAULT_CONFIG), warning: gResult.warning }
    }
    return { config: clone(DEFAULT_CONFIG), hash: hashConfig(DEFAULT_CONFIG) }
  }

  async loadGlobal(): Promise<GuardLoadResult> {
    const gResult = await this.readFile(this.globalFile())
    if (gResult.kind === 'valid') return { config: gResult.config, hash: gResult.hash }
    if (gResult.kind === 'corrupt') {
      return { config: clone(DEFAULT_CONFIG), hash: hashConfig(DEFAULT_CONFIG), warning: gResult.warning }
    }
    return { config: clone(DEFAULT_CONFIG), hash: hashConfig(DEFAULT_CONFIG) }
  }

  async save(
    workspaceId: string,
    config: DangerousCommandsConfig,
    expectedHash?: string,
  ): Promise<{ config: DangerousCommandsConfig; hash: string }> {
    validateConfig(config)
    const key = `ws:${workspaceId}`
    return this.withLock(key, async () => {
      await this.checkWorkspaceConflict(workspaceId, expectedHash)
      const file = this.workspaceFile(workspaceId)
      const normalized = normalize(config)
      await fs.mkdir(path.dirname(file), { recursive: true })
      await replaceFileAtomic(file, `${JSON.stringify(normalized, null, 2)}\n`)
      return { config: normalized, hash: hashConfig(normalized) }
    })
  }

  async saveGlobal(
    config: DangerousCommandsConfig,
    expectedHash?: string,
  ): Promise<{ config: DangerousCommandsConfig; hash: string }> {
    validateConfig(config)
    return this.withLock('global', async () => {
      await this.checkGlobalConflict(expectedHash)
      const file = this.globalFile()
      const normalized = normalize(config)
      await fs.mkdir(path.dirname(file), { recursive: true })
      await replaceFileAtomic(file, `${JSON.stringify(normalized, null, 2)}\n`)
      return { config: normalized, hash: hashConfig(normalized) }
    })
  }

  /** Whether a workspace has a materialized file (valid JSON). Missing/corrupt -> false. */
  async hasWorkspaceFile(workspaceId: string): Promise<boolean> {
    const result = await this.readFile(this.workspaceFile(workspaceId))
    return result.kind === 'valid'
  }

  private async readFile(filePath: string): Promise<ReadResult> {
    let raw: string
    try {
      raw = await fs.readFile(filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }
      throw error
    }
    try {
      const parsed = JSON.parse(raw) as unknown
      const config = parseAndCoerce(parsed)
      validateConfig(config)
      return { kind: 'valid', config, hash: hashConfig(config) }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return { kind: 'corrupt', warning: `dangerous-commands.json is corrupt/invalid (${detail}); using defaults` }
    }
  }

  private async checkWorkspaceConflict(workspaceId: string, expectedHash?: string): Promise<void> {
    if (expectedHash === undefined) return
    const currentHash = await this.effectiveWorkspaceHash(workspaceId)
    if (currentHash !== expectedHash) {
      throw new Error(`conflict: dangerous-commands.json changed externally; expected ${expectedHash} but found ${currentHash}`)
    }
  }

  private async checkGlobalConflict(expectedHash?: string): Promise<void> {
    if (expectedHash === undefined) return
    const currentHash = await this.effectiveGlobalHash()
    if (currentHash !== expectedHash) {
      throw new Error(`conflict: dangerous-commands.json changed externally; expected ${expectedHash} but found ${currentHash}`)
    }
  }

  private async effectiveWorkspaceHash(workspaceId: string): Promise<string> {
    const ws = await this.readFile(this.workspaceFile(workspaceId))
    if (ws.kind === 'valid') return ws.hash
    if (ws.kind === 'corrupt') return hashConfig(DEFAULT_CONFIG)
    const g = await this.readFile(this.globalFile())
    if (g.kind === 'valid') return g.hash
    if (g.kind === 'corrupt') return hashConfig(DEFAULT_CONFIG)
    return hashConfig(DEFAULT_CONFIG)
  }

  private async effectiveGlobalHash(): Promise<string> {
    const g = await this.readFile(this.globalFile())
    if (g.kind === 'valid') return g.hash
    return hashConfig(DEFAULT_CONFIG)
  }
}

function hashConfig(config: DangerousCommandsConfig): string {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex')
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function normalize(config: DangerousCommandsConfig): DangerousCommandsConfig {
  return {
    v: 1,
    presets: { ...config.presets },
    customRules: config.customRules.map((r) => ({ ...r })),
  }
}

function parseAndCoerce(parsed: unknown): DangerousCommandsConfig {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('invalid config: not an object')
  }
  const obj = parsed as Record<string, unknown>
  return {
    v: obj['v'] as 1,
    presets: obj['presets'] as Record<PresetId, GuardAction>,
    customRules: (obj['customRules'] as readonly never[]) ?? [],
  }
}

function validateConfig(config: unknown): asserts config is DangerousCommandsConfig {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('invalid config: must be an object')
  }
  const obj = config as Record<string, unknown>

  if (obj['v'] !== 1) {
    throw new Error(`invalid config: v must be 1, got ${String(obj['v'])}`)
  }

  const allowedTopKeys = new Set(['v', 'presets', 'customRules'])
  for (const key of Object.keys(obj)) {
    if (!allowedTopKeys.has(key)) {
      throw new Error(`invalid config: unknown top-level key '${key}'`)
    }
  }

  const presets = obj['presets']
  if (presets === null || typeof presets !== 'object' || Array.isArray(presets)) {
    throw new Error('invalid config: presets must be an object')
  }
  const presetRecord = presets as Record<string, unknown>
  const presetKeys = Object.keys(presetRecord)

  for (const id of PRESET_IDS) {
    if (!(id in presetRecord)) {
      throw new Error(`invalid config: missing preset '${id}'`)
    }
  }
  for (const key of presetKeys) {
    if (!PRESET_SET.has(key)) {
      throw new Error(`invalid config: unknown preset '${key}'`)
    }
    const action = presetRecord[key]
    if (typeof action !== 'string' || !PRESET_ACTIONS.has(action)) {
      throw new Error(`invalid config: preset '${key}' has invalid action '${String(action)}'`)
    }
  }

  const customRules = obj['customRules']
  if (!Array.isArray(customRules)) {
    throw new Error('invalid config: customRules must be an array')
  }
  if (customRules.length > 100) {
    throw new Error('invalid config: customRules exceeds 100 entries')
  }
  const seenIds = new Set<string>()
  for (let i = 0; i < customRules.length; i++) {
    const rule = customRules[i] as Record<string, unknown>
    if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) {
      throw new Error(`invalid config: customRules[${i}] must be an object`)
    }
    const allowedRuleKeys = new Set(['id', 'pattern', 'isRegex', 'action', 'description'])
    for (const key of Object.keys(rule)) {
      if (!allowedRuleKeys.has(key)) {
        throw new Error(`invalid config: customRules[${i}] has unknown key '${key}'`)
      }
    }
    const id = rule['id']
    if (typeof id !== 'string' || id.trim() === '') {
      throw new Error(`invalid config: customRules[${i}].id must be a non-empty string`)
    }
    if (seenIds.has(id)) {
      throw new Error(`invalid config: customRules[${i}] duplicate id '${id}'`)
    }
    seenIds.add(id)
    const desc = rule['description']
    if (desc !== undefined && typeof desc !== 'string') {
      throw new Error(`invalid config: customRules[${i}].description must be a string`)
    }
    const action = rule['action']
    if (typeof action !== 'string' || !CUSTOM_ACTIONS.has(action)) {
      throw new Error(`invalid config: customRules[${i}] has invalid action '${String(action)}'`)
    }
    const pattern = rule['pattern']
    if (typeof pattern !== 'string' || pattern.trim() === '') {
      throw new Error(`invalid config: customRules[${i}] has empty pattern`)
    }
    const isRegex = rule['isRegex']
    if (typeof isRegex !== 'boolean') {
      throw new Error(`invalid config: customRules[${i}].isRegex must be boolean`)
    }
    if (isRegex) {
      try {
        new RegExp(pattern as string, 'i')
      } catch {
        throw new Error(`invalid config: customRules[${i}] has invalid regex pattern '${pattern}'`)
      }
    }
  }
}
