import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createWebServer, type LlmProvider, type WebServer } from '../../src/index.ts'
import { FileSessionStore } from '../../src/harness/storage/file-session-store.ts'
import type { SessionId } from '../../src/util/brand.ts'
import { projectItems } from '../../web/lib/project.ts'
import { projectTrajectory } from '../../web/components/workbench/trajectory.ts'

const provider: LlmProvider = { name:'scripted', models:['scripted'], async *stream(request) {
  const summary=request.messages.some(m=>String(m.content).includes('Primary Request and Intent'))
  yield {type:'delta',delta:summary?'SUMMARY':'hello'}
  yield {type:'usage',usage:{inputTokens:100_000,cachedInputTokens:50_000}}
  yield {type:'usage',usage:{inputTokens:120_000,cachedInputTokens:110_000}}
  yield {type:'completion',finishReason:'stop',transport:'done',policy:'strict',transportSettled:true}
} }

describe('durable context accounting through HTTP',()=>{
  it('uses final attempt usage once, survives restart and preserves historical UI measurements',async()=>{
    const home=await fs.mkdtemp(path.join(tmpdir(),'context-accounting-'))
    let server:WebServer|undefined
    const boot=async()=>{server=await createWebServer({home,providers:[provider],configFile:path.join(home,'p.json'),limits:{automaticCompactionPressure:0}})}
    try {
      await boot()
      const ws=(await(await fetch(`${server!.url}/api/workspaces`)).json())[0].id
      const {id}=await(await fetch(`${server!.url}/api/workspaces/${ws}/sessions`,{method:'POST'})).json()
      const endpoint=()=>`${server!.url}/api/workspaces/${ws}/sessions/${id}`
      await fetch(`${endpoint()}/messages`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({content:'hi'})})
      const deadline=Date.now()+5000
      const logFile=path.join(home,'workspaces',ws,'sessions',id,'events.jsonl')
      let events:any[]=[]
      while(Date.now()<deadline){
        events=(await fs.readFile(logFile,'utf8')).trim().split('\n').map(l=>JSON.parse(l))
        if(events.some(e=>e.type==='turn/end'))break
        await new Promise(r=>setTimeout(r,20))
      }
      const before=await(await fetch(`${endpoint()}/manifest`)).json()
      expect(before.usage).toMatchObject({last:{inputTokens:120_000},cacheableInputTokens:120_000,cachedInputTokens:110_000})
      const marker=projectItems(events).find(item=>item.kind==='context')
      expect(marker?.kind==='context'&&marker.manifest.usage?.last?.inputTokens).toBe(120_000)
      expect(projectTrajectory(events).turns[0]?.traces?.[0]?.manifest?.usage?.last?.inputTokens).toBe(120_000)
      await server!.close();server=undefined;await boot()
      expect(await(await fetch(`${endpoint()}/manifest`)).json()).toEqual(before)
      expect((await fetch(`${endpoint()}/compact`,{method:'POST'})).status).toBe(200)
      const compact=await(await fetch(`${endpoint()}/manifest`)).json()
      expect(compact.display.kind).toBe('post-compaction')
      expect(compact.usage.last).toBeUndefined()
      expect(compact.budget.usedTokens).toBeGreaterThan(0)
      await server!.close();server=undefined;await boot()
      expect(await(await fetch(`${endpoint()}/manifest`)).json()).toEqual(compact)
    }finally{await server?.close();await fs.rm(home,{recursive:true,force:true})}
  })

  it('GETs around a new terminal fact equal a fresh server reading the same home',async()=>{
    const home=await fs.mkdtemp(path.join(tmpdir(),'context-accounting-incremental-'))
    let server:WebServer|undefined
    const boot=async()=>{server=await createWebServer({home,providers:[provider],configFile:path.join(home,'p.json'),limits:{automaticCompactionPressure:0}})}
    try {
      await boot()
      const ws=(await(await fetch(`${server!.url}/api/workspaces`)).json())[0].id
      const {id}=await(await fetch(`${server!.url}/api/workspaces/${ws}/sessions`,{method:'POST'})).json()
      const endpoint=()=>`${server!.url}/api/workspaces/${ws}/sessions/${id}`
      const logFile=path.join(home,'workspaces',ws,'sessions',id,'events.jsonl')
      const turn=async(content:string,ends:number)=>{
        await fetch(`${endpoint()}/messages`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({content})})
        const deadline=Date.now()+5000
        while(Date.now()<deadline){
          const log=await fs.readFile(logFile,'utf8').catch(()=>'')
          if(log.split('"type":"turn/end"').length>ends)break
          await new Promise(r=>setTimeout(r,20))
        }
        await new Promise(r=>setTimeout(r,200))
      }
      await turn('a',1)
      const first=await(await fetch(`${endpoint()}/manifest`)).json()
      await turn('b',2)
      const second=await(await fetch(`${endpoint()}/manifest`)).json()
      expect(second.contextId).not.toBe(first.contextId)
      expect(second.usage).toMatchObject({last:{inputTokens:120_000},cacheableInputTokens:240_000,cachedInputTokens:220_000})
      await server!.close();server=undefined;await boot()
      expect(await(await fetch(`${endpoint()}/manifest`)).json()).toEqual(second)
    }finally{await server?.close();await fs.rm(home,{recursive:true,force:true})}
  })

  it('a new assembly held before its barrier never shows the previous assembly usage.last',async()=>{
    const home=await fs.mkdtemp(path.join(tmpdir(),'context-accounting-pair-'))
    const server=await createWebServer({home,providers:[provider],configFile:path.join(home,'p.json'),limits:{automaticCompactionPressure:0}})
    let release!:()=>void
    const parked=new Promise<void>(r=>{release=r})
    const flush=FileSessionStore.prototype.flush
    let spy:{mockRestore():void}|undefined
    try {
      const ws=(await(await fetch(`${server.url}/api/workspaces`)).json())[0].id
      const {id}=await(await fetch(`${server.url}/api/workspaces/${ws}/sessions`,{method:'POST'})).json()
      const endpoint=`${server.url}/api/workspaces/${ws}/sessions/${id}`
      const send=(content:string)=>fetch(`${endpoint}/messages`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({content})})
      const manifest=async()=>{const r=await fetch(`${endpoint}/manifest`);return r.status===204?{}:r.json()}
      await send('a')
      let a:any
      const deadline=Date.now()+5000
      while(Date.now()<deadline){
        a=await manifest()
        if(a.usage?.last!==undefined)break
        await new Promise(r=>setTimeout(r,20))
      }
      expect(a.usage.last.inputTokens).toBe(120_000)
      await new Promise(r=>setTimeout(r,300))
      spy=vi.spyOn(FileSessionStore.prototype,'flush').mockImplementation(async function(this:FileSessionStore,sessionId:SessionId){
        // Park only the barrier that would commit B's manifest; earlier turn-start barriers pass.
        const logged=await fs.readFile(path.join(home,'workspaces',ws,'sessions',id,'events.jsonl'),'utf8').catch(()=>'')
        if(sessionId===id&&logged.split('"type":"context/manifest"').length>2){await parked;return}
        return flush.call(this,sessionId)
      })
      void send('b').catch(()=>undefined)
      let b:any
      const until=Date.now()+5000
      while(Date.now()<until){
        b=await manifest()
        if(b.contextId!==a.contextId)break
        await new Promise(r=>setTimeout(r,20))
      }
      expect(b.contextId).not.toBe(a.contextId)
      expect(b.usage?.last).toBeUndefined()
      expect(b.usage).toMatchObject({cacheableInputTokens:a.usage.cacheableInputTokens,cachedInputTokens:a.usage.cachedInputTokens})
    }finally{spy?.mockRestore();release();await server.close();await fs.rm(home,{recursive:true,force:true})}
  })
})
