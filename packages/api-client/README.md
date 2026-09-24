# @open-mercato/cezar-api-client

The typed client for a [cezar](https://github.com/open-mercato/cezar) service, and the shared
contract types behind it.

cezar is a local cockpit for running AI agent tasks in your repo. It runs as an HTTP service,
and this package is how anything else talks to it — the cockpit UI is just its first consumer.

## Status

**Not published yet.** The package is `private`: it is consumed inside the cezar
workspace (the cockpit bundles it, the service's tests import it) and will be
released once its surface settles — it still carries hand-written DTOs for the
routes that have not been converted to the versioned, type-inferred surface, and
those shrink with every family that is.

## Use

```ts
import { createCezarClient } from '@open-mercato/cezar-api-client'
import type { AppType } from '@open-mercato/cezar/app-type'

const cez = createCezarClient<AppType>({ baseUrl: 'http://127.0.0.1:4321' })

const res = await cez.api.v1['agent-config'].$get()
const files = await res.json() // shape inferred from the server's own handler
```

The type argument is what makes the client typed: it is the service's own app type, so paths,
request bodies and response shapes are checked at compile time against the routes that actually
exist. It is supplied by you rather than imported here, so this package installs and runs
without the service package present — `createCezarClient()` with no type argument is a working,
untyped client.

Only the versioned surface (`/api/v1/*`) is typed. The unversioned `/api/*` paths are frozen for
consumers that already call them and are not part of what this client offers.

## Also exported

- **Protocol types** (`UiEvent`, `UiItem`, `ToolDisplay`, …) — the agent event vocabulary the
  service streams over SSE, plus the pure `toolDisplay()` renderer for it.
- **Scope helpers** (`scopeApiPath`, `apiBase`, …) — the `/api` ↔ `/api/p/:projectId`
  project-scope prefixing.
- **DTOs** for the routes that are not versioned yet. These are hand-maintained (and drift-
  guarded against the service's own types) and shrink as each route family is converted.

Everything here is Node-free: it bundles into a browser as readily as it imports into a Node
process.

## License

MIT
