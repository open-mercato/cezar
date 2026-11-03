# Automatyzacje zdarzeniowe Jira/Linear zgodne z GitHub — Implementation Plan

> **For agentic workers:** przy realizacji użyj `superpowers:executing-plans` lub
> `superpowers:subagent-driven-development`, etap po etapie. Poniższe checkboxy oznaczają przyszłą
> implementację. Utworzenie planu NIE uruchamia implementacji ani automatyzacji.

**Goal:** umożliwić wybór zdarzenia issue w Jira/Linear i uruchamianie istniejącego workflow
przez ten sam mechanizm automatyzacji co GitHub, z zachowaniem jego obsługi i gwarancji.

**Architecture:** wspólny cykl polling → eligibility → receipt → launch → checkpoint, z małymi
adapterami źródeł. GitHub zachowuje format konfiguracji i zachowanie. Jira/Linear emitują zdarzenia
z historii, nie „aktualny status pasuje”. Istniejące per-project dotenv i agent-side realizacja
PR/statusu pozostają; naprawiamy redakcję i wiązanie poświadczeń, bez nowego serwera write-back.

**Tech Stack:** istniejące TypeScript/Node, Zod, Hono, React, TanStack Query, Vitest; bez nowych zależności.

**Spec:** brief w §1 jest samowystarczalnym zapisem ostatnich ustaleń użytkownika. Kontekst:
`.ai/specs/2026-09-18-jira-linear-tracker-browsing.md` (przeglądanie),
`.ai/specs/2026-09-14-automations-redesign.md` (istniejące automatyzacje),
`/tmp/cezar-review-2026-09-19.md` (audyt; plik pomocniczy, nie wymagana zależność wykonania).
Stan odniesienia audytu: HEAD `91345396`; 414 plików / 7380 testów przechodziło przed poprawkami.

Status dokumentu: **zaimplementowany lokalnie dla zweryfikowanych zdarzeń; nieopublikowany**.

Wykonanie (2026-09-19): wspólny silnik, kontrakt/API, edytor/CLI, wiązanie poświadczeń
i regresje zostały wdrożone. Jira obsługuje utworzenie i zmianę statusu; Linear utworzenie.
Pozostałe zdarzenia są niedostępne zgodnie z bramką możliwości w zadaniu 1.
Potwierdzenia zdarzeń są zachowywane, dopóki istnieje definicja automatyzacji; koszt to wzrost
pliku i czasu odczytu, w zamian za ochronę przed powtórzeniem starego checkpointu.
Raport wykonania: `.ai/qa/tracker-automation-events/verification.md` (7435 testów, build,
typy, lokalne scenariusze przeglądarkowe i ograniczenia). Checkboxy poniżej zachowują
pierwotny plan; stan wykonania opisuje ten akapit i raport.

## 1. Brief i granice

- Ten sam edytor i flow co GitHub: źródło → zdarzenie → filtry → interwał → workflow/instrukcja.
- Tracker: `issue.opened`, `issue.status_changed`, `issue.labeled`, `issue.unlabeled` jako docelowy
  katalog. Każde zdarzenie udostępnić dopiero po zweryfikowaniu adaptera. GitHub zachowuje także
  `pull_request.opened`; nie oferować go dla Jira/Linear. Zmiana przypisania poza tym zakresem.
- Przykład: Jira / projekt SAM → zmiana statusu → docelowy status To Do → co 1800s → workflow.
  Interwał określa moment odbioru zdarzeń, nie ponowne wykonywanie nadal pasujących issue.
- Ta sama zmiana odczytana dwukrotnie = jeden start. Dwa rzeczywiste przejścia do To Do = dwa
  zdarzenia. Zmiana opisu przy stałym statusie = zero zdarzeń statusu.
- Zdarzenie oceniać według danych zmiany, nie tylko aktualnego statusu. Późniejsza zmiana statusu
  może sprawić, że agent po odczycie świeżego issue uzna wykonanie pracy za nieaktualne.
- Włączenie ustanawia baseline „od teraz”, jak GitHub. Nie uruchamia wcześniejszych zdarzeń.
  Nie dodajemy osobnego flow importowania backlogu ani polityki „raz na issue na zawsze”.
- Wspólne preview, execute, pause, retry, logi i ograniczenia kolejki. Preview niczego nie
  uruchamia i nie przesuwa trwałego kursora wykonania.
