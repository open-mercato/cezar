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

When multiple logical Cezar installations share one origin and credential mode, pass a stable, host-owned `identity` to `createCezarClient` so their query and browser-storage namespaces remain isolated.

`./cockpit` is intentionally a coarse entry: it bundles the complete existing cockpit, including its router, dialogs, syntax highlighting, and language grammars. The current production `dist` is roughly 3 MB uncompressed before a consuming bundler performs its own chunking and compression. Import the package root without `./cockpit` when you only need the provider and host adapters; applications embedding the complete cockpit should budget and lazy-load it as a substantial route-level feature.
