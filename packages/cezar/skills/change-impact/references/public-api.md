# Finding the public API delta

A public surface is anything a consumer outside the changed code depends on: another service, a
plugin, a script, a user's configuration, a stored record. `cez impact evidence` lists
`public_surface_candidates` — changed paths that *look like* a surface in their ecosystem. That
list is a starting point, never proof: read each candidate at both commits, and look for surfaces
the patterns cannot see (a route registered in an ordinary file, an exported type changed through
a re-export).

Diff a surface at the pinned commits without checking anything out:

```bash
git show <base>:path/to/file > /tmp/before && git show <head>:path/to/file > /tmp/after
git diff <merge_base> <head> -- path/to/file
git grep -n '<symbol>' <head> -- '*.ts'            # who still uses it at head
git log --format='%h %s' <merge_base>..<head> -- path/to/file
```

For a spec, the "before" is the surface in the code today and the "after" is what the spec
describes; cite the spec's lines.

## Is it breaking?

Breaking: a consumer that worked before fails, misbehaves or must change after. Typical:

- removing or renaming anything public (route, field, export, event, flag, env var, block);
- a new **required** input, a narrower accepted type, a stricter validation;
- a changed meaning, unit, default or order of something consumers read;
- a removed field in a response or event payload; a type made optional that consumers read as
  always present;
- a changed error contract (status code, exception class) callers branch on.

Usually not breaking: a new optional input, a new endpoint/event/export, a widened accepted type,
an additive response field (unless consumers validate strictly). A deprecation is not breaking
until the surface is removed, but say when it will be. If you cannot tell, write
`"breaking": "unknown"` and explain in `impact`; never guess safe.

## TypeScript / JavaScript

- `package.json`: `exports`, `main`, `module`, `types`, `bin`, `engines`, `peerDependencies`.
  A removed subpath export is breaking.
- `index.ts` / barrel re-exports: what leaves the barrel leaves the API.
- `.d.ts` and exported types: diff the declarations, not the implementation.
- Framework conventions: route files (Next.js `app/**/route.ts`, `pages/api`), Hono/Express
  route registrations, React component props of a published UI kit.

## HTTP and RPC

- OpenAPI/Swagger documents, GraphQL schemas (`.graphql`), protobuf (`.proto`).
- Route registrations and their request/response validators. In cezar itself every shape is a
  zod schema in `packages/contract`, and the route inventory is BACKWARD_COMPATIBILITY.md §2.
- Status codes, headers, auth requirements, pagination and error bodies.

## PHP / Symfony / Shopware

- **Store API and Admin API routes**: `#[Route(path: '/store-api/…')]` / `'/api/…'` attributes
  (older code: `@Route` annotations) on controllers and `*Route` classes, usually under
  `SalesChannel/`, `StoreApi/` or `Api/`. Check path, method, `_routeScope`, required request
  fields and response struct.
- **Abstract route and service decoration**: Shopware's `Abstract*Route::getDecorated()` pattern
  and `decorates="…"` in `services.xml`; a changed abstract method signature breaks every
  decorator.
- **Events**: `*Event` classes (constructor and getters), event name constants, and
  `*Subscriber::getSubscribedEvents()`. A removed getter or a changed event name is breaking.
- **DI container**: `services.xml` / `services.php` service ids, tags (`shopware.entity.definition`,
  `kernel.event_subscriber`, `shopware.payment.method`…), public/private flags, arguments.
- **Entities**: `*Definition.php` fields and flags (`Required`, `ApiAware`, `Runtime`),
  `*Entity` getters, `*Collection`; plus `Migration*.php` — a dropped or renamed column breaks
  data and integrations; destructive changes belong in `updateDestructive`.
- **Administration**: Twig `{% block %}` names in `Resources/app/administration/**/*.html.twig`
  that plugins override, component names registered with `Component.register/override`, and
  Vuex/Pinia store shapes. A renamed block silently drops every plugin override.
- **Storefront**: Twig blocks under `Resources/views/`, JS plugin names, SCSS variables.
- **Annotations**: `@internal` (not a public surface — changes are not breaking for others),
  `@deprecated tag:vX.Y.0` (announces a future break; note the version), `@final`.
- `composer.json` (`require`, autoload namespaces) and `plugin.xml`/plugin metadata.

## Generic surfaces

- **CLI**: commands, flags, positional arguments, exit codes, output that scripts parse.
- **Environment variables**: names, defaults, accepted values (`.env.example` and the docs table).
- **Config schemas**: keys, defaults, validation; a newly required key breaks every existing
  config.
- **Data**: database migrations, stored file formats, message/queue payloads, cache keys.
- **Extension points**: hooks, plugin interfaces, webhooks, theme blocks.

## Recording it

One `api_changes` entry per surface (see analysis-contract.md). For each breaking change: the
reason in `impact`, a `migration` a consumer can follow, at least one `observed` evidence record
(the before/after locations you read), and a decision condition that lists its id in
`api_changes`.