- Agent nadal wykonuje instrukcję dotyczącą PR/statusu. Silnik nie obiecuje deterministycznego
  write-back ani automatycznego merge. Gotowość adaptera zdarzeń nie dowodzi poprawności konkretnego
  promptu zapisującego status u dostawcy.

### Global Constraints

- W tej sesji tylko plan. Bez implementacji, commitów, push, PR, komentarzy i publikacji.
- Przy przyszłej realizacji dotychczasowy zakaz publikacji nadal obowiązuje, dopóki użytkownik
  go nie zmieni. Nie włączać produkcyjnych automatyzacji ani nie tworzyć live issue/PR do testów.
- Wszystkie testy z `TMPDIR=/tmp`; izolowane `CEZ_HOME`; nie czytać tokenów do logów ani promptów.
- HTTP: Zod w `packages/contract`, route chaining, middleware validators, `/api/v1` i aliasy
  projektowe. Typy wire tylko przez `z.infer`; re-eksport przez api-client.
- Istniejące harmonogramy godzinowe pozostają bez zmian. 1800s mieści się w istniejącym
  przedziale pollingu60–86400s; nie dodajemy nowego schedulera ani publicznych portów/webhooków.
- Konfiguracja zapisywana przez UI/API, bez wymagania ręcznego authoringu JSON/env.
- Nie rozszerzać ekspozycji tokenów na zwykłe runy. Zachować lokalność projektu, fail-closed przy
  zmianie powiązania i brak prawdziwych poświadczeń w dry-run.
- Nie kopiować istniejącej luki GitHuba w imię parytetu. Wspólną poprawkę przypiąć regresją
  dotychczasowej ścieżki GitHub i schedule.

## 2. Zweryfikowane podstawy i granice dostawców

1. Jira REST v3 udostępnia paginowane changelogi issue i bulk fetch changelogów.
   Kierunek: discovery zaktualizowanych issue w danym projekcie, następnie ich historia.
   Nie używać ograniczonego `expand=changelog` jako kompletnego strumienia zmian.
   Źródło: [Jira Issues API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/).
