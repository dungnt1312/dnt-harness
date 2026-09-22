export type PresetId = 'fsDestructive' | 'gitDestructive' | 'systemPriv' | 'networkExfil' | 'dbDestructive' | 'resourceExhaust'
export type GuardAction = 'deny' | 'ask' | 'off'
export type CustomRuleAction = 'deny' | 'ask' | 'allow'
export interface CustomRule {
  readonly id: string
  readonly pattern: string
  readonly isRegex: boolean
  readonly action: CustomRuleAction
  readonly description?: string
}
export interface DangerousCommandsConfig {
  readonly v: 1
  readonly presets: Record<PresetId, GuardAction>
  readonly customRules: readonly CustomRule[]
}
export interface GuardMatch {
  readonly presetId?: PresetId
  readonly ruleId?: string
  readonly action: GuardAction | CustomRuleAction
  readonly reason: string
  readonly pattern: string
}
