// Browser evidence harness: production components, deterministic current-device data.
import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import { MemoryRouter, useLocation } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { managerKeys } from '@/api/managers'
import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import { ManagerIndexRoute } from '@/routes/manager/manager-index'
import { WatchingSheet } from '@/routes/manager/manager-watching'
import { managerFixture, assistantMessage } from '@/routes/manager/manager-fixtures'
import '@/styles/index.css'

const managers = [managerFixture({ pendingQuestions: 2 }), managerFixture({ id: 'release', name: 'Release manager', lastActivityAt: new Date().toISOString() }), managerFixture({ id: 'long', name: 'A manager with a longer name that wraps at larger text sizes' })]
const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
client.setQueryData(queryKeys.health, { capabilities: { managers: true }, checks: [] })
client.setQueryData(managerKeys.list, { managers })
client.setQueryData(workspaceQueryKeys.config, { computerName: 'Studio Mac' })
client.setQueryData(workspaceQueryKeys.projects, { projects: [], bootProject: 'alpha' })
client.setQueryData(workspaceQueryKeys.runsIndex, { runs: [] })
window.fetch = async () => new Response(JSON.stringify({ messages: [], computerName: 'Studio Mac' }), { headers: { 'content-type': 'application/json' } })
function Fixture() {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState(() => new URLSearchParams(window.location.search).has('empty')
    ? [] : [assistantMessage(1, { text: 'Started [[task:alpha/r1]]' })])
  useEffect(() => {
    // Simulate asynchronous manager/run data arriving while the production dialog is open.
    const receiveTasks = () => {
      const runs = ['r1', 'r2'].map((id, index) => ({
        projectId: 'alpha', id,
        title: 'Rework the relay pairing flow so a phone that lost its keychain can pair again without a reinstall',
        status: 'review', archived: false, createdAt: '2026-10-31T09:00:00Z',
        workflow: 'quick-task', lastActivityAt: '2026-10-31T09:00:00Z',
        pullRequestUrl: `https://github.com/example/project/pull/${41 + index}`,
      }))
      client.setQueryData(workspaceQueryKeys.runsIndex, { runs })
      setMessages([assistantMessage(1, { text: 'Started [[task:alpha/r1]] and [[task:alpha/r2]]' })])
    }
    window.addEventListener('fixture:tasks-ready', receiveTasks)
    return () => window.removeEventListener('fixture:tasks-ready', receiveTasks)
  }, [])
  const location = useLocation()
  return <main>
    <ManagerIndexRoute />
    <button className="m-3 min-h-12 rounded border px-4" onClick={() => setOpen(true)}>Tasks</button>
    <p role="status">{location.pathname}</p>
    <WatchingSheet everyWidth open={open} onOpenChange={setOpen} manager={managers[0]!} messages={messages} loadedAll onPatch={() => {}} onAddJob={() => {}} />
  </main>
}
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/manager?all=1']}><Fixture /></MemoryRouter></QueryClientProvider>)
