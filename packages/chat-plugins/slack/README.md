# Slack chat plugin

Standalone Slack Socket Mode provider for cezar. It uses only the public
`@open-mercato/cezar-extension-sdk` chat contract; credentials remain supplied
by the host and are never written by this package.

```sh
cd packages/chat-plugins/slack
npm test
npm run test:pack
```

`npm run test:pack` builds the SDK and plugin, packs both with lifecycle scripts disabled,
then installs the tarballs in a fresh directory outside the monorepo. It also verifies that the
installed plugin can be activated by a packed cezar host.

In Settings → Extensions, install a built local folder containing its runtime
dependencies, or an available npm package version, then configure the
Slack connection in the project’s Integrations screen. The package identity is
`open-mercato.slack` and its provider id is `slack`; both remain stable across
folder and npm installation.

Cezar ships this same public artifact for its default integration. A separately installed
candidate replaces the shipped adapter only after explicit project selection and approval in
Extensions. The selected artifact stays pinned across host
and installation updates; disable/uninstall never silently falls back to shipped code.

This package has its own version, independent of the host release. Cezar pins its shipped version
and digest; updating that shipped copy requires a host update. With local `CEZ_EXTENSIONS=0`, only
the verified shipped artifact runs through the trusted in-process facade; installed selections
stay unavailable. A hosted cockpit runs no chat adapter unless started with
`CEZ_REMOTE_EXTENSIONS=1`. A missing or invalid artifact is reported as unavailable; nothing
else runs in its place.

Direct tarball installation through the cockpit UI is not supported.

Messages use literal plain text by default. Hosts advertising `chat.presentation.v1` may explicitly send `textFormat` set to `slack-mrkdwn` for already escaped platform rendering. Slack rejects raw angle-bracket markup, disables mention expansion and unfurls, and keeps button sections verbatim. Ordinary extension hosts should omit `textFormat` for untrusted text.
