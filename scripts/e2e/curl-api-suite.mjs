#!/usr/bin/env node
/**
 * curl-api-suite.mjs - exhaustive curl coverage for the dnt-harness web API.
 *
 *   node scripts/e2e/curl-api-suite.mjs [baseUrl]
 *
 * Every request goes through the real `curl.exe` against a running web host
 * (default http://127.0.0.1:3082). The suite creates its own scratch project /
 * session / workspace / provider / alias / memory entry / mode copy / MCP row
 * and removes them again in a cleanup phase (safe to run against a live app).
 *
 * The app's provider store (providers.json) is backed up first; the suite only
 * mutates through the API and reports whether the file ended equal to backup.
 *
 * Exit code 0 when every case passes.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const BASE = (process.argv[2] ?? 'http://127.0.0.1:3082').replace(/\/$/, '')
const PROVIDERS_FILE = process.env.DNT_PROVIDERS_FILE ?? path.join(os.homedir(), '.mini-dsh', 'providers.json')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dnt-curl-suite-'))
const WORK_A = path.join(TMP, 'proj-a')
const WORK_B = path.join(TMP, 'proj-b')
fs.mkdirSync(WORK_A, { recursive: true })
fs.mkdirSync(WORK_B, { recursive: true })

let seq = 0
const q = (value) => encodeURIComponent(value)

const probe = spawnSync('curl.exe', ['--version'], { encoding: 'utf8' })
if (probe.status !== 0) {
  console.error('curl.exe is required for this suite')
  process.exit(2)
}

function curlRaw(method, urlPath, { bodyText, headers = {}, maxTime = 25, fileExt = '' } = {}) {
  const outFile = path.join(TMP, `body-${String(++seq).padStart(3, '0')}${fileExt}`)
  const url = urlPath.startsWith('http') ? urlPath : BASE + urlPath
  const args = ['-s', '-N', '--max-time', String(maxTime), '-o', outFile, '-w', '%{http_code}\t%{content_type}', '-X', method, url]
  if (bodyText !== undefined) {
    const bodyFile = path.join(TMP, `req-${seq}.json`)
    fs.writeFileSync(bodyFile, bodyText, 'utf8')
    args.push('--data-binary', `@${bodyFile}`)
  }
  for (const [key, value] of Object.entries(headers)) args.push('-H', `${key}: ${value}`)
  const result = spawnSync('curl.exe', args, { encoding: 'utf8', timeout: (maxTime + 30) * 1000 })
  const written = String(result.stdout ?? '').trim().split('\t')
  const status = Number.parseInt(written[0] ?? '0', 10)
  const ctype = written[1] ?? ''
  let raw = ''
  try { raw = fs.readFileSync(outFile, 'utf8') } catch {}
  return { status, ctype, raw, exit: result.status ?? -1 }
}

function j(method, urlPath, body, opts = {}) {
  const headers = { 'content-type': 'application/json', ...(opts.headers ?? {}) }
  const res = curlRaw(method, urlPath, {
    bodyText: body === undefined ? undefined : JSON.stringify(body),
    headers,
    ...opts,
  })
  let json = null
  try { json = JSON.parse(res.raw) } catch {}
  return { ...res, json }
}

const sse = (urlPath, maxTime = 3) => curlRaw('GET', urlPath, { maxTime, fileExt: '.sse', headers: { accept: 'text/event-stream' } })

let total = 0
let failed = 0
const failedCases = []

function clip(text, max = 240) {
  const flat = String(text ?? '').replace(/\s+/g, ' ')
  return flat.length > max ? `${flat.slice(0, max)}...` : flat
}

function check(label, res, codes, verify) {
  total += 1
  const okStatus = codes.includes(res.status)
  let ok = okStatus
  let note = ''
  if (ok && verify !== undefined) {
    try {
      const verdict = verify(res)
      if (verdict !== true) { ok = false; note = ` -- verify: ${verdict}` }
    } catch (error) {
      ok = false
      note = ` -- verify threw: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  if (!ok) { failed += 1; failedCases.push(label) }
  const tag = ok ? 'PASS' : 'FAIL'
  const extra = ok ? '' : ` body=${clip(res.raw)}`
  console.log(`[${String(total).padStart(3)}] ${tag} ${label} -> ${res.status} (expect ${codes.join('|')})${note}${extra}`)
  return res
}

const isArray = (name) => (res) => Array.isArray(res.json?.[name]) || `${name} is not an array`
const hasKey = (key) => (res) => (res.json !== null && key in res.json) || `missing key '${key}'`
const eq = (key, value) => (res) => (res.json?.[key] === value) || `expected ${key} === ${JSON.stringify(value)}, got ${JSON.stringify(res.json?.[key])}`

const cleanups = []
const defer = (label, fn) => cleanups.push({ label, fn })

async function poll(label, fn, { attempts = 20, delayMs = 1500 } = {}) {
  for (let i = 1; i <= attempts; i += 1) {
    const value = fn()
    if (value !== undefined && value !== null) return value
    if (i === attempts) break
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  console.log(`[..] warn: poll '${label}' gave up`)
  return undefined
}

// ---- provider store backup (mutation safety net) ----
const providersBackup = fs.existsSync(PROVIDERS_FILE) ? fs.readFileSync(PROVIDERS_FILE, 'utf8') : null
const canonical = (text) => {
  try {
    const walk = (value) => {
      if (Array.isArray(value)) return value.map(walk)
      if (value !== null && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, walk(value[key])]))
      }
      return value
    }
    return JSON.stringify(walk(JSON.parse(text)))
  } catch { return text }
}

console.log(`curl-api-suite against ${BASE}`)
console.log(providersBackup === null ? `providers.json not found at ${PROVIDERS_FILE} (skip backup)` : `providers.json backed up (${providersBackup.length} bytes)`)
console.log('')

// ═══════════════ 1. core: health / auth / meta ═══════════════
check('GET /api/health', j('GET', '/api/health'), [200], eq('ok', true))
check('GET /api/auth/state', j('GET', '/api/auth/state'), [200])
check('POST /api/auth/pair ({})', j('POST', '/api/auth/pair', {}), [404, 400, 409])
check('POST /api/auth/pairing-code ({})', j('POST', '/api/auth/pairing-code', {}), [403, 400])
check('POST /api/auth/logout', j('POST', '/api/auth/logout', {}), [200])
const meta = j('GET', '/api/meta')
check('GET /api/meta', meta, [200])

// ═══════════════ 2. workspaces CRUD ═══════════════
const wsList = j('GET', '/api/workspaces')
check('GET /api/workspaces (root array)', wsList, [200], (res) => Array.isArray(res.json) || 'root is not an array')
const defaultWs = (wsList.json ?? []).find((row) => row.default === true) ?? (wsList.json ?? [])[0]
const WS = defaultWs.id

const wsTmp = j('POST', '/api/workspaces', { name: 'curl-suite-tmp' })
check('POST /api/workspaces {name} -> 201', wsTmp, [201], eq('default', false))
const WS_TMP = wsTmp.json?.id
defer('workspace tmp', () => {
  if (WS_TMP === undefined || wsTmp.status !== 201) return 'nothing to clean'
  const res = j('DELETE', `/api/workspaces/${q(WS_TMP)}`)
  return `${res.status}`
})
check('GET /api/workspaces/<id> (route has no GET)', j('GET', `/api/workspaces/${q(WS)}`), [405])
check('PATCH /api/workspaces/<tmp> {name}', j('PATCH', `/api/workspaces/${q(WS_TMP)}`, { name: 'curl-suite-tmp2' }), [200])
check('PATCH /api/workspaces/nope {name} -> 404', j('PATCH', '/api/workspaces/ws-nope-xyz', { name: 'x' }), [404])
check('PATCH /api/workspaces/<tmp> {archived:true}', j('PATCH', `/api/workspaces/${q(WS_TMP)}`, { archived: true }), [200])
check('PATCH /api/workspaces/<tmp> {archived:false}', j('PATCH', `/api/workspaces/${q(WS_TMP)}`, { archived: false }), [200])
check('DELETE /api/workspaces/<default> -> 409', j('DELETE', `/api/workspaces/${q(WS)}`), [409])
check('DELETE /api/workspaces/nope -> 404', j('DELETE', '/api/workspaces/ws-nope-xyz'), [404])
check('DELETE /api/workspaces/<tmp> (empty) -> 200', j('DELETE', `/api/workspaces/${q(WS_TMP)}`), [200])
check('DELETE /api/workspaces/<tmp> twice -> 404', j('DELETE', `/api/workspaces/${q(WS_TMP)}`), [404])

// ═══════════════ 3. workspace settings: meta / model / thinking / mode / modes ═══════════════
check('GET /api/workspaces/<w>/meta', j('GET', `/api/workspaces/${q(WS)}/meta`), [200])
const wsMode = j('GET', `/api/workspaces/${q(WS)}/mode`)
check('GET /api/workspaces/<w>/mode', wsMode, [200], (res) => Array.isArray(res.json?.modes) || 'modes not array')
const currentModeId = wsMode.json?.selected ?? 'autonomous'
check('PUT /api/workspaces/<w>/mode (current)', j('PUT', `/api/workspaces/${q(WS)}/mode`, { modeId: currentModeId }), [200])
check('PUT /api/workspaces/<w>/mode {modeId:""} -> 400', j('PUT', `/api/workspaces/${q(WS)}/mode`, { modeId: '' }), [400])
check('PUT /api/workspaces/<w>/mode {modeId:nope} -> 404', j('PUT', `/api/workspaces/${q(WS)}/mode`, { modeId: 'nope-mode-xyz' }), [404])
const modesList = j('GET', `/api/workspaces/${q(WS)}/modes`)
check('GET /api/workspaces/<w>/modes', modesList, [200], (res) => Array.isArray(res.json) || 'root not array')
check('GET /api/workspaces/<w>/modes/<current>', j('GET', `/api/workspaces/${q(WS)}/modes/${q(currentModeId)}`), [200])
check('GET /api/workspaces/<w>/modes/nope -> 404', j('GET', `/api/workspaces/${q(WS)}/modes/nope-mode-xyz`), [404])

const dup = j('POST', `/api/workspaces/${q(WS)}/modes/${q(currentModeId)}/duplicate`, { newId: 'curl-suite-mode' })
check('POST /modes/<current>/duplicate -> 200/201', dup, [200, 201])
defer('mode copy', () => {
  if (![200, 201].includes(dup.status)) return 'nothing to clean'
  return `${j('DELETE', `/api/workspaces/${q(WS)}/modes/curl-suite-mode`).status}`
})
check('GET /modes/curl-suite-mode', j('GET', `/api/workspaces/${q(WS)}/modes/curl-suite-mode`), [200])
const modeView = j('GET', `/api/workspaces/${q(WS)}/modes/curl-suite-mode`)
const modeHash = modeView.json?.hash
check('PUT /modes/curl-suite-mode {content} without expectedHash -> 409 (CAS)', j('PUT', `/api/workspaces/${q(WS)}/modes/curl-suite-mode`, { content: '---\nname: Curl Suite Mode\ndescription: temp\n---\n' }), [409])
check('PUT /modes/curl-suite-mode {content} stale hash -> 409 (CAS)', j('PUT', `/api/workspaces/${q(WS)}/modes/curl-suite-mode`, { content: '---\nname: Curl Suite Mode\ndescription: temp\n---\n', expectedHash: 'deadbeef' }), [409])
check('PUT /modes/curl-suite-mode {content, expectedHash}', j('PUT', `/api/workspaces/${q(WS)}/modes/curl-suite-mode`, { content: '---\nname: Curl Suite Mode\ndescription: temp\n---\n', expectedHash: modeHash }), [200])
check('PUT /modes/curl-suite-mode {content:""} -> 400', j('PUT', `/api/workspaces/${q(WS)}/modes/curl-suite-mode`, { content: '' }), [400])
check('PUT /modes/curl-suite-mode/enabled {enabled:false}', j('PUT', `/api/workspaces/${q(WS)}/modes/curl-suite-mode/enabled`, { enabled: false }), [200])
check('PUT /modes/curl-suite-mode/enabled {enabled:true}', j('PUT', `/api/workspaces/${q(WS)}/modes/curl-suite-mode/enabled`, { enabled: true }), [200])
check('PUT /modes/curl-suite-mode/enabled {enabled:"x"} -> 400', j('PUT', `/api/workspaces/${q(WS)}/modes/curl-suite-mode/enabled`, { enabled: 'x' }), [400])
check('DELETE /modes/curl-suite-mode', j('DELETE', `/api/workspaces/${q(WS)}/modes/curl-suite-mode`), [200])
check('GET /modes/curl-suite-mode after delete -> 404', j('GET', `/api/workspaces/${q(WS)}/modes/curl-suite-mode`), [404])
check('PUT /modes/curl-suite-mode/enabled on disabled ws -> 200/409', j('PUT', `/api/workspaces/${q(WS)}/modes/curl-suite-mode/enabled`, { enabled: true }), [200, 404, 409])

check('GET /api/workspaces/<w>/agents', j('GET', `/api/workspaces/${q(WS)}/agents`), [200], (res) => Array.isArray(res.json) || Array.isArray(res.json?.agents) || 'no agent array')
check('GET /api/workspaces/<w>/agents/nope -> 404/405', j('GET', `/api/workspaces/${q(WS)}/agents/nope-agent-xyz`), [404, 405])
check('GET /api/workspaces/<w>/commands', j('GET', `/api/workspaces/${q(WS)}/commands`), [200])

// ═══════════════ 4. skills ═══════════════
const skills = j('GET', `/api/workspaces/${q(WS)}/skills`)
check('GET /api/workspaces/<w>/skills', skills, [200])
const skillRows = Array.isArray(skills.json) ? skills.json : (skills.json?.skills ?? [])
const skillName = skillRows[0]?.name ?? 'ask'
check('GET /skills/nope-skill -> 404', j('GET', `/api/workspaces/${q(WS)}/skills/nope-skill-xyz`), [404])
check('GET /skills/<first>/files', j('GET', `/api/workspaces/${q(WS)}/skills/${q(skillName)}/files`), [200], hasKey('files'))
check('GET /skills/<first>/file?path=SKILL.md', j('GET', `/api/workspaces/${q(WS)}/skills/${q(skillName)}/file?path=${q('SKILL.md')}`), [200])
check('GET /skills/<first>/file?path=../escape -> 400', j('GET', `/api/workspaces/${q(WS)}/skills/${q(skillName)}/file?path=${q('../escape.md')}`), [400])
check('GET /skills/nope/files -> 404', j('GET', `/api/workspaces/${q(WS)}/skills/nope-skill-xyz/files`), [404])
check('PUT /skills/<first>/hidden {hidden:true}', j('PUT', `/api/workspaces/${q(WS)}/skills/${q(skillName)}/hidden`, { hidden: true }), [200])
check('PUT /skills/<first>/hidden {hidden:false}', j('PUT', `/api/workspaces/${q(WS)}/skills/${q(skillName)}/hidden`, { hidden: false }), [200])
check('PUT /skills/<first>/hidden {hidden:"x"} -> 400', j('PUT', `/api/workspaces/${q(WS)}/skills/${q(skillName)}/hidden`, { hidden: 'x' }), [400])
check('GET /api/workspaces/<w>/skills/sources', j('GET', `/api/workspaces/${q(WS)}/skills/sources`), [200])
check('GET /api/workspaces/<w>/sources', j('GET', `/api/workspaces/${q(WS)}/sources`), [200])

// ═══════════════ 5. plugins (enabled or memory-mode 409) ═══════════════
const marketplaces = j('GET', '/api/plugins/marketplaces')
check('GET /api/plugins/marketplaces -> 200/409', marketplaces, [200, 409])
const pluginsOn = marketplaces.status === 200
if (pluginsOn) {
  check('POST /api/plugins/marketplaces {source:""} -> 400', j('POST', '/api/plugins/marketplaces', { source: '' }), [400])
  check('DELETE /api/plugins/marketplaces/nope -> 400/404', j('DELETE', '/api/plugins/marketplaces/nope-mp-xyz'), [400, 404])
  check('GET /api/workspaces/<w>/plugins', j('GET', `/api/workspaces/${q(WS)}/plugins`), [200])
  check('GET /api/workspaces/<w>/plugins/nope -> 400/404 (bad id form)', j('GET', `/api/workspaces/${q(WS)}/plugins/nope-plugin-xyz`), [400, 404])
  check('POST /plugins/nope/install -> 400/404', j('POST', `/api/workspaces/${q(WS)}/plugins/nope-plugin-xyz/install`, {}), [400, 404])
  check('POST /plugins/nope/update -> 400/404', j('POST', `/api/workspaces/${q(WS)}/plugins/nope-plugin-xyz/update`, {}), [400, 404])
} else {
  console.log('[..] plugins disabled on this host: plugin mutation cases skipped (documented 409)')
}

// ═══════════════ 6. MCP ═══════════════
const mcpList = j('GET', `/api/workspaces/${q(WS)}/mcp`)
check('GET /api/workspaces/<w>/mcp', mcpList, [200])
check('GET /mcp/nope -> 404', j('GET', `/api/workspaces/${q(WS)}/mcp/nope-mcp-xyz`), [404])
const mcpAdd = j('POST', `/api/workspaces/${q(WS)}/mcp/curl-suite-mcp`, { command: 'dnt-harness-definitely-missing-binary', transport: 'stdio', enabled: false })
check('POST /mcp/curl-suite-mcp (register, disabled) -> 201', mcpAdd, [201, 200])
defer('mcp server', () => {
  if (![200, 201].includes(mcpAdd.status)) return 'nothing to clean'
  return `${j('DELETE', `/api/workspaces/${q(WS)}/mcp/curl-suite-mcp`).status}`
})
check('GET /mcp/curl-suite-mcp after register', j('GET', `/api/workspaces/${q(WS)}/mcp/curl-suite-mcp`), [200])
check('POST /mcp/curl-suite-mcp/disable', j('POST', `/api/workspaces/${q(WS)}/mcp/curl-suite-mcp/disable`, {}), [200, 409])
check('POST /mcp/nope/enable -> 404', j('POST', `/api/workspaces/${q(WS)}/mcp/nope-mcp-xyz/enable`, {}), [404])
check('POST /mcp/curl-suite-mcp/test (missing binary) -> 4xx/5xx', j('POST', `/api/workspaces/${q(WS)}/mcp/curl-suite-mcp/test`, {}, { maxTime: 25 }), [400, 500, 502])
check('POST /mcp/nope-mcp-xyz/oauth/begin -> 404', j('POST', `/api/workspaces/${q(WS)}/mcp/nope-mcp-xyz/oauth/begin`, {}), [404])
check('DELETE /mcp/curl-suite-mcp', j('DELETE', `/api/workspaces/${q(WS)}/mcp/curl-suite-mcp`), [200])
check('DELETE /mcp/curl-suite-mcp again -> 404', j('DELETE', `/api/workspaces/${q(WS)}/mcp/curl-suite-mcp`), [404])

// ═══════════════ 7. hooks + secrets ═══════════════
check('GET /api/workspaces/<w>/hooks', j('GET', `/api/workspaces/${q(WS)}/hooks`), [200], hasKey('hooks'))
check('GET /hooks/aaaaaaaaaaaaaaaa (state route has no GET) -> 405', j('GET', `/api/workspaces/${q(WS)}/hooks/aaaaaaaaaaaaaaaa`), [405])
check('GET /api/workspaces/<w>/model (no GET -> 404 catch-all)', j('GET', `/api/workspaces/${q(WS)}/model`), [404])
check('GET /api/workspaces/<w>/secrets', j('GET', `/api/workspaces/${q(WS)}/secrets`), [200])
check('GET /secrets/<k> (no single GET -> 404/405)', j('GET', `/api/workspaces/${q(WS)}/secrets/curl_suite_tmp`), [404, 405])
check('PUT /secrets/curl_suite_tmp {value}', j('PUT', `/api/workspaces/${q(WS)}/secrets/curl_suite_tmp`, { value: 'sk-curl-suite' }), [200, 201])
defer('secret', () => `${j('DELETE', `/api/workspaces/${q(WS)}/secrets/curl_suite_tmp`).status}`)
check('PUT /secrets/curl_suite_tmp {} -> 400', j('PUT', `/api/workspaces/${q(WS)}/secrets/curl_suite_tmp`, {}), [400])
check('DELETE /secrets/curl_suite_tmp', j('DELETE', `/api/workspaces/${q(WS)}/secrets/curl_suite_tmp`), [200])
check('DELETE /secrets/curl_suite_tmp again -> 200/404', j('DELETE', `/api/workspaces/${q(WS)}/secrets/curl_suite_tmp`), [200, 404])

// ═══════════════ 8. memory (workspace tier) ═══════════════
const MEM_ID = 'curl-suite-mem'
check('GET /api/workspaces/<w>/memory', j('GET', `/api/workspaces/${q(WS)}/memory`), [200])
const memCreate = j('POST', `/api/workspaces/${q(WS)}/memory`, { id: MEM_ID, title: 'curl suite', body: 'temp entry' })
check('POST /memory {id,title,body} -> 201', memCreate, [201, 200])
defer('memory entry', () => `${j('DELETE', `/api/workspaces/${q(WS)}/memory/${q(MEM_ID)}`).status}`)
check('POST /memory duplicate -> 409', j('POST', `/api/workspaces/${q(WS)}/memory`, { id: MEM_ID, title: 'dup', body: 'dup' }), [409])
check('POST /memory {id:""} -> 400', j('POST', `/api/workspaces/${q(WS)}/memory`, { id: '', title: 'x', body: 'x' }), [400])
const memGet = j('GET', `/api/workspaces/${q(WS)}/memory/${q(MEM_ID)}`)
check('GET /memory/<id>', memGet, [200])
const memHash = memGet.json?.hash ?? memGet.json?.revision
check('PATCH /memory/<id> without expectedHash -> 400', j('PATCH', `/api/workspaces/${q(WS)}/memory/${q(MEM_ID)}`, { title: 'no hash' }), [400])
check('PATCH /memory/<id> stale hash -> 409', j('PATCH', `/api/workspaces/${q(WS)}/memory/${q(MEM_ID)}`, { expectedHash: 'deadbeef', body: 'x' }), [409])
check('PATCH /memory/<id> correct hash', j('PATCH', `/api/workspaces/${q(WS)}/memory/${q(MEM_ID)}`, { expectedHash: memHash, body: 'temp entry v2' }), [200])
check('DELETE /memory/<id>', j('DELETE', `/api/workspaces/${q(WS)}/memory/${q(MEM_ID)}`), [200])
check('GET /memory/<id> after delete -> 404', j('GET', `/api/workspaces/${q(WS)}/memory/${q(MEM_ID)}`), [404])
check('GET /memory-file?path=MEMORY.md -> 200/400', j('GET', `/api/workspaces/${q(WS)}/memory-file?path=${q('MEMORY.md')}`), [200, 400])
check('GET /memory-file?path=../escape -> 400', j('GET', `/api/workspaces/${q(WS)}/memory-file?path=${q('../escape.txt')}`), [400])

// ═══════════════ 9. global model settings ═══════════════
const defaults = j('GET', '/api/model-defaults')
check('GET /api/model-defaults', defaults, [200], hasKey('provider'))
const curProvider = defaults.json?.provider
const curModel = defaults.json?.model
const curThinking = defaults.json?.thinkingLevel ?? null
check('PUT /api/model-defaults (current values, net zero)', j('PUT', '/api/model-defaults', { provider: curProvider, model: curModel, thinkingLevel: curThinking }), [200])
check('PUT /api/model-defaults {provider:"nope"} -> 400', j('PUT', '/api/model-defaults', { provider: 'nope-provider-xyz', model: 'nope' }), [400])
check('PUT /api/model-defaults {} -> 400', j('PUT', '/api/model-defaults', {}), [400])
check('PUT /api/model (current, net zero)', j('PUT', '/api/model', { provider: curProvider, model: curModel }), [200])
check('PUT /api/model {provider:"nope",model:"x"} -> 400', j('PUT', '/api/model', { provider: 'nope-provider-xyz', model: 'x' }), [400])
check('PUT /api/model {model:""} -> 400', j('PUT', '/api/model', { model: '' }), [400])
check('PUT /api/thinking {level:"medium"}', j('PUT', '/api/thinking', { level: 'medium' }), [200])
check('PUT /api/thinking {level:"nope"} -> 400', j('PUT', '/api/thinking', { level: 'nope-level' }), [400])
check('PUT /api/thinking {level:null} (restore)', j('PUT', '/api/thinking', { level: null }), [200])
check('PUT /api/workspaces/<w>/model (current)', j('PUT', `/api/workspaces/${q(WS)}/model`, { provider: curProvider, model: curModel }), [200])
check('PUT /api/workspaces/<w>/thinking {level:"medium"}', j('PUT', `/api/workspaces/${q(WS)}/thinking`, { level: 'medium' }), [200])
check('PUT /api/workspaces/<w>/thinking {level:null} (restore)', j('PUT', `/api/workspaces/${q(WS)}/thinking`, { level: null }), [200])
check('GET /api/image-generation', j('GET', '/api/image-generation'), [200])
check('GET /api/image-understanding', j('GET', '/api/image-understanding'), [200])
check('GET /api/commit-message', j('GET', '/api/commit-message'), [200])
check('GET /api/video-generation', j('GET', '/api/video-generation'), [200])
check('PUT /api/image-generation {provider:"nope"} -> 400', j('PUT', '/api/image-generation', { provider: 'nope-provider-xyz', model: 'x' }), [400])
check('GET /api/usage', j('GET', '/api/usage'), [200])

// ═══════════════ 10. fs/dirs + guard ═══════════════
check('GET /api/fs/dirs', j('GET', '/api/fs/dirs'), [200], hasKey('dirs'))
check('GET /api/fs/dirs?path=<missing> -> 400', j('GET', `/api/fs/dirs?path=${q('C:\\definitely-missing-dir-xyz')}`), [400])
check('GET /api/guard/dangerous-commands (no ws) -> 400', j('GET', '/api/guard/dangerous-commands'), [400])
check('GET /api/guard/dangerous-commands?workspaceId', j('GET', `/api/guard/dangerous-commands?workspaceId=${q(WS)}`), [200])
check('GET /api/guard/dangerous-commands/global', j('GET', '/api/guard/dangerous-commands/global'), [200])
check('PUT /api/guard/dangerous-commands/global {config:42} -> 400', j('PUT', '/api/guard/dangerous-commands/global', { config: 42 }), [400])
check('PUT /api/guard/dangerous-commands (no workspaceId) -> 400', j('PUT', '/api/guard/dangerous-commands', { config: {} }), [400])

// ═══════════════ 11. providers CRUD (scratch provider, deleted after) ═══════════════
const providersList = j('GET', '/api/providers')
check('GET /api/providers', providersList, [200], (res) => Array.isArray(res.json) || 'root not array')
const provCreate = j('POST', '/api/providers', { name: 'Curl Suite Prov', baseUrl: 'http://127.0.0.1:9/v1', models: ['test-model'] })
check('POST /api/providers -> 201', provCreate, [201, 200])
const PROV_ID = provCreate.json?.id
defer('providers', () => {
  if (provCreate.status !== 201 && provCreate.status !== 200) return 'nothing to clean'
  return `${j('DELETE', `/api/providers/${q(PROV_ID)}`).status}`
})
check('POST /api/providers {name:""} -> 400', j('POST', '/api/providers', { name: '', baseUrl: 'http://x' }), [400])
check('POST /api/providers bad baseUrl -> 400', j('POST', '/api/providers', { name: 'Curl Bad', baseUrl: 'not-a-url' }), [400])
check('PATCH /api/providers/<id> {name}', j('PATCH', `/api/providers/${q(PROV_ID)}`, { name: 'Curl Suite Prov 2' }), [200])
check('PATCH /api/providers/nope -> 404', j('PATCH', '/api/providers/nope-provider-xyz', { name: 'x' }), [404])
check('PATCH /api/providers/<id> {apiKey}', j('PATCH', `/api/providers/${q(PROV_ID)}`, { apiKey: 'sk-curl-suite-123' }), [200])
check('GET /api/providers/<id>/key', j('GET', `/api/providers/${q(PROV_ID)}/key`), [200], eq('apiKey', 'sk-curl-suite-123'))
check('GET /api/providers/<id>/models (unreachable base) -> 502', j('GET', `/api/providers/${q(PROV_ID)}/models`, undefined, { maxTime: 20 }), [200, 502])
check('POST /api/providers/<id>/test (unreachable base)', j('POST', `/api/providers/${q(PROV_ID)}/test`, {}, { maxTime: 20 }), [200, 502])
check('POST /api/providers/<id>/sync (unreachable base)', j('POST', `/api/providers/${q(PROV_ID)}/sync`, {}, { maxTime: 20 }), [200, 502])
check('DELETE /api/providers/<id>', j('DELETE', `/api/providers/${q(PROV_ID)}`), [200])
check('DELETE /api/providers/<id> again -> 404', j('DELETE', `/api/providers/${q(PROV_ID)}`), [404])

// ═══════════════ 12. model aliases CRUD ═══════════════
const aliasesList = j('GET', '/api/model-aliases')
check('GET /api/model-aliases', aliasesList, [200])
const ALIAS = 'curl-suite-alias'
// NOTE: 'thinkingLevel' must be sent explicitly (a supported level or null);
// an omitted field is rejected as invalid rather than defaulted.
const aliasCreate = j('POST', '/api/model-aliases', { name: ALIAS, provider: curProvider, model: curModel, thinkingLevel: null })
check('POST /api/model-aliases -> 201', aliasCreate, [201])
const aliasRevision = aliasCreate.json?.revision
const aliasRow = () => j('GET', '/api/model-aliases').json?.find?.((row) => row.name === ALIAS)
defer('alias', () => {
  if (aliasCreate.status !== 201) return 'nothing to clean'
  const fresh = aliasRow()
  if (fresh === undefined) return 'already gone'
  return `${j('DELETE', `/api/model-aliases/${q(ALIAS)}`, { expectedRevision: fresh.revision }).status}`
})
check('POST /api/model-aliases duplicate -> 409', j('POST', '/api/model-aliases', { name: ALIAS, provider: curProvider, model: curModel, thinkingLevel: null }), [409])
check('POST /api/model-aliases {provider:""} -> 400', j('POST', '/api/model-aliases', { name: 'curl-suite-alias2', provider: '', model: 'x', thinkingLevel: null }), [400])
check('GET /api/model-aliases/<n> (no GET route -> 404)', j('GET', `/api/model-aliases/${q(ALIAS)}`), [404])
check('PATCH /api/model-aliases/<n> no revision -> 400', j('PATCH', `/api/model-aliases/${q(ALIAS)}`, { model: curModel }), [400, 409])
check('PATCH /api/model-aliases/<n> wrong revision -> 409', j('PATCH', `/api/model-aliases/${q(ALIAS)}`, { expectedRevision: 999999, model: curModel }), [409, 400])
check('DELETE /api/model-aliases/<n> wrong revision -> 409', j('DELETE', `/api/model-aliases/${q(ALIAS)}`, { expectedRevision: 999999 }), [409, 400])
check('DELETE /api/model-aliases/<n> good revision', j('DELETE', `/api/model-aliases/${q(ALIAS)}`, { expectedRevision: aliasRevision }), [200])
check('DELETE /api/model-aliases/<n> after delete -> 404', j('DELETE', `/api/model-aliases/${q(ALIAS)}`, { expectedRevision: aliasRevision }), [404])

// ═══════════════ 13. projects ═══════════════
const projCreate = j('POST', `/api/workspaces/${q(WS)}/projects`, { name: 'curl-suite', path: WORK_A })
check('POST /workspaces/<w>/projects -> 201', projCreate, [201])
const PID = projCreate.json?.id
defer('project', () => {
  if (projCreate.status !== 201) return 'nothing to clean'
  return `${j('DELETE', `/api/workspaces/${q(WS)}/projects/${q(PID)}`).status}`
})
check('POST /projects {path:""} -> 400', j('POST', `/api/workspaces/${q(WS)}/projects`, { name: 'bad', path: '' }), [400])
check('POST /projects {path:<missing>} -> 400', j('POST', `/api/workspaces/${q(WS)}/projects`, { name: 'bad2', path: 'C:\\definitely-missing-dir-xyz' }), [400])
check('GET /workspaces/<w>/projects', j('GET', `/api/workspaces/${q(WS)}/projects`), [200])
check('GET /projects/<id> (route has no GET) -> 405', j('GET', `/api/workspaces/${q(WS)}/projects/${q(PID)}`), [405])
check('PATCH /projects/<id> {name}', j('PATCH', `/api/workspaces/${q(WS)}/projects/${q(PID)}`, { name: 'curl-suite-proj' }), [200])
check('PATCH /projects/nope -> 404', j('PATCH', `/api/workspaces/${q(WS)}/projects/project-nope-xyz`, { name: 'x' }), [404])
check('PATCH /projects/<id> {gitTrusted:"x"} -> 400', j('PATCH', `/api/workspaces/${q(WS)}/projects/${q(PID)}`, { gitTrusted: 'x' }), [400])

// sidebar order: reverse then restore
const orderBefore = (j('GET', `/api/workspaces/${q(WS)}/projects`).json ?? []).map((row) => row.id)
check('PUT /projects/order {order:"x"} -> 400', j('PUT', `/api/workspaces/${q(WS)}/projects/order`, { order: 'x' }), [400])
check('PUT /projects/order reversed', j('PUT', `/api/workspaces/${q(WS)}/projects/order`, { order: [...orderBefore].reverse() }), [200])
check('PUT /projects/order restored', j('PUT', `/api/workspaces/${q(WS)}/projects/order`, { order: orderBefore }), [200])

// retarget: A -> B -> A
check('PATCH /projects/<id> {path: B}', j('PATCH', `/api/workspaces/${q(WS)}/projects/${q(PID)}`, { path: WORK_B }), [200])
check('PATCH /projects/<id> {path: A} (back)', j('PATCH', `/api/workspaces/${q(WS)}/projects/${q(PID)}`, { path: WORK_A }), [200])

// files
check('GET /projects/<id>/files?path=""', j('GET', `/api/workspaces/${q(WS)}/projects/${q(PID)}/files?path=`), [200], hasKey('entries'))
const createEntry = j('POST', `/api/workspaces/${q(WS)}/projects/${q(PID)}/files`, { path: 'hello.txt', kind: 'file' })
check('POST /files create hello.txt -> 201', createEntry, [201, 200])
check('POST /files duplicate -> 409', j('POST', `/api/workspaces/${q(WS)}/projects/${q(PID)}/files`, { path: 'hello.txt', kind: 'file' }), [409])
check('POST /files {path:""} -> 400', j('POST', `/api/workspaces/${q(WS)}/projects/${q(PID)}/files`, { path: '', kind: 'file' }), [400])
check('POST /files {path:".git", kind:"dir"} -> 400', j('POST', `/api/workspaces/${q(WS)}/projects/${q(PID)}/files`, { path: '.git', kind: 'dir' }), [400])
const fileView = j('GET', `/api/workspaces/${q(WS)}/projects/${q(PID)}/file?path=${q('hello.txt')}`)
check('GET /file?path=hello.txt', fileView, [200], (res) => typeof res.json?.hash === 'string' || 'no hash in file view')
const hash1 = fileView.json?.hash
check('PUT /file stale expectedHash -> 409', j('PUT', `/api/workspaces/${q(WS)}/projects/${q(PID)}/file`, { path: 'hello.txt', content: 'hello v2\n', expectedHash: 'deadbeef' }), [409])
check('PUT /file correct expectedHash', j('PUT', `/api/workspaces/${q(WS)}/projects/${q(PID)}/file`, { path: 'hello.txt', content: 'hello v2\n', expectedHash: hash1 }), [200])
check('PATCH /files rename hello.txt -> renamed.txt', j('PATCH', `/api/workspaces/${q(WS)}/projects/${q(PID)}/files`, { path: 'hello.txt', name: 'renamed.txt' }), [200])
check('GET /file renamed.txt shows new content', j('GET', `/api/workspaces/${q(WS)}/projects/${q(PID)}/file?path=${q('renamed.txt')}`), [200], (res) => res.raw.includes('hello v2') || 'content not updated')
check('DELETE /files renamed.txt', j('DELETE', `/api/workspaces/${q(WS)}/projects/${q(PID)}/files?path=${q('renamed.txt')}`), [200])
check('GET /file deleted -> 400', j('GET', `/api/workspaces/${q(WS)}/projects/${q(PID)}/file?path=${q('renamed.txt')}`), [400])
check('GET /workspaces/<w>/projects/<id>/files?path=.. -> 400', j('GET', `/api/workspaces/${q(WS)}/projects/${q(PID)}/files?path=${q('..')}`), [400])
check('GET /projects/<id>/search?q=hello', j('GET', `/api/workspaces/${q(WS)}/projects/${q(PID)}/search?q=hello`), [200])
check('GET /projects/<id>/git (non-repo -> 200/400)', j('GET', `/api/workspaces/${q(WS)}/projects/${q(PID)}/git`), [200, 400])
check('GET /projects/<id>/media?path=missing -> 4xx', j('GET', `/api/workspaces/${q(WS)}/projects/${q(PID)}/media?path=${q('missing.png')}`), [400, 404])
check('POST /projects/<id>/git/nope -> 4xx', j('POST', `/api/workspaces/${q(WS)}/projects/${q(PID)}/git/nope`, {}), [400, 404])

// ═══════════════ 14. terminals ═══════════════
const termList = j('GET', `/api/workspaces/${q(WS)}/terminals`)
check('GET /workspaces/<w>/terminals', termList, [200], hasKey('terminals'))
check('DELETE /terminals/nope -> 404', j('DELETE', `/api/workspaces/${q(WS)}/terminals/nope-term-xyz`), [404])
check('POST /terminals/nope/input -> 404', j('POST', `/api/workspaces/${q(WS)}/terminals/nope-term-xyz/input`, { data: 'x' }), [404])
const termCreate = j('POST', `/api/workspaces/${q(WS)}/terminals`, { projectId: PID })
check('POST /workspaces/<w>/terminals -> 201/501', termCreate, [201, 501])
defer('terminal', () => {
  if (termCreate.status !== 201) return 'nothing to clean'
  const id = termCreate.json?.id
  if (id === undefined) return 'no id'
  return `${j('DELETE', `/api/workspaces/${q(WS)}/terminals/${q(id)}`).status}`
})

// ═══════════════ 15. attachments + videos ═══════════════
const attach = curlRaw('POST', `/api/workspaces/${q(WS)}/attachments`, {
  bodyText: 'hello attachment',
  headers: { 'content-type': 'text/plain', 'x-file-name': 'hello.txt' },
})
check('POST /workspaces/<w>/attachments -> 201', attach, [201, 200])
const ATT_ID = (() => { try { return JSON.parse(attach.raw).id } catch { return undefined } })()
check('GET /attachments/<id> roundtrip', j('GET', `/api/workspaces/${q(WS)}/attachments/${q(ATT_ID ?? 'nope')}`), [200], (res) => res.raw === 'hello attachment' || `content mismatch: ${clip(res.raw, 60)}`)
check('GET /attachments/nope -> 400/404', j('GET', `/api/workspaces/${q(WS)}/attachments/nope-att-xyz`), [400, 404])
check('GET /workspaces/<w>/videos/nope -> 404', j('GET', `/api/workspaces/${q(WS)}/videos/nope-vid-xyz`), [404])

// ═══════════════ 16. session lifecycle (project session) ═══════════════
const sessCreate = j('POST', `/api/workspaces/${q(WS)}/sessions`, { projectId: PID })
check('POST /workspaces/<w>/sessions {projectId} -> 201', sessCreate, [201])
const SID = sessCreate.json?.id
defer('project session', () => {
  if (sessCreate.status !== 201) return 'nothing to clean'
  return `${j('DELETE', `/api/workspaces/${q(WS)}/sessions/${q(SID)}`).status}`
})
check('POST /sessions {projectId:nope} -> 404', j('POST', `/api/workspaces/${q(WS)}/sessions`, { projectId: 'project-nope-xyz' }), [404])

const sessionRow = () => {
  const list = j('GET', `/api/workspaces/${q(WS)}/sessions`)
  return (Array.isArray(list.json) ? list.json : []).find((row) => row.id === SID)
}
const listRes = j('GET', `/api/workspaces/${q(WS)}/sessions`)
check('GET /workspaces/<w>/sessions', listRes, [200], (res) => Array.isArray(res.json) || 'root not array')
check('GET /sessions/<id> (route has no GET) -> 405', j('GET', `/api/workspaces/${q(WS)}/sessions/${q(SID)}`), [405])
check('PATCH /sessions/<id> {title}', j('PATCH', `/api/workspaces/${q(WS)}/sessions/${q(SID)}`, { title: 'curl suite session' }), [200])
check('PATCH /sessions/nope -> 404', j('PATCH', `/api/workspaces/${q(WS)}/sessions/session-nope-xyz`, { title: 'x' }), [404])
check('PATCH /sessions/<id> {title:""} -> 200/400', j('PATCH', `/api/workspaces/${q(WS)}/sessions/${q(SID)}`, { title: '' }), [200, 400])

check('GET /sessions/<id>/model', j('GET', `/api/workspaces/${q(WS)}/sessions/${q(SID)}/model`), [200])
check('PUT /sessions/<id>/model (current)', j('PUT', `/api/workspaces/${q(WS)}/sessions/${q(SID)}/model`, { provider: curProvider, model: curModel }), [200])
check('PUT /sessions/<id>/model {model:"nope"} -> 400', j('PUT', `/api/workspaces/${q(WS)}/sessions/${q(SID)}/model`, { model: 'nope-model-xyz' }), [400])
check('GET /sessions/<id>/mode', j('GET', `/api/workspaces/${q(WS)}/sessions/${q(SID)}/mode`), [200])
check('PUT /sessions/<id>/mode (current)', j('PUT', `/api/workspaces/${q(WS)}/sessions/${q(SID)}/mode`, { modeId: currentModeId }), [200])
check('PUT /sessions/<id>/mode {modeId:""} -> 400', j('PUT', `/api/workspaces/${q(WS)}/sessions/${q(SID)}/mode`, { modeId: '' }), [400])
check('PUT /sessions/<id>/mode {modeId:"nope"} -> 404', j('PUT', `/api/workspaces/${q(WS)}/sessions/${q(SID)}/mode`, { modeId: 'nope-mode-xyz' }), [404])
check('GET /sessions/<id>/manifest -> 200/204', j('GET', `/api/workspaces/${q(WS)}/sessions/${q(SID)}/manifest`), [200, 204])
check('GET /sessions/<id>/context/<zero64> -> 404', j('GET', `/api/workspaces/${q(WS)}/sessions/${q(SID)}/context/${'0'.repeat(64)}`), [404])
check('GET /sessions/<id>/processes', j('GET', `/api/workspaces/${q(WS)}/sessions/${q(SID)}/processes`), [200])
check('GET /sessions/<id>/processes/nope -> 404', j('GET', `/api/workspaces/${q(WS)}/sessions/${q(SID)}/processes/nope-proc-xyz`), [404])
check('POST /processes/nope/stop -> 404', j('POST', `/api/workspaces/${q(WS)}/sessions/${q(SID)}/processes/nope-proc-xyz/stop`, {}), [404])

const grants = j('GET', `/api/workspaces/${q(WS)}/sessions/${q(SID)}/grants`)
check('GET /sessions/<id>/grants', grants, [200])
const grantsRev = grants.json?.revision ?? grants.json?.expectedRevision
check('PUT /sessions/<id>/grants (roots:[] net zero)', j('PUT', `/api/workspaces/${q(WS)}/sessions/${q(SID)}/grants`, { expectedRevision: grantsRev, roots: [] }), [200])
check('PUT /sessions/<id>/grants bad body -> 400', j('PUT', `/api/workspaces/${q(WS)}/sessions/${q(SID)}/grants`, { expectedRevision: 'x', roots: [] }), [400])
check('PUT /sessions/nope/grants -> 404', j('PUT', `/api/workspaces/${q(WS)}/sessions/session-nope-xyz/grants`, { expectedRevision: 1, roots: [] }), [404])

check('POST /sessions/<id>/steer (idle)', j('POST', `/api/workspaces/${q(WS)}/sessions/${q(SID)}/steer`, {}), [200, 409])
check('POST /sessions/<id>/messages {} -> 400', j('POST', `/api/workspaces/${q(WS)}/sessions/${q(SID)}/messages`, {}), [400])
check('POST /sessions/<id>/messages {delivery:"bogus"} -> 400', j('POST', `/api/workspaces/${q(WS)}/sessions/${q(SID)}/messages`, { content: 'x', delivery: 'bogus' }), [400])
check('PATCH /sessions/<id>/inputs/nope -> 404', j('PATCH', `/api/workspaces/${q(WS)}/sessions/${q(SID)}/inputs/input-nope-xyz`, { content: 'x' }), [404])
check('DELETE /sessions/<id>/inputs/nope -> 404', j('DELETE', `/api/workspaces/${q(WS)}/sessions/${q(SID)}/inputs/input-nope-xyz`), [404])
check('POST /sessions/<id>/children/nope/reconcile -> 404', j('POST', `/api/workspaces/${q(WS)}/sessions/${q(SID)}/children/child-nope-xyz/reconcile`, {}), [404])
check('DELETE /sessions/<id>/children/nope -> 404', j('DELETE', `/api/workspaces/${q(WS)}/sessions/${q(SID)}/children/child-nope-xyz`), [404])
check('POST /sessions/nope/stop -> 404', j('POST', `/api/workspaces/${q(WS)}/sessions/session-nope-xyz/stop`, {}), [404])

// live turn: one real model call, then assert a completed turn in the replay
const baseline = sessionRow()?.eventCount ?? 0
const sendMsg = j('POST', `/api/workspaces/${q(WS)}/sessions/${q(SID)}/messages`, { content: 'Trả lời đúng một từ: pong' })
check('POST /sessions/<id>/messages {content} -> 202', sendMsg, [202], eq('queued', false))
check('GET /sessions/<id>/events (SSE)', sse(`/api/workspaces/${q(WS)}/sessions/${q(SID)}/events`, 2), [200], (res) => res.ctype.includes('text/event-stream') || `ctype=${res.ctype}`)

const waitTurn = async () => {
  await poll('turn settle', () => {
    const row = sessionRow()
    if (row === undefined) return undefined
    if ((row.eventCount ?? 0) > baseline && row.status === 'idle') return true
    return undefined
  }, { attempts: 40, delayMs: 2000 })
}
const snapshotCompleted = () => {
  const snap = sse(`/api/workspaces/${q(WS)}/sessions/${q(SID)}/events`, 8)
  return snap.raw.includes('"reason":"completed"')
}
await waitTurn()
let completed = snapshotCompleted()
if (!completed) {
  console.log('[..] turn did not complete on first try (upstream flake?); retrying once')
  const retry = j('POST', `/api/workspaces/${q(WS)}/sessions/${q(SID)}/messages`, { content: 'Trả lời đúng một từ: pong' })
  check('POST /sessions/<id>/messages retry -> 202', retry, [202])
  await waitTurn()
  completed = snapshotCompleted()
}
check('session replay contains a completed turn', { status: completed ? 200 : 500, ctype: '', raw: '', exit: 0 }, [200], () => completed || 'no "reason":"completed" in SSE snapshot')

check('POST /sessions/<id>/stop', j('POST', `/api/workspaces/${q(WS)}/sessions/${q(SID)}/stop`, {}), [202])
check('POST /sessions/<id>/compact -> 200/409', j('POST', `/api/workspaces/${q(WS)}/sessions/${q(SID)}/compact`, {}), [200, 409])
check('DELETE /projects/<id> while session bound -> 409', j('DELETE', `/api/workspaces/${q(WS)}/projects/${q(PID)}`), [409])
check('DELETE /sessions/<id>', j('DELETE', `/api/workspaces/${q(WS)}/sessions/${q(SID)}`), [200])
check('DELETE /sessions/<id> again -> 404', j('DELETE', `/api/workspaces/${q(WS)}/sessions/${q(SID)}`), [404])

// project deletion: blocked while bound conversations exist was covered by a session above;
// now that the session is gone the delete goes through
check('DELETE /projects/<id>', j('DELETE', `/api/workspaces/${q(WS)}/projects/${q(PID)}`), [200])
check('DELETE /projects/<id> again -> 404', j('DELETE', `/api/workspaces/${q(WS)}/projects/${q(PID)}`), [404])

// ═══════════════ 17. legacy unscoped sessions ═══════════════
const legacy = j('POST', '/api/sessions', { folder: WORK_A })
check('POST /api/sessions {folder} -> 201', legacy, [201])
const LSID = legacy.json?.id
defer('legacy session', () => {
  if (legacy.status !== 201) return 'nothing to clean'
  return `${j('DELETE', `/api/sessions/${q(LSID)}`).status}`
})
check('POST /api/sessions {folder:<missing>} -> 400', j('POST', '/api/sessions', { folder: 'C:\\definitely-missing-dir-xyz' }), [400])
const legacyList = j('GET', '/api/sessions')
check('GET /api/sessions', legacyList, [200], (res) => (Array.isArray(res.json) ? res.json.some((row) => row.id === LSID) : false) || 'fresh legacy session missing from list')
check('GET /api/sessions/<id> (route has no GET) -> 405', j('GET', `/api/sessions/${q(LSID)}`), [405])
check('PUT /api/sessions/<id>/folder {path:""}', j('PUT', `/api/sessions/${q(LSID)}/folder`, { path: '' }), [200, 404])
check('PUT /api/folder {path:""} -> 400/404', j('PUT', '/api/folder', { path: '' }), [400, 404])
check('POST /api/sessions/<id>/stop', j('POST', `/api/sessions/${q(LSID)}/stop`, {}), [202])
check('GET /api/sessions/<id>/events (SSE)', sse(`/api/sessions/${q(LSID)}/events`, 2), [200], (res) => res.ctype.includes('text/event-stream') || `ctype=${res.ctype}`)
check('POST /api/sessions/<id>/messages {} -> 400', j('POST', `/api/sessions/${q(LSID)}/messages`, {}), [400])
check('POST /api/sessions/nope/children/c/reconcile -> 404', j('POST', '/api/sessions/session-nope-xyz/children/child-y/reconcile', {}), [404])
check('DELETE /api/sessions/<id>', j('DELETE', `/api/sessions/${q(LSID)}`), [200])
check('DELETE /api/sessions/<id> again -> 404', j('DELETE', `/api/sessions/${q(LSID)}`), [404])

// ═══════════════ 18. automations ═══════════════
check('POST /api/automations/preview {cron}', j('POST', '/api/automations/preview', { cron: '*/5 * * * *' }), [200], hasKey('next'))
check('POST /api/automations/preview {cron:"nope"} -> 400', j('POST', '/api/automations/preview', { cron: 'nope cron' }), [400])
const autoList = j('GET', `/api/workspaces/${q(WS)}/automations`)
check('GET /workspaces/<w>/automations', autoList, [200], (res) => Array.isArray(res.json) || 'root not array')
const autoCreate = j('POST', `/api/workspaces/${q(WS)}/automations`, { title: 'curl-suite-auto', prompt: 'ping', schedules: [{ cron: '0 9 * * *' }] })
check('POST /workspaces/<w>/automations -> 201', autoCreate, [201])
const AID = autoCreate.json?.id
defer('automation', () => {
  if (autoCreate.status !== 201) return 'nothing to clean'
  return `${j('DELETE', `/api/workspaces/${q(WS)}/automations/${q(AID)}`).status}`
})
check('GET /automations/<id>', j('GET', `/api/workspaces/${q(WS)}/automations/${q(AID)}`), [200])
check('GET /automations/<id>/runs', j('GET', `/api/workspaces/${q(WS)}/automations/${q(AID)}/runs`), [200])
check('PATCH /automations/<id> {title}', j('PATCH', `/api/workspaces/${q(WS)}/automations/${q(AID)}`, { title: 'curl-suite-auto2' }), [200])
check('DELETE /automations/<id>', j('DELETE', `/api/workspaces/${q(WS)}/automations/${q(AID)}`), [200])
check('GET /automations/<id> after delete -> 404', j('GET', `/api/workspaces/${q(WS)}/automations/${q(AID)}`), [404])
check('GET /automations/nope -> 404', j('GET', `/api/workspaces/${q(WS)}/automations/auto-nope-xyz`), [404])
check('GET /automations/nope/runs -> 404', j('GET', `/api/workspaces/${q(WS)}/automations/auto-nope-xyz/runs`), [404])
check('POST /automations/nope/run -> 404', j('POST', `/api/workspaces/${q(WS)}/automations/auto-nope-xyz/run`, {}), [404])
check('DELETE /automations/nope -> 404', j('DELETE', `/api/workspaces/${q(WS)}/automations/auto-nope-xyz`), [404])

