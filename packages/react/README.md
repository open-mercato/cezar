# `@open-mercato/cezar-react`

Embed the complete Cezar cockpit with its public client, cockpit entry point, and styles:

```tsx
import { createCezarClient } from '@open-mercato/cezar-api-client'
import { CezarCockpit } from '@open-mercato/cezar-react/cockpit'
import '@open-mercato/cezar-react/styles.css'

<CezarCockpit
  client={createCezarClient({ baseUrl, credentials: 'include' })}
  routing={{ mode: 'memory', initialPath: '/' }}
/>
```

Memory routing leaves the host URL untouched, while the cockpit owns its complete internal route tree. One cockpit instance per host panel is supported. Advanced appearance composition remains available through `CezarProvider` from the package root.
