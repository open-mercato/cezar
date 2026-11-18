# Telegram chat plugin

This is a standalone cezar extension. Its runtime imports only the public
`@open-mercato/cezar-extension-sdk`; Telegram HTTP, validation and normalization live in this
package. The host still owns bot leases, durable acceptance, the receive checkpoint, pairing,
grants and task execution.

Build the public SDK first, then this package:

```sh
npm run build -w @open-mercato/cezar-extension-sdk
(cd packages/chat-plugins/telegram && npm run build)
```

For a reproducible install outside this monorepo, pack both artifacts and use file dependencies
(the plugin's semver dependency must not silently resolve from npm while testing a local build):

```sh
(cd packages/extension-sdk && npm pack --pack-destination /tmp >/dev/null)
(cd packages/chat-plugins/telegram && npm pack --ignore-scripts --pack-destination /tmp >/dev/null)
SDK_TG=$(ls -t /tmp/open-mercato-cezar-extension-sdk-*.tgz | head -1)
PLUGIN_TG=$(ls -t /tmp/open-mercato-cezar-chat-telegram-*.tgz | head -1)
mkdir /tmp/telegram-consumer && cd /tmp/telegram-consumer
npm init -y
npm install --install-strategy=nested "$SDK_TG" "$PLUGIN_TG"
npm install --prefix node_modules/@open-mercato/cezar-chat-telegram --no-save "$SDK_TG"
```

The second install keeps the SDK inside the plugin's installed directory. This matters when the
cockpit copies a local extension into its immutable artifact store: the artifact must carry its
runtime dependencies instead of relying on a sibling consumer `node_modules` directory.

`npm run test:pack` performs this workflow in a temporary directory and is the release smoke
test. In Settings → Extensions, install the resulting
`node_modules/@open-mercato/cezar-chat-telegram` folder (or an available npm package version), approve it for the project, then configure the Telegram bot token
under Integrations. The extension identity is `open-mercato.telegram` and its provider contribution
is `telegram`; neither changes with the installation path.

Cezar ships this same public artifact for its default integration. A separately installed
candidate replaces the shipped adapter only after explicit project selection and approval in
Extensions. The selected artifact stays pinned across host
and installation updates; disable/uninstall never silently falls back to shipped code.

This package has its own version, independent of the host release. Cezar pins its shipped version
and digest; updating that shipped copy requires a host update. With local `CEZ_EXTENSIONS=0`, only
the verified shipped artifact runs through the trusted in-process facade; installed selections
stay unavailable. A hosted cockpit runs no chat adapter. A missing or invalid artifact is reported
as unavailable; nothing else runs in its place.

Run `npm test` for adapter tests against a local Telegram API simulator. No live account is used.

`npm run test:pack` builds the SDK first, packs the plugin and public SDK, installs both into a
fresh external consumer, and runs a transport call plus installed-Cezar worker activation outside
the monorepo. Build the service (`npm run build`) before this check so its published artifact has
the inlined contract. Releases publish the SDK first; the plugin's semver dependency then resolves
from the public npm artifact.

Direct tarball installation through the cockpit UI is not supported.

Messages use literal plain text by default. Hosts advertising `chat.presentation.v1` may explicitly send `textFormat` set to `telegram-html` for already escaped platform rendering. Telegram accepts balanced `b`, `code` and HTTP(S) link tags only; scripts, native user links and unbalanced markup are rejected. Ordinary extension hosts should omit `textFormat` for untrusted text.