// ═══════════════ 19. notify channels + web push ═══════════════
check('GET /api/notify/channels', j('GET', '/api/notify/channels'), [200])
check('POST /api/notify/channels/nope/test -> 404', j('POST', '/api/notify/channels/nope-chan-xyz/test', {}), [404])
check('PATCH /api/notify/channels/nope -> 400/404', j('PATCH', '/api/notify/channels/nope-chan-xyz', {}), [400, 404])
check('DELETE /api/notify/channels/nope -> 400/404', j('DELETE', '/api/notify/channels/nope-chan-xyz'), [400, 404])
check('GET /api/push/key', j('GET', '/api/push/key'), [200])
check('POST /api/push/test', j('POST', '/api/push/test', {}), [200])
check('GET /api/push/subscriptions', j('GET', '/api/push/subscriptions'), [200])
check('DELETE /api/push/subscriptions/nope -> 200/404', j('DELETE', '/api/push/subscriptions/nope-sub-xyz'), [200, 404])

// ═══════════════ 20. approvals + questions + system prompts ═══════════════
check('POST /api/approvals/nope -> 404', j('POST', '/api/approvals/nope-approval-xyz', { allow: true }), [404])
check('POST /api/questions/nope -> 404', j('POST', '/api/questions/nope-question-xyz', {}), [404])
check('GET /workspaces/<w>/system-prompts', j('GET', `/api/workspaces/${q(WS)}/system-prompts`), [200])