2. Oficjalny schemat Lineara zawiera `Issue.history(first, after, orderBy, includeArchived)`
   oraz `IssueHistory.id`, `createdAt`, `fromStateId`, `toStateId`, `addedLabelIds`,
   `removedLabelIds`. Stanowi to podstawę adaptera statusów/etykiet, nie dowód pełnej retencji.
   Źródło: [Linear GraphQL schema](https://raw.githubusercontent.com/linear/linear/master/packages/sdk/src/schema.graphql).
3. Linear opisuje paginację, filtrowanie aktualizacji i ukrywanie archiwalnych zasobów domyślnie.
   Dokumentacja ostrzega także, że zmiany w pierwszych3min życia issue nie są rejestrowane jako
   zmiany activity log. Zaplanować sprawdzenie wpływu na `Issue.history`; nie gwarantować każdej
   zmiany tylko na podstawie obecności pól w schemacie.
   Źródło: [Linear GraphQL guide](https://linear.app/developers/graphql).

Nie wykonywano nowych zapytań z tokenami użytkownika ani live mutacji przy pisaniu tego planu.
Weryfikacja zachowania API i fixture z zadania1 jest warunkiem dalszej implementacji adapterów.
Jeżeli API nie udostępnia wybranego typu historii wiarygodnie, pozostawić capability wyłączone
z wyjaśnieniem; zgłosić brak parytetu, a nie podmieniać zdarzenie na snapshot. Alternatywa webhook
wymagałaby osobnego uzgodnienia ekspozycji — nie wchodzi automatycznie do tego planu.

## 3. Review Focus

1. Dwie zmiany statusu w jednym interwale, również powrót do tej samej wartości; zadania1,4,5,8.
2. Pause/edycja/zmiana połączenia podczas requestu, startu i Continue; zadania2,3,6.
3. Dużo historii i issue,429 i restart pomiędzy receipt a checkpoint; zadania3–6.
4. Token w zdarzeniu live/transkrypcie i stary run po rotacji; zadanie2.
5. Legacy GitHub/schedule i eksperymentalny tracker bez pola events; zadania3,6–8.

## 4. Proponowana granica adaptera

Nowy plik `packages/cezar/src/automations/event-source.ts` definiuje wewnętrzne typy mechanizmu,
a nie nowe ręcznie pisane typy HTTP. `TrackerAutomationEvent` i `TrackerAssociation` pochodzą
z kontraktu. Existing `GithubCandidate` zachowuje swój payload, żeby nie zmieniać template/GitHub.

```ts
type TrackerEventCandidate = {
  eventId: string; timestamp: string; tieBreaker: string;
  provider: 'jira' | 'linear'; event: TrackerAutomationEvent;
  association: TrackerAssociation;
  issueId: string; key: string; title: string; url: string;
  change: { fromId?: string; toId?: string; labelId?: string; labelName?: string };
};
type PollPage<C> = {
  candidates: C[];
  checkpoint: string; // wersjonowany, walidowany przez adapter; żadnych sekretów
  complete: boolean;
};
interface AutomationEventSource<C> {
  poll(input: {
    baselineAt: string; checkpoint?: string; limit: number;
    signal: AbortSignal;
  }): Promise<PollPage<C>>;
  isCurrent(): Promise<boolean>;
}
```

`limit` oznacza istniejący limit kandydatów/startów, nie liczbę issue przed filtrowaniem.
Adapter ma osobny wewnętrzny budżet requestów: początkowo maks10 żądań/cykl, do100 rekordów/stronę
z uwzględnieniem limitu dostawcy. To stałe implementacyjne, nie nowe ustawienia użytkownika.
`complete:false` zapisuje postęp i oznacza zaległość. Następny termin używa istniejącego pollingu
lub backoff; nie tworzyć ciasnej pętli nadrabiania. Te same limity kolejki runów nadal obowiązują.

Checkpoint przechowuje wersję, fingerprint źródła i filtrów, zakończony watermark oraz ewentualny
stan bieżącego skanu (granice czasu, następna strona issue, oczekujące issue/historia). Nie przesuwać
zakończonego watermarku po częściowym odczycie. Nie zakładać stabilności kursora po zmianie danych:
invalid cursor → ograniczony reskan z ostatniego ukończonego watermarku i deduplikacja.
Przy odkrywaniu zmian nie zawężać listy do bieżącego statusu docelowego — zgubiłoby to historię.

ID trackerowego zdarzenia: source+scope+stabilne issueId+historyId+event+wyróżnik pola/etykiety.
Utworzenie: source+scope+issueId+`created`. `updatedAt` nie jest ID zdarzenia. ConnectionId kontroluje
uprawnienia; jego rotacja sama w sobie nie tworzy nowego zdarzenia w tym samym źródle.

## 5. Etapy implementacji

Każdy etap kodowy: najpierw test regresyjny → potwierdzona czerwień → minimalna zmiana → zieleń
→ przegląd zakresu. Nie realizować poleceń commit/push w ramach tego planu bez nowej dyspozycji.

### Zadanie 1 — Potwierdzenie zdarzeń i fixtures

**Pliki:** nowe `packages/cezar/src/server/tracker/fixtures/automation-events/` i
`packages/cezar/src/server/tracker/event-capabilities.test.ts`; istniejące `jira.ts`, `linear.ts`
na tym etapie tylko odczytać. Dokument dowodów: `.ai/qa/tracker-automation-events/capabilities.md`.

- [ ] Zachować zanonimizowane fixture tworzenia, dwóch przejść statusu i add/remove label,
  wielostronicowej historii oraz odpowiedzi429/403 dla obu dostawców. Jawnie odróżnić fixture
  syntetyczne od zweryfikowanych odpowiedzi. Nie instalować SDK tylko do odczytu schematu.
- [ ] Wykonać read-only probe historii istniejącego sandbox issue, jeśli dostępne poświadczenia.
  Brak sandboxa nie wymaga ich wypisywania ani tworzenia live danych: zapisać ograniczenie dowodów.
- [ ] Potwierdzić stabilność historyId, porządek i paginację, historię statusów pośrednich,
  obsługę archived oraz granicę3min Lineara. W Jira potwierdzić rozkład `from/to` dla labels,
  zanim doda się obsługę etykiet. Nie parsować niezweryfikowanego tekstu etykiet przez split(',').
- [ ] Zatwierdzić macierz capability dla każdej operacji. Kryterium: poniższe oczekiwanie pochodzi
  z historii, nie z różnicy dwóch aktualnych stanów.

```ts
expect(statusTransitions(historyFixture).map(x => [x.fromId, x.toId]))
  .toEqual([['todo', 'progress'], ['progress', 'todo']]);
```

`statusTransitions` jest helperem mapującym do napisania z adapterem (zadania4/5), nie publicznym API.
Jeżeli macierz ujawni niemożność realizacji zdarzenia, opisać dokładny brak i zatrzymać tę capability;
nie przedstawiać częściowego wyniku jako pełnego zakończenia planu.

### Zadanie 2 — Sekrety i powiązanie runa

**Pliki:** `packages/cezar/src/server/tracker/agent-credentials.ts` i jego test;
`runs/store.ts`, `workflows/run.ts`, `automations/task-template.ts` + testy;
`server/project-context.ts`, `index.ts` (oba construction sites RunManager).

**Interfejsy:** provenance rozszerzyć o opcjonalny snapshot `TrackerAssociation` (schema z kontraktu).
Resolver: `resolveTrackerAgentEnv(root, expectedAssociation, env?)`. Legacy bez snapshotu nie
otrzymuje tokena. RunStore: `registerRunSecrets(runId, values)` — wyłącznie pamięć.

- [ ] Odtworzyć przeciek do `appendEvent/readEvents` oraz przejęcie tokena B przez run A z audytu.
- [ ] Sprawdzić source/scope/connectionId przed krokiem, Continue i recovery. Mismatch kończy próbę
  kroku czytelnym błędem bez sekretów. Obsłużyć ją istniejącym mechanizmem failed/retry.
- [ ] Rejestrować przekazywane sekrety przed spawnem; redagować NDJSON, live event i zapisywany tekst.
  Uwzględnić literal tokena i Basic Authorization w testach. Nie zmieniać globalnego env.
- [ ] Dry-run i zwykły run nie dostają realnych poświadczeń. Po zakończeniu procesu i drenażu
  zdarzeń usuwać rejestr pamięciowy. Nie obiecywać odebrania tokena już działającemu procesowi.

```ts
store.registerRunSecrets(run.id, [syntheticToken]);
store.appendEvent(run.id, { type: 'note', message: syntheticToken });
expect(JSON.stringify(store.readEvents(run.id))).not.toContain(syntheticToken);
await expect(resolveTrackerAgentEnv(root, oldAssociation, isolatedEnv))
  .rejects.toThrow(/connection|scope/i); // mismatch nie może oznaczać podmiany na nowy token
```

**Run:** `TMPDIR=/tmp npx vitest run packages/cezar/src/server/tracker/agent-credentials.test.ts packages/cezar/src/automations/task-template.test.ts packages/cezar/src/runs`

### Zadanie 3 — Wspólny cykl pollingu bez regresji GitHuba

**Pliki:** nowe `automations/event-source.ts`, `automations/event-poll-cycle.ts`,
`automations/event-poll-cycle.test.ts`; istniejące `scheduler.ts`, `store.ts`, `types.ts`,
`github-poller.ts` oraz ich testy, `coordinator.ts` tylko gdy wymaga tego mutacja/lease;
`packages/contract/src/automations.ts` dla enumu zdarzeń używanego przez adaptery.

**Interfejsy:** `runEventPollCycle<C>` przyjmuje źródło z §4, store/definition, mode preview|execute,
callback launch i kontrolę aktualności revision. Opakować GitHub bez zmiany ID zdarzeń,
placeholderów, baseline/overlap, logów i kompatybilnych zapisanych kursorów. Pozostawić
`ProjectAutomationScheduler` jako fasadę; trackerowa fasada korzysta z tej samej funkcji.

- [ ] Najpierw zdefiniować w kontrakcie `trackerAutomationEventSchema` jako Zod enum czterech
  zdarzeń z §1 i wyprowadzić `TrackerAutomationEvent = z.infer<typeof trackerAutomationEventSchema>`.
  Nie poszerza to samo w sobie obsługi tras; request/response i trigger dochodzą w zadaniu6.
- [ ] Dodać testy charakterystyczne obecnego GitHuba przed ekstrakcją, następnie uruchamiać wspólny
  zestaw na źródłach fixture github/tracker. Nie zmieniać niezwiązanych harmonogramów.
- [ ] Przenieść tylko lease, eligibility, preview/execute, rezerwację, launch-error, checkpoint,
  backoff i emit zmian. Adapter nadal odpowiada za paginację dostawcy i znaczenie checkpointu.
- [ ] Sprawdzać enabled/revision i source przed każdym startem, a stan aktualizować warunkowo
  według tej samej revision. Pause/edit i start muszą respektować wspólną blokadę mutacji,
  także pomiędzy procesami. Sam check przed `await` nie wystarczy.
- [ ] Zachować baseline czasu z enable; oceniać timestamp history event, nie issue.updatedAt.
  Preview nie rezerwuje receiptów ani nie przesuwa wykonawczego checkpointu.
- [ ] Launch-error widoczny jako błąd, retry przez istniejący receipt po reconciliation.
  Checkpoint wolno przesunąć tylko po trwałym zapisie wyniku obsługi kandydatów. Uporządkowanie
  zapisu zapobiega utracie po awarii między startem runa i potwierdzeniem receiptu.
- [ ] Usuwanie starych receiptów musi być zgodne z dopuszczalnym zakresem reskanu/checkpointu:
  nie wczytywać ponownie historii sprzed baseline/ukończonego watermarku jako nowych eventów.
  Jeżeli dowodu ciągłości brak, zgłosić lukę/rebaseline; nie odpalać90-dniowego backlogu po kompaktacji.

```ts
const pending = cycle.execute(delayedSource);
await pauseAutomation();
delayedSource.resolve([event]);
await pending;
expect(launch).not.toHaveBeenCalled();
expect(store.state(id)?.revision).toBe(pausedRevision);
```

To szkic testowego harnessu z `event-poll-cycle.test.ts`; `pauseAutomation` używa rzeczywistej
ścieżki mutacji, a nie samej zmiany lokalnej zmiennej.

**Run:** `TMPDIR=/tmp npx vitest run packages/cezar/src/automations`

### Zadanie 4 — Adapter zdarzeń Jira

**Pliki:** nowe `server/tracker/jira-events.ts`, `jira-events.test.ts`; `jira.ts`, `types.ts`,
`index.ts`, `automations/tracker-poller.ts` (zamiana status-match na fasadę źródła), fixtures.

**Interfejs:** `createJiraEventSource(...)` implementuje §4, korzysta z istniejącego transportu
z timeout/rate-limit i per-project connection, nie duplikuje przechowywania sekretów.

- [ ] Discovery issue zmienionych od watermarku w skonfigurowanym projekcie, bez `status=To Do`
  ani `active-only`. Używać stałych granic skanu i stabilnego ID issue. Zmiana opisu może wymusić
  odczyt historii, ale nie emituje status event.
- [ ] Odczytywać dedykowaną paginowaną historię; preferować endpoint per issue jako prostą wersję,
  bulk tylko gdy wynik zadania1 potwierdzi potrzebę/korzyść. Przenosić kursor niedokończonej historii
  między cyklami, zamiast zawsze czytać pierwszą stronę. Obsłużyć błąd jednej historii bez pominięcia jej.
- [ ] Normalizować historię statusu i etykiet potwierdzoną fixture; issue.opened z immutable created.
  Wiele zmian w tym samym wpisie dzielić na osobne, stabilnie identyfikowane zdarzenia.
- [ ] Utworzyć idempotentne ID według §4. Po każdej odpowiedzi weryfikować connection/scope;
  401/403 kończy cykl jako błąd,429 respektuje cooldown, invalid cursor uruchamia bezpieczny reskan.

```ts
const page = await jiraSource.poll({ baselineAt, limit: 25, signal });
expect(page.candidates.filter(e => e.event === 'issue.status_changed')).toHaveLength(2);
expect(new Set(page.candidates.map(e => e.eventId)).size).toBe(page.candidates.length);
```

**Run:** `TMPDIR=/tmp npx vitest run packages/cezar/src/server/tracker/jira-events.test.ts packages/cezar/src/server/tracker/jira.test.ts`

### Zadanie 5 — Adapter zdarzeń Linear

**Pliki:** nowe `server/tracker/linear-events.ts`, `linear-events.test.ts`; `linear.ts`,
`types.ts`, `index.ts`, fixtures. Bez instalowania `@linear/sdk`.

**Interfejs:** `createLinearEventSource(...)` implementuje identyczną granicę §4.

- [ ] Discovery ostatnio zmienionych issue danego teamu z paginacją; historia tylko dla odkrytych
  kandydatów, nie osobny poll każdego issue w całym backlogu. Archived uwzględniać zgodnie z macierzą.
- [ ] Pobierać paginowane `history` i jawne pola status/label IDs. Zod waliduje wymagane dane;
  częściowe GraphQL errors nie są sukcesem, nawet przy HTTP200.
- [ ] Mapować immutable issue/history IDs, utworzenie oraz dwa przejścia w jednym interwale.
  Stan scan/history zapisywać zgodnie z §4, bez przesuwania watermarku przy niedokończonej stronie.
- [ ] Przypiąć wynik badania granicy3min testem i opisem capability. Nie fabrykować eventu ze zmiany
  updatedAt, jeśli historia go nie zawiera. Nie reklamować pełnej obsługi wbrew wynikowi zadania1.

```graphql
query IssueAutomationHistory($id: String!, $after: String) {
  issue(id: $id) {
    id
    history(first: 50, after: $after) {
      nodes { id createdAt fromStateId toStateId addedLabelIds removedLabelIds }
      pageInfo { hasNextPage endCursor }
    }
  }
}
```

```ts
expect(mapLinearHistory(descriptionOnlyHistory)).toEqual([]);
expect(mapLinearHistory(twoTransitions).map(e => e.change.toId)).toEqual(['progress', 'todo']);
```

`mapLinearHistory` jest helperem z `linear-events.ts`. Zapytanie włączyć po potwierdzeniu aktualnej
sygnatury w zadaniu1; nie zakładać gwarancji retencji na podstawie samej poprawności GraphQL.

**Run:** `TMPDIR=/tmp npx vitest run packages/cezar/src/server/tracker/linear-events.test.ts packages/cezar/src/server/tracker/linear.test.ts`

### Zadanie 6 — Kontrakty, API, retry i zgodność zapisanej konfiguracji

**Pliki:** `packages/contract/src/automations.ts`, `tracker.ts`, `index.ts`;
`packages/api-client/src/index.ts`/istniejące re-eksporty; `packages/cezar/src/automations/types.ts`,
`task-template.ts`, `server/server.ts`, `server/project-context.ts`, `index.ts`;
`server/automations-api.test.ts`, `server/contract-parity.automations.test.ts`,
`server/route-parity.test.ts`, `BACKWARD_COMPATIBILITY.md`.

**Interfejs wire:** zachować `kind:'github'|'schedule'|'tracker'`; schema enum tracker events
z zadania3. Nie oferować trackerowi PR event. Filtr statusu przechowuje ID, nazwę tylko prezentacyjnie.
`trackerTrigger` zawiera `events`, `targetStatusIds?`, `changedLabelIds?`, snapshot association.
Adapter wyznacza capability, nie klient. Zod tego samego triggera reużyć w storage i wire;
nie migrować bez potrzeby istniejących GitHub eventów/filters.

- [ ] Kontrakt request/response definiować pierwszy, dopiero potem implementować trasę. Nowa
  definicja tracker wymaga `trackerTrigger`; poll interval domyślnie1800s, paused domyślnie.
  Odrzucać nieobsługiwane wydarzenia, scope spoza zapisanej association i ID statusu spoza projektu.
- [ ] Dodać projektowe `GET /tracker/automation-options` w istniejącym chained builderze, aliasy
  boot/scoped, schema `{ available, ... }` jako dyskryminowaną odpowiedź. Sukces niesie association,
  events i statusy/etykiety z paginacją/cursorem zgodną z discovery. Brak auth to odzyskiwalny stan,
  nie pusty katalog bez wyjaśnienia. Zdefiniować schema query przed middleware; brak danych issue/tokenów.
- [ ] Włączyć create/edit tracker w istniejących trasach. Preview/execute/retry prowadzą przez
  wspólny cykl z zadania3; używają aktualnej association oraz captured definition. W retry najpierw
  reconciliation receiptu z runem — sukces po utracie odpowiedzi nie może uruchomić duplikatu.
- [ ] Rozszerzyć tracker provenance z zadania2 o eventId/event/timestamp/change. Świeży opis issue
  pobierać przez istniejący adapter przed handoffem albo wskazaną operację agenta; dane history event
  oddzielić od bieżącego opisu i instrukcji. Brak pełnego odczytu nie ma tworzyć pustego, udanego runa.
- [ ] Stary eksperymentalny `kind:tracker` z samym filters.status nadal parsuje się i jest widoczny,
  ale silnik go nie uruchamia. Pokaż „Wybierz zdarzenie, aby dokończyć konfigurację”. Nie zgadywać,
  że status-match oznacza status_changed. Po edycji wymagaj jawnego Save/Enable i nowego baseline.
  GitHub i schedule nie wymagają żadnej migracji ani ponownego włączenia.
- [ ] Jednoznaczne błędy operacji; wire nie usuwa statusu/triggera po walidacji. Route inventory
  i dwukierunkowe contract parity mają objąć nową trasę i rozszerzone payloady.

```ts
const body = { kind: 'tracker', name: 'Jira status', intervalSeconds: 1800,
  trackerTrigger: { events: ['issue.status_changed'], targetStatusIds: ['todo-id'], association },
  task: { prompt: 'Implement {{tracker.key}} and prepare a PR.' } };
const created = await api.createAutomation(body);
expect(created.enabled).toBe(false);
expect(automationDetailResponseSchema.parse(await api.getAutomation(created.id))
  .automation.trackerTrigger?.targetStatusIds).toEqual(['todo-id']);
```

**Run:** `TMPDIR=/tmp npx vitest run packages/cezar/src/server/automations-api.test.ts packages/cezar/src/server/contract-parity.automations.test.ts packages/cezar/src/server/route-parity.test.ts`

### Zadanie 7 — Istniejący edytor, lista, CLI i dokumentacja

**Pliki web:** `routes/automations/editor.tsx`, `editor-draft.ts`, nowy `editor-tracker-fields.tsx`,
`use-automations.ts`, `automations-table.tsx`, `next-runs-preview.tsx`, `lib/automation-format.ts`,
`api/client.ts`, `api/queries.ts` i odpowiadające testy.
**Pliki service/docs:** `automations/automation-cli.ts`, `prompts.ts`, `task-template.ts`, ich testy,
`docs/adding-issue-tracker.md`, `docs/issue-trackers.md`, właściwa istniejąca dokumentacja automatyzacji.

- [ ] Dodać wybór skonfigurowanego trackera do istniejącego edytora, katalog zdarzeń z API,
  filtrowanie eventu statusem/etykietą oraz30min default. Workflow, backend, prompt, save i enable
  pozostają istniejącymi kontrolkami; brak nowego osobnego panelu automatyzacji.
- [ ] Status/label picker używa ID dostawcy, pokazuje nazwę, ma wyszukiwanie/paginację. Nie wpisywać
  z góry To Do do każdego projektu. Zmiana projektu/association unieważnia wybrane opcje i draft.
- [ ] Przed enable pokazać baseline „zdarzenia od włączenia” oraz to, że trackerowy agent dostaje
  poświadczenia projektu. Samo zapisanie integracji czy automatyzacji nie uruchamia agentów.
- [ ] Wspólne preview/check, execute, retry i duplicate; duplikat zaczyna paused z nową tożsamością.
  Nie dawać trackerowi ikon/etykiet GitHub albo harmonogramu godzinowego. Opis wyzwalacza np.
  „Jira · status changed → To Do · every30min”.
- [ ] CLI: zachować istniejące `--on` dla eventu; dodać jednoznaczny wybór kind/provider i ID filtra,
  np. `--kind tracker --on issue.status_changed --to-status <id> --interval 1800`.
  Dopasować nazwy do istniejącego parsera, aktualizując schema/help/copy-as-CLI razem. Przy braku
  association CLI odmawia z odnośnikiem do ustawień, nie wymaga ręcznej edycji JSON.
- [ ] Wspólne placeholdery tracker: provider/key/url/event oraz wartości zmiany. Nie wstrzykiwać
  title/status/labels jako instrukcji ponad granicą danych; domyślny prompt odnosi się do kontekstu
  strukturalnego. Dostawca nie może zmieniać dozwolonego hosta uwierzytelnionego żądania.
- [ ] Dokumentacja: dla kolejnego dostawcy dodać adapter, capabilities i wspólne testy, nie nowy
  scheduler. Podać rzeczywiste ograniczenia historii/retencji, limitowania i agent-side write-back.

```ts
await user.selectOptions(screen.getByLabelText('Event'), 'issue.status_changed');
await chooseStatusById('todo-id');
await user.click(screen.getByRole('button', { name: 'Save paused' }));
expect(createAutomation).toHaveBeenCalledWith(expect.objectContaining({ enable: false,
  trackerTrigger: expect.objectContaining({ events: ['issue.status_changed'], targetStatusIds: ['todo-id'] }) }));
```

**Run:** `TMPDIR=/tmp npx vitest run packages/web/src/routes/automations packages/cezar/src/automations/automation-cli.test.ts packages/cezar/src/automations/task-template.test.ts`

### Zadanie 8 — Odbiór całości i niezależny review

**Pliki testowe:** nowy `packages/web/e2e/tracker-automations.e2e.ts` i wspólny zestaw scenariuszy
w `packages/cezar/src/automations/event-poll-cycle.test.ts`; dowody `.ai/qa/tracker-automation-events/`.
Nie edytować pozostałych funkcji podczas bramki bez nowego odtworzonego błędu.

- [ ] Fixture uruchamia osobny serwer, CEZ_HOME i repo. Zegar testowy dla30min; osobno smoke normalnego
  timera bez zmiany stałych produkcyjnych. GitHub/Linear/Jira nie kontaktują live usług w tym scenariuszu.
- [ ] UI: create paused → preview bez runa → enable → event po baseline → dokładnie jeden run →
  ponowny odczyt tego eventu bez runa → drugie rzeczywiste przejście z nowym eventId → drugi run.
- [ ] Pokryć stare zdarzenie sprzed enable, opis bez status event, etykiety add/remove, wielostronicowe
  discovery i historię,429, opóźnione indeksowanie w obrębie overlap, brak uprawnień, archived,
  pause/edit/connection change w locie, restart i launch-error/retry bez duplikatów.
- [ ] Wspólne testy GitHuba potwierdzają niezmienione triggery, receipts i domyślne zachowanie;
  schedule działa jak przed zmianą. Eksperymentalna legacy definicja trackera jest widoczna,
  lecz nie startuje bez wybranego eventu.
- [ ] Snapshot runa, event stream i logi nie zawierają syntetycznych tokenów. Linki/dozwolone hosty
  nie pochodzą bezkrytycznie z danych issue. Brak ekspozycji z jednego projektu w drugim.
- [ ] Niezależny przegląd końcowego diffu: wszystkie P1 audytu mają regresję; provider limitations
  są jawne; nie doszło do przypadkowego poszerzenia zakresu. Wykryte błędy naprawiać z testem,
  nie uznawać samego zielonego monorepo za dowód kompletności.

```bash
TMPDIR=/tmp npm test
TMPDIR=/tmp npm run build
TMPDIR=/tmp npm run typecheck
TMPDIR=/tmp npm run test:unit
TMPDIR=/tmp npm run test:package
git diff --check
```

Scenariusz e2e uruchomić przez repozytoryjny provider `packages/web/e2e/agent-browser.ts` i
istniejący workflow `npm run test:e2e` zgodnie z descriptorami. Nie używać osobnego browser-stacku.
Live smoke odczytu historii jest opcjonalnym uzupełnieniem dowodów. Live tworzenie PR i zmiana
statusu nie należą do automatycznej bramki bez odrębnego polecenia użytkownika.

## 6. Kolejność i warunki zakończenia

Zależności: `1 → (4,5)`, `2 → 6`, `3 → (4,5,6)`, `(4,5,6) → 7 → 8`.
Zadanie2 jest niezależne od discovery dostawców;3 może powstawać na syntetycznym źródle.
4 i5 mają różne adaptery, ale zmiany wspólnego types/index trzeba integrować sekwencyjnie.
Nie rozpoczynać UI udającego pełne capabilities przed wynikiem1.

Gotowe oznacza: selectable event dla obsługiwanych capability, wspólna obsługa jak GitHub,
naprawione P1 i krytyczne retry/pagination/contract gaps, brak regresji starego GitHub/schedule,
zielona bramka, przegląd i dowody przeglądarkowe. Jeśli źródło nie pozwala spełnić wybranej
capability (np. brak części historii), raport końcowy wskazuje ograniczenie i brak pełnego parytetu;
nie uznawać ukrycia eventu za realizację całego oczekiwania użytkownika.

Nie wchodzi do zakończenia: server-side write-back, webhook/relay/public endpoint, nowy storage,
rework harmonogramów, permanentna deduplikacja issue, import starego backlogu czy auto-merge.

## 7. Samokontrola planu

- [x] Wymaganie wybierania zdarzeń odróżnione od status-match i częstotliwości pollingu.
- [x] Minimalny wspólny silnik; GitHub nie traci starego formatu, cursorów ani operacji.
- [x] Wszystkie cztery P1 z audytu mają zadanie i test odbioru (2,3,6).
- [x] P2 dedup/pagination/retry/contract/UI są przypisane do3–7.
- [x] Brak danych uwierzytelniających i poleceń publikacji w planie.
- [x] Znane ograniczenie historii Lineara opisane, a probe capability jest jawnym zadaniem1.
- [x] Statusy/etykiety według rzeczywistych ID; niezaufane pola nie definiują uprawnień.
- [x] Weryfikacja projektu i źródeł wykonana; kod, testy wykonawcze i wdrożenie nie są realizowane
  podczas sporządzenia planu.
