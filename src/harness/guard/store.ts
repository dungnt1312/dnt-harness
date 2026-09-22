import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { replaceFileAtomic } from '../storage/events-jsonl.ts'
import { DEFAULT_CONFIG, PRESET_IDS } from './defaults.ts'
import type { DangerousCommandsConfig, PresetId, GuardAction, CustomRuleAction } from './types.ts'

const PRESET_SET = new Set<string>(PRESET_IDS as readonly string[])
const PRESET_ACTIONS = new Set<string>(['deny', 'ask', 'off'])
const CUSTOM_ACTIONS = new Set<string>(['deny', 'ask', 'allow'])

export class DangerousCommandsStore {
  constructor(private readonly home: string) {}

  private workspaceFile(workspaceId: string): string {
    return path.join(this.home, 'workspaces', workspaceId, 'dangerous-commands.json')
  }

  private globalFile(): string {
    return path.join(this.home, 'dangerous-commands.json')
  }

  async load(workspaceId: string): Promise<{ config: DangerousCommandsConfig; hash: string }> {
    const wsFile = this.workspaceFile(workspaceId)
    const ws = await this.readFile(wsFile)
    if (ws !== null) return ws
    const g = await this.readFile(this.globalFile())
    if (g !== null) return g
    return { config: clone(DEFAULT_CONFIG), hash: hashConfig(DEFAULT_CONFIG) }
  }

  async loadGlobal(): Promise<{ config: DangerousCommandsConfig; hash: string }> {
    const g = await this.readFile(this.globalFile())
    if (g !== null) return g
    return { config: clone(DEFAULT_CONFIG), hash: hashConfig(DEFAULT_CONFIG) }
  }

  async save(
    workspaceId: string,
    config: DangerousCommandsConfig,
    expectedHash?: string,
  ): Promise<{ config: DangerousCommandsConfig; hash: string }> {
    validateConfig(config)
    await this.checkWorkspaceConflict(workspaceId, expectedHash)
    const file = this.workspaceFile(workspaceId)
    const normalized = normalize(config)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await replaceFileAtomic(file, `${JSON.stringify(normalized, null, 2)}\n`)
    return { config: normalized, hash: hashConfig(normalized) }
  }

  async saveGlobal(
    config: DangerousCommandsConfig,
    expectedHash?: string,
  ): Promise<{ config: DangerousCommandsConfig; hash: string }> {
    validateConfig(config)
    await this.checkGlobalConflict(expectedHash)
    const file = this.globalFile()
    const normalized = normalize(config)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await replaceFileAtomic(file, `${JSON.stringify(normalized, null, 2)}\n`)
    return { config: normalized, hash: hashConfig(normalized) }
  }

  private async readFile(filePath: string): Promise<{ config: DangerousCommandsConfig; hash: string } | null> {
    let raw: string
    try {
      raw = await fs.readFile(filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    try {
      const parsed = JSON.parse(raw) as unknown
      const config = parseAndCoerce(parsed)
      validateConfig(config)
      return { config, hash: hashConfig(config) }
    } catch {
      // Corrupt JSON or invalid schema falls back to DEFAULT_CONFIG
      return null
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
    if (ws !== null) return ws.hash
    const g = await this.readFile(this.globalFile())
    if (g !== null) return g.hash
    return hashConfig(DEFAULT_CONFIG)
  }

  private async effectiveGlobalHash(): Promise<string> {
    const g = await this.readFile(this.globalFile())
    if (g !== null) return g.hash
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
  // v, presets, customRules passthrough for validation
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

  const presets = obj['presets']
  if (presets === null || typeof presets !== 'object' || Array.isArray(presets)) {
    throw new Error('invalid config: presets must be an object')
  }
  const presetRecord = presets as Record<string, unknown>
  const presetKeys = Object.keys(presetRecord)

  // Check missing keys
  for (const id of PRESET_IDS) {
    if (!(id in presetRecord)) {
      throw new Error(`invalid config: missing preset '${id}'`)
    }
  }
  // Check unknown keys
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
  for (let i = 0; i < customRules.length; i++) {
    const rule = customRules[i] as Record<string, unknown>
    if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) {
      throw new Error(`invalid config: customRules[${i}] must be an object`)
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
