import extension from '../dist/index.js'
export const id = value => String(value).padStart(26, '0')
export const post = (n, extra = {}) => ({ id: id(n), user_id: id('u'), channel_id: id('c'), message: 'cezar tasks', create_at: Date.now(), delete_at: 0, root_id: '', type: '', ...extra })
/** A live host operation for direct adapter calls. */
export const activeOperation = () => ({ signal: new AbortController().signal, assertActive: async () => {} })
export async function fixture({ beforeGet } = {}) {
  const originalFetch = globalThis.fetch, originalNow = Date.now
  const now = originalNow()
  Date.now = () => now
  const posts = [], sent = [], storage = new Map(), requests = []
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(url), path = parsed.pathname.replace('/api/v4', '')
    requests.push(parsed)
    let value
    if (path === '/users/me') value = { id: id('b'), username: 'bot' }
    else if (path === '/users/' + id('b') + '/channels') value = [{ id: id('c'), type: 'D', delete_at: 0 }, { id: id('g'), type: 'O', delete_at: 0 }]
    else if (path === '/posts') {
      const body = JSON.parse(options.body); sent.push(body)
      value = post('sent' + sent.length, { ...body, user_id: id('b') })
    } else if (/\/posts$/.test(path)) {
      const channel = path.split('/')[2]
      let rows = posts.filter(row => row.channel_id === channel)
      if (parsed.searchParams.has('since')) rows = rows.filter(row => row.create_at > Number(parsed.searchParams.get('since')))
      else {
        rows = [...rows].sort((a, b) => b.create_at - a.create_at || b.id.localeCompare(a.id))
        const page = Number(parsed.searchParams.get('page') ?? 0), size = Number(parsed.searchParams.get('per_page') ?? 60)
        rows = rows.slice(page * size, (page + 1) * size)
      }
      value = { order: rows.map(row => row.id), posts: Object.fromEntries(rows.map(row => [row.id, row])) }
    } else if (path.includes('/members/')) value = {}
    else throw Error('Unexpected request ' + path)
    return new Response(JSON.stringify(value), { status: 200 })
  }
  let adapter, failWrite = false
  async function restart() {
    await adapter?.dispose()
    extension.activate({ chat: { register(_name, factory) { adapter = factory({ server: 'https://mattermost.test', token: 'test' }); return { dispose() {} } } },
      storage: { async get(key) { await beforeGet?.(); return structuredClone(storage.get(key)) }, async set(key, value) { if (failWrite) { failWrite = false; throw Error('storage failed') }; storage.set(key, structuredClone(value)); return null } } })
  }
  await restart()
  /** One poll of the receive session: resumes after `after` and returns what it accepted. */
  async function receive(after, operation) {
    const rows = [], epoch = '00000000-0000-4000-8000-000000000000'
    const session = {
      signal: operation?.signal ?? new AbortController().signal, assertActive: operation?.assertActive ?? (async () => {}),
      async checkpoint() { return { epoch, nextSequence: after === null ? null : after + 1 } },
      async accept(delivery) { rows.push({ sequence: delivery.sequence, ...(delivery.event ? { event: delivery.event } : {}) }); return { disposition: 'accepted', checkpoint: { epoch, nextSequence: delivery.sequence + 1 } } },
      // Health follows every poll, so ending the session there makes one call one page.
      async health() { throw Object.assign(Error('one poll'), { onePoll: true }) },
      async openInteraction() { throw Error('unused') },
    }
    try { await adapter.receiveSession(session) } catch (error) { if (!error.onePoll) throw error }
    return rows
  }
  return { get adapter() { return adapter }, receive, posts, sent, now, storage, requests, chat: 'private:' + id('c'), restart, failWrite() { failWrite = true },
    async close() { await adapter.dispose(); globalThis.fetch = originalFetch; Date.now = originalNow } }
}
