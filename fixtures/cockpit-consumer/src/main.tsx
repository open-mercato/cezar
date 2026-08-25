import { createRoot } from 'react-dom/client'
import { createCezarClient } from '@open-mercato/cezar-api-client'
import { CezarCockpit } from '@open-mercato/cezar-react/cockpit'
import '@open-mercato/cezar-react/styles.css'

const client = createCezarClient({
  baseUrl: 'https://cezar.example.test',
  credentials: 'include',
})

createRoot(document.getElementById('root')!).render(
  <CezarCockpit client={client} routing={{ mode: 'memory', initialPath: '/' }} />,
)