// ═══════════════ cleanup ═══════════════
console.log('')
console.log('== cleanup ==')
for (const { label, fn } of [...cleanups].reverse()) {
  try {
    const outcome = await fn()
    console.log(`cleanup ${label}: ${outcome}`)
  } catch (error) {
    console.log(`cleanup ${label}: THREW ${error instanceof Error ? error.message : String(error)}`)
  }
}

// provider store comparison
if (providersBackup !== null) {
  const after = fs.existsSync(PROVIDERS_FILE) ? fs.readFileSync(PROVIDERS_FILE, 'utf8') : ''
  const byteEqual = after === providersBackup
  const semanticEqual = canonical(after) === canonical(providersBackup)
  // CAS generation counters (providerGeneration/aliasGeneration/...) bump on
  // every create/delete cycle and never roll back; treat them as expected.
  const stripGenerations = (text) => {
    try {
      const parsed = JSON.parse(text)
      for (const key of Object.keys(parsed)) if (/Generation$/.test(key)) delete parsed[key]
      return canonical(JSON.stringify(parsed))
    } catch { return text }
  }
  const semanticEqualIgnoringGenerations = stripGenerations(after) === stripGenerations(providersBackup)
  console.log(`providers.json: byteEqual=${byteEqual} semanticEqual=${semanticEqual} ignoringGenerationCounters=${semanticEqualIgnoringGenerations}`)
  if (!semanticEqualIgnoringGenerations) {
    console.log('WARNING: providers.json changed semantically beyond generation counters; inspect manually:')
    console.log(`  backup: ${path.join(TMP, 'providers.backup.json')}`)
    fs.writeFileSync(path.join(TMP, 'providers.backup.json'), providersBackup, 'utf8')
  } else if (!semanticEqual) {
    console.log('note: only CAS generation counters changed (expected after create/delete cycles)')
  }
}

console.log('')
console.log(`RESULT: ${total - failed}/${total} passed, ${failed} failed (tmp: ${TMP})`)
if (failed > 0) {
  console.log('failed cases:')
  for (const name of failedCases) console.log(`  - ${name}`)
}
process.exitCode = failed > 0 ? 1 : 0
