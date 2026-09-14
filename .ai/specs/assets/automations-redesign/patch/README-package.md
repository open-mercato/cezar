# Automations from a prompt — paczka zmian do naniesienia na `open-mercato/cezar`

Ta paczka zawiera JEDEN commit (`feat(automations): create a GitHub automation from a prompt`)
przygotowany na bazie `main` w stanie `af7e828` (PR #972, "feat(dispatch)"). Zmiana jest
kompletna: kod, testy, spec, dokumentacja. Sesja zdalna nie miała prawa pushować do repo, stąd
paczka.

## Zawartość

| Ścieżka | Co to jest |
|---|---|
| `0001-automations-from-prompt.patch` | Pełny commit w formacie `git format-patch` (kod + testy + docs + message). **To jest preferowany sposób naniesienia.** |
| `files/…` | Kopie WSZYSTKICH zmienionych i nowych plików w ich docelowych ścieżkach względem roota repo — awaryjnie, gdyby patch nie wszedł czysto. |
| `CHANGED_FILES.txt` | `git diff --stat` commita. |

Lista plików (A = nowy, M = zmieniony):

```
A  .ai/runs/2026-09-13-automations-from-prompt.md
A  .ai/specs/2026-09-13-automations-from-prompt.md
M  .env.example
M  BACKWARD_COMPATIBILITY.md
M  README.md
A  packages/cezar/src/automations/automation-cli.test.ts
A  packages/cezar/src/automations/automation-cli.ts
A  packages/cezar/src/automations/builtin-skill.ts
A  packages/cezar/src/automations/prompts.test.ts
A  packages/cezar/src/automations/prompts.ts
M  packages/cezar/src/index.ts
M  packages/cezar/src/server/capabilities.ts
M  packages/cezar/src/skills.test.ts
M  packages/cezar/src/skills.ts
M  packages/cezar/src/workflows/run.ts
M  packages/cezar/src/workflows/system-prompt.test.ts
M  packages/contract/src/skills.ts
M  packages/web/src/lib/prompt-templates.test.ts
M  packages/web/src/lib/prompt-templates.ts
```

## Instrukcja dla lokalnego agenta

### Krok 1 — nanieś commit

W checkoucie `open-mercato/cezar`, na świeżej gałęzi od `main`:

```bash
git checkout -b feat/automations-from-prompt origin/main
git am --3way 0001-automations-from-prompt.patch
```

`git am` zachowuje message i autora commita. Jeśli `main` odjechał i pojawi się konflikt:
rozwiąż go ręcznie (zmiany w istniejących plikach są małe i punktowe — patrz „Co dokładnie
zmienia się w istniejących plikach” niżej), potem `git add -A && git am --continue`.

**Fallback, gdy patch w ogóle nie chce wejść:** `git am --abort`, a potem skopiuj zawartość
katalogu `files/` na root repo (`cp -R files/. <repo>/`) — pliki nowe po prostu dodaj, pliki
zmienione NADPISZ tylko jeśli ich wersja na `main` jest identyczna z `af7e828`; w przeciwnym
razie nanieś ręcznie punkty z sekcji niżej. Następnie `git add -A` i zrób commit z message
z nagłówka patcha.

### Krok 2 — zweryfikuj (kolejność z AGENTS.md § Validation)

```bash
npm ci
npm run typecheck      # musi być zielone
npm test               # vitest, server + web
npm run test:unit      # node:test
npm run build          # tsc + vite + check:pack
```

Stan na moment przygotowania paczki: typecheck ✔, `test:unit` ✔ (36/36), `build` ✔
(check:pack ok), `npm test` — 6616 przechodzi, **3 fail-e są środowiskowe i nie mają związku z
tą zmianą** (powtarzają się na nietkniętym `main` w tym samym kontenerze):

- `src/workspace/migrations.test.ts › an unwritable home degrades with ONE warning` — test
  robi `chmod 0500` na katalogu; kontener działał jako root, więc katalog nadal był zapisywalny.
- `src/server/git.test.ts › reads an SSH (scp-like) origin remote` i `› falls back to the first
  configured remote` — proxy gitowe kontenera przepisywało `git@github.com:` na `https://`.

Na normalnej maszynie deweloperskiej (nie-root, bez przepisywania remote'ów) powinny przejść.
Jeśli u Ciebie padnie COKOLWIEK INNEGO — to jest sygnał do zatrzymania się i sprawdzenia
konfliktu z nowszym `main`.

Testy, które pokrywają tę zmianę i muszą być zielone:

```bash
npm test -- packages/cezar/src/automations packages/cezar/src/skills.test.ts \
            packages/cezar/src/workflows/system-prompt.test.ts \
            packages/web/src/lib/prompt-templates.test.ts
```

### Krok 3 — smoke test na żywo (opcjonalny, 2 minuty)

```bash
cd packages/cezar
npx tsx src/index.ts automation schema | head          # drukuje referencję, bez serwera
npx tsx src/index.ts automation list; echo "exit=$?"    # bez CEZ_API_URL → komunikat + exit 2
```

Pełny obieg na dry-run cockpicie (repo testowe musi mieć remote na github.com):

```bash
CEZ_AUTOMATIONS=1 CEZ_DRY_RUN=1 npx tsx src/index.ts --no-open -p 4599 --repo /sciezka/do/repo &
export CEZ_API_URL=http://127.0.0.1:4599 CEZ_PROJECT_ID=<id projektu z /api/v1/projects>
curl -s $CEZ_API_URL/api/v1/p/$CEZ_PROJECT_ID/skills | grep -o '"name":"create-cezar-automation"[^}]*"source":"builtin"'
cat > /tmp/def.json <<'EOF'
{ "name": "Review new PRs", "events": ["pull_request.opened"], "intervalSeconds": 600,
  "filters": {}, "task": { "prompt": "Review PR #{{github.number}} at {{github.url}}", "worktree": true, "autonomous": true } }
EOF
npx tsx src/index.ts automation create --file /tmp/def.json   # → id + link do cockpitu, "paused"
npx tsx src/index.ts automation list
npx tsx src/index.ts automation check <id>                     # preview; wymaga `gh` na PATH
npx tsx src/index.ts automation enable <id> && npx tsx src/index.ts automation pause <id>
npx tsx src/index.ts automation delete <id>
```

### Krok 4 — PR

Gałąź `feat/automations-from-prompt` → `main`. Tytuł jak w commicie. W opisie odeślij do
`.ai/specs/2026-09-13-automations-from-prompt.md`. CHANGELOG celowo nietknięty — repo dopisuje
go przy release (tak samo zrobił PR #972).

## Co to robi (skrót dla reviewera)

Użytkownik wpisuje w **New task** np. „whenever a PR is opened, review it” i zamiast
jednorazowego runu dostaje automatyzację GitHub. Dwie drogi wejścia, jeden mechanizm:

1. **Skill `create-cezar-automation`** — wbudowany w cezar (pierwszy i jedyny „builtin” skill,
   `source: 'builtin'`, `interactive: true`), widoczny w pickerze skilli i pod
   `/create-cezar-automation`. Wybranie go wypełnia pole promptu szablonem „Create an automation”
   (trigger + task). Skill to pełny playbook: zrozum → napisz definicję JSON →
   `cez automation create` (PAUSED) → `cez automation check` (preview, nic nie odpala) →
   zaraportuj link.
2. **System prompt** — każdy task dostaje krótki fragment `AUTOMATIONS_PROMPT`, dzięki któremu
   agent rozpoznaje intencję „whenever / every time …” i zna CLI (`cez automation schema` drukuje
   pełny kształt definicji). Czyli „cezar sam wie, kiedy tego użyć”.

Pod spodem: CLI `cez automation schema|create|update|check|list|show|enable|pause|delete`
(`packages/cezar/src/automations/automation-cli.ts`) — cienki klient HTTP nad ISTNIEJĄCYMI
trasami `/api/v1/p/:projectId/automations*`, adresowany tymi samymi zmiennymi co `cez task`
(`CEZ_API_URL`, `CEZ_PROJECT_ID`, `CEZ_BIN`). Zero nowych tras, zero nowego stanu, zero nowych
flag.

**Bramkowanie** (lekcja z dispatch, spec 2026-09-10 A2/A8): wszystko — prompt, skill, szablon —
pojawia się tylko gdy `capabilities.automations` (`CEZ_AUTOMATIONS=1`) ORAZ cockpit jest
osiągalny (`CEZ_API_URL`). Headless `cezar run` albo cockpit bez flagi: nic nie jest
komponowane, nic nie jest listowane. CLI bez `CEZ_API_URL` kończy się kodem 2 z komunikatem
„stop and report, nie zastępuj cronem”; 409 z wyłączonej trasy jest przekazywane dosłownie
z kodem 1.

## Co dokładnie zmienia się w istniejących plikach (do ręcznego scalania)

- `packages/cezar/src/skills.ts` — import `builtinSkills` z `./automations/builtin-skill.ts`;
  union `source` dostaje `'builtin'`; w `discoverSkills` pętla scalająca iteruje po
  `[...lists, teamSkills, builtinSkills()]` (builtin OSTATNI — skill z repo o tej samej nazwie
  go przesłania).
- `packages/contract/src/skills.ts` — enum `source` dostaje `'builtin'` (addytywne).
- `packages/cezar/src/index.ts` — import `runAutomationCommand`; w `HELP` linia
  `cezar automation …`; w `main()` tuż po routingu `task` analogiczny `if (process.argv[2] ===
  'automation')`.
- `packages/cezar/src/workflows/run.ts` — importy `automationsReachable` i `AUTOMATIONS_PROMPT`;
  pole `automationsPrompt?: string` w `ActiveRun` (obok `dispatchPrompt`); metoda
  `prepareAutomationsSession(state)` obok `prepareDispatchSession`; wywołanie jej w OBU
  miejscach, gdzie woła się `prepareDispatchSession` (execute i runContinuation);
  `state.automationsPrompt` dodane do `composeSystemPrompt(...)` w obu `startSession` — zaraz
  po `dispatchPromptPart(...)`, przed extra system promptem.
- `packages/cezar/src/server/capabilities.ts` — tylko komentarz dokumentacyjny.
- `packages/web/src/lib/prompt-templates.ts` — nowy wbudowany szablon `create-automation`
  (`skills: ['create-cezar-automation']`); `AUTOMATIONS_TEMPLATE_IDS`;
  `availablePromptTemplates` przyjmuje `{ dispatch?, automations? }` i filtruje po obu bramkach
  (trzy composery już przekazują cały obiekt `capabilities`, więc nic więcej nie trzeba ruszać).
- `README.md` (wiersz `CEZ_AUTOMATIONS=1` w tabeli env), `.env.example` (sekcja automations +
  wzmianka o `cez automation` przy `CEZ_BIN`), `BACKWARD_COMPATIBILITY.md` (sekcja 1 — lista
  komend CLI; sekcja „GitHub automations — opt-in gating” — nota o addytywnych zmianach).
- Testy: `skills.test.ts` (nowy `describe` + import `beforeEach`),
  `workflows/system-prompt.test.ts` (import `AUTOMATIONS_PROMPT`, zapis/odtworzenie
  `CEZ_AUTOMATIONS` w `savedEnv`, `delete process.env.CEZ_AUTOMATIONS` w `beforeAll`, dwa nowe
  testy bramkowania), `web/src/lib/prompt-templates.test.ts` (rozszerzony `describe`
  `availablePromptTemplates`).

## Czego w paczce NIE ma

Redesignu ekranów Automations / New task / Settings / Shell / Tasks / Thread z eksportu Claude
Design — eksport (README, `chats/`, `ui_kits/cockpit/*`) nie dotarł do sesji, więc nie było
czego implementować. Composer używa istniejących wejść (picker skilli + menu szablonów).
