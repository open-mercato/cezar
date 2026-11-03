import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setApiBaseUrl, setApiScope } from '@open-mercato/cezar-api-client'
import { actOnLifecycleOperation, getLifecycleOutput, getWorktreeLifecycle, previewLifecycleCommand, startLifecycleRemoval } from './client'
const fetchMock=vi.fn<typeof fetch>()
beforeEach(()=>{ vi.stubGlobal('fetch',fetchMock);setApiScope('other-project');fetchMock.mockResolvedValue(new Response('{}',{status:200,headers:{'content-type':'application/json'}})) })
afterEach(()=>{fetchMock.mockReset();vi.unstubAllGlobals();setApiScope(null);setApiBaseUrl('')})
describe('lifecycle client scope and transport',()=>{
  it('scopes list reads and preserves boolean/query pagination',async()=>{
    await getWorktreeLifecycle({attentionOnly:true,cursor:'next',limit:12})
    const [url,options]=fetchMock.mock.calls[0]!
    expect(String(url)).toBe('/api/v1/p/other-project/worktree-lifecycle?cursor=next&limit=12&attentionOnly=true')
    expect(options?.credentials).toBe('include')
  })
  it('sends the recovery revision and stable request id unchanged',async()=>{
    const input={action:'retry' as const,requestId:'request-id',expectedRevision:7}
    await actOnLifecycleOperation('operation-id',input)
    const [url,options]=fetchMock.mock.calls[0]!
    expect(String(url)).toBe('/api/v1/p/other-project/worktree-lifecycle/operations/operation-id/actions')
    expect(JSON.parse(String(options?.body))).toEqual(input)
  })
  it('does not put any command or path into a removal request',async()=>{
    const input={requestId:'request-id',runId:'run-id',intent:'reclaim' as const}
    await startLifecycleRemoval(input)
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual(input)
  })
  it('keeps preview nonexecuting and output bounded',async()=>{
    await previewLifecycleCommand({command:'echo {{ root_path }}'})
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/worktree-lifecycle/preview')
    fetchMock.mockResolvedValue(new Response('{}',{status:200,headers:{'content-type':'application/json'}}))
    await getLifecycleOutput('op',15)
    expect(String(fetchMock.mock.calls[1]![0])).toContain('/operations/op/output?afterSeq=15&limit=100')
  })
  it('uses remote credentials and carries the server conflict to the recovery UI',async()=>{
    setApiBaseUrl('https://cezar.example')
    fetchMock.mockResolvedValue(new Response(JSON.stringify({error:'State changed; reload'}),{status:409}))
    await expect(getWorktreeLifecycle()).rejects.toMatchObject({status:409,message:'State changed; reload'})
    expect(fetchMock.mock.calls[0]![1]?.credentials).toBe('include')
  })
})
