# Store screenshots

Real UI rendered in headless Chrome by `../scripts/screenshots.mjs` (Chrome DevTools Protocol through
`../scripts/cdp.mjs`, no npm dependency). `test/store.test.mjs` checks every size and that no
screenshot has an alpha channel.

```bash
npm run build                                   # once: the cockpit scenes boot the built cezar
node packages/mobile/store/scripts/screenshots.mjs                      # everything
node packages/mobile/store/scripts/screenshots.mjs --only graphics,connect --connect <dir>
```

The connect scenes need the relay pairing screens, so run them from the top of the mobile stack, or
pass `--connect` a `packages/mobile/connect` directory that has them; both platforms show pairing. The
cockpit scenes boot this repo's cezar with `CEZ_DRY_RUN=1` in a throwaway `HOME` and `CEZ_HOME`, seed a
demo shop project and a manager, and stop it afterwards.

| Set | Pixels | Store slot |
| --- | --- | --- |
| `android/phone/` | 1080 × 1920 | Play: phone screenshots |
| `ios/iphone-6.9/` | 1320 × 2868 | App Store: iPhone 6.9" (required) |
| `ios/iphone-6.5/` | 1284 × 2778 | App Store: iPhone 6.5" |
| `ios/ipad-13/` | 2064 × 2752 | App Store: iPad 13" (required while the app targets iPad) |
| `../graphics/feature-graphic.png` | 1024 × 500 | Play: feature graphic |
| `../graphics/play-icon-512.png` | 512 × 512 | Play: app icon |

| Scene | Shows |
| --- | --- |
| `01-tasks` | The task list with running, done and waiting tasks |
| `02-task-live` | A running task's live chat |
| `03-manager` | The Manager answering "what needs me" |
| `04-connect` | The connect screen |
| `05-pair-code` | Typing a pairing code |
| `06-servers` | The server list with notifications and the app lock |

`06-servers` shows the default relay address, `rome.cezar.run`; retake it if that changes.
