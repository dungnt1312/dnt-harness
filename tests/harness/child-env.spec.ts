import { describe, expect, it } from 'vitest'
import { isWithheldEnv, markHarnessSecretEnv, scrubbedChildEnv } from '../../src/harness/child-env.ts'

describe('scrubbedChildEnv', () => {
  const source = {
    PATH: '/usr/bin',
    HOME: '/home/u',
    DEEPSEEK_API_KEY: 'sk-1',
    OPENAI_API_KEY: 'sk-2',
    GITHUB_TOKEN: 'ghp',
    AWS_SECRET_ACCESS_KEY: 'aws',
    AWS_SECRET: 'aws2',
    DB_PASSWORD: 'pw',
    MINI_DSH_AUTH: '1',
    TOKENIZERS_PARALLELISM: 'false',
    KEYBOARD: 'us',
  }

  it('drops harness and credential-looking variables, keeps ordinary ones', () => {
    const env = scrubbedChildEnv({}, source)
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/u', TOKENIZERS_PARALLELISM: 'false', KEYBOARD: 'us' })
  })

  it('honours the explicit pass-through list and extra entries', () => {
    const env = scrubbedChildEnv({ TAG: 'x' }, { ...source, MINI_DSH_CHILD_PASS_ENV: 'github_token' })
    expect(env['GITHUB_TOKEN']).toBe('ghp')
    expect(env['TAG']).toBe('x')
    expect(env['DEEPSEEK_API_KEY']).toBeUndefined()
  })

  it('withholds names registered as harness-owned', () => {
    expect(isWithheldEnv('MY_PROVIDER_CONF')).toBe(false)
    markHarnessSecretEnv(['MY_PROVIDER_CONF'])
    expect(isWithheldEnv('my_provider_conf')).toBe(true)
  })
})
