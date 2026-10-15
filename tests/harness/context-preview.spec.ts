import { describe, expect, it } from 'vitest'
import * as builder from '../../src/harness/context/builder.ts'
import { BUNDLED_MODES, DEFAULT_MODE_ID } from '../../src/harness/modes/bundled.ts'
import { DEFAULT_BUDGET } from '../../src/harness/context/budget.ts'
import { row } from '../fixtures/context-accounting.ts'

const closed = [row(1,{type:'turn/start',turnId:'t1'}),row(2,{type:'user/message',turnId:'t1',content:'first'}),
  row(3,{type:'assistant/message',stepId:'s1',content:'x'.repeat(1_100_000)}),row(4,{type:'turn/end',turnId:'t1',reason:'completed'}),
  row(5,{type:'turn/start',turnId:'t2'}),row(6,{type:'user/message',turnId:'t2',content:'second'}),
  row(7,{type:'assistant/message',stepId:'s2',content:'answer'}),row(8,{type:'turn/end',turnId:'t2',reason:'completed'})]
const input = () => ({events:closed,mode:{definition:BUNDLED_MODES.find(m=>m.id===DEFAULT_MODE_ID)!,source:'bundled' as const},
  modeRevision:1,model:'scripted',providerName:'scripted',schemas:[],activeSkills:[],pinnedMemory:[],budget:DEFAULT_BUDGET})

describe('prospective compact context',()=>{
  it('rebuilds full nonzero estimate without inventing a canonical event',()=>{
    const before=builder.buildContext(input())
    const after=builder.buildContextPreview(input(),{checkpoint:{summary:'SUMMARY',coversSeq:8}})
    expect(before.manifest.budget.preTrimTokens).toBeGreaterThan(before.manifest.budget.availableTokens)
    expect(after.manifest.budget.usedTokens).toBeGreaterThan(0)
    expect(Object.values(after.manifest.breakdown).reduce((a,b)=>a+b,0)).toBe(after.manifest.budget.usedTokens)
    expect(after.manifest.history.compactedThroughSeq).toBe(8)
    expect(closed.some(e=>e.type==='compaction/end')).toBe(false)
  })
  it('measures wrapped restoration once and preserves later tail',()=>{
    const after=builder.buildContextPreview(input(),{checkpoint:{summary:'SUMMARY',coversSeq:4},
      restoration:{body:'RESTORED_NEW',tokens:3,sections:[]},protectUncoveredHistory:true})
    expect(after.messages.filter(m=>String(m.content).includes('RESTORED_NEW'))).toHaveLength(1)
    expect(after.messages.some(m=>String(m.content).includes('second'))).toBe(true)
    expect(Object.values(after.manifest.breakdown).reduce((a,b)=>a+b,0)).toBe(after.manifest.budget.usedTokens)
  })
  it('refuses invalid boundary and an uncovered tail that would be dropped',()=>{
    expect(()=>builder.buildContextPreview(input(),{checkpoint:{summary:'SUMMARY',coversSeq:3}})).toThrow(/boundary/)
    expect(()=>builder.buildContextPreview({...input(),budget:{...DEFAULT_BUDGET,contextLimitTokens:100}},
      {checkpoint:{summary:'SUMMARY',coversSeq:4},protectUncoveredHistory:true})).toThrow()
  })
})
