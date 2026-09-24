# 006 — Worktree per task, kolejka i `maxParallel`

Status: ZAIMPLEMENTOWANE 2026-07-10 · Fala: 2 · Zależy od: — · Wzorzec: janitor `git.ts` (worktree + autosave) i `tasks.ts` (`pump()`)

## Cel

Taski przestają deptać po working tree użytkownika i mogą chodzić
**równolegle**: każdy dostaje własny git worktree i branch, a kolejka pilnuje
limitu równoległości. To fundament pod warianty (010) i spokojną codzienną
pracę ("agent robi, ja dalej koduję u siebie").

## UX (jak cep)

- User niczego nie wybiera. Task po prostu **nie dotyka** jego plików —
  pracuje na branchu `cez/<krótkie-id>` w ukrytym katalogu.
- Na kafelku taska w kolejce: badge `queued (2 w kolejce)`.
- W szczegółach taska: zakładka **Diff** pokazuje zmiany *tego taska*
  (diff worktree vs branch bazowy) — to jest widok "co agent zrobił".
- Zmiany trafiają do repo usera wyłącznie przez PR (przycisk w spec 009) —
  albo ręcznie (`git merge cez/<id>`); komenda do skopiowania w headerze.
- Awaryjny czysty tryb: task typu `quick-task` z pytaniem "w moim katalogu?"
  — NIE. Zero opcji. Zawsze worktree, bo prościej *dla usera* jest nie musieć
  rozumieć różnicy.

## Zakres

1. **Worktree per task** (z lokalnego repo — bez bare clone, jesteśmy już w
   working copy):
   - `git worktree add -b cez/<id8> .ai/cezar/worktrees/<id> <baseBranch>`
     (baza = bieżący branch w momencie startu; zapisana na tasku),
   - `.ai/cezar/worktrees/` w generowanym `.gitignore`,
   - run.cwd = worktree; `--add-dir` bez zmian.
2. **Autosave-commit** (wzorzec janitora): co 90 s i na końcu taska
   `git add -A && git commit --no-verify -m "cez autosave"` w worktree —
   postęp agenta zawsze odzyskiwalny z historii. Commity autosave squashuje
   krok PR (009) — na razie zostają w branchu.
   *Aneks (2026-07-17, #471):* okresowy timer 90 s jest **opt-in** przez
   `CEZ_AUTOSAVE=1` (domyślnie wyłączony — commity autosave w środku runa
   zaśmiecały historię PR-ów). Flushe na końcu tury i przed draft-PR zostają
   bez zmian, więc branch nadal kończy z pełnym stanem, a diff/review/PR
   działają jak dotąd.
3. **Kolejka + `maxParallel`**: `RunManager` dostaje prostą kolejkę
   (`queue: runId[]`, `pump()` po każdym starcie/końcu); limit z config.json
   (`maxParallel`, default **2**); zbiór `starting` łatający race przy
   liczeniu slotów (subtelność podpatrzona w janitorze).
4. **Sprzątanie**: przy delete taska — `git worktree remove --force` + kasacja
   brancha; przy archiwizacji — worktree zostaje (do inspekcji), przycisk
   „Usuń worktree" w szczegółach zarchiwizowanego. Reconcile przy starcie:
   osierocone worktrees bez taska w indeksie → `git worktree prune` + report.
5. **Repo view per task**: `GET /api/runs/:id/diff` (diff worktree vs base).
   Globalna zakładka Repo zostaje jak jest (working tree usera).
6. **Degradacja**: katalog nie jest repo gitowym → taski działają jak dziś
   (w cwd, sekwencyjnie `maxParallel=1`), z notką w headerze.

## Poza zakresem

- Bare clone + multi-repo (janitorowy model "controller dla wielu repo") —
  Cez to narzędzie "wchodzisz w repo i odpalasz jak edytor".
- Automatyczny merge do brancha usera.

## Projekt techniczny

- Nowy moduł `src/git-worktree.ts` (~120 LOC): `createWorktree(runId, base)`,
  `removeWorktree`, `autosaveCommit`, `worktreeDiff`, `pruneOrphans` — wszystko
  `execFile('git')`, wzorowane na `worktree.ts` ze starego cezara + autosave
  z janitora.
- `src/workflows/run.ts`: kolejka/pump/limit; `cwd` per run; timer autosave
  (clearInterval na końcu); check-steps też w worktree.
- `src/runs/store.ts`: pola `worktreePath?`, `baseBranch?`, `branch?`.
- GUI: badge kolejki, zakładka Diff w szczegółach, przycisk usuwania worktree.

## Kroki implementacji

1. `git-worktree.ts` + testy (fixture repo w tmp).
2. RunManager: kolejka + pump + starting-set + limity.
3. Integracja cwd/worktree + autosave + sprzątanie + reconcile.
4. Diff endpoint + GUI.
5. Test: 3 taski naraz przy `maxParallel=2` — trzeci czeka; diffy rozłączne.

## Kryteria akceptacji

- Dwa taski równolegle nie modyfikują working tree usera ani siebie nawzajem.
- `git branch` po tasku: jest `cez/<id8>` z commitami autosave + final.
- Zakładka Diff pokazuje dokładnie zmiany taska.
- Delete sprząta worktree i branch; restart procesu nie zostawia zombie
  worktrees (prune + raport w logu startowym).
- W katalogu nie-git wszystko działa po staremu.

## Hardening 2026-07-16 — issue #438

The original degradation rule was too broad: a Git task that requested the
default isolated mode could silently execute in the user's repository working
tree after `git worktree add` failed. Serializing that fallback prevents two
fallback agents from overlapping, but it still violates the primary isolation
contract and lets an agent modify unrelated user changes.

For a Git repository, an isolated task now has a fail-closed contract:

- Worktree creation is idempotent for the same task. A registered, valid
  worktree is reused.
- Stale Git worktree metadata is pruned before creation. If the task branch
  survived while its worktree directory did not, cezar reattaches that branch
  instead of trying `-b` again and failing with “branch already exists”.
- An existing managed path is repaired when Git can recover it. Cezar never
  repurposes a worktree registered to another branch.
- If isolation still cannot be established, the task fails before any workflow
  step or agent process starts. It does not run in the repository root.
- The explicit `worktree: false` opt-out and non-Git degradation remain
  supported. Repository-root execution stays serialized by default for those
  intentional modes. Advanced users may set the exact opt-in
  `CEZ_DISABLE_REPO_LOCK=1` to bypass that lease for any run executing in the
  repository root, including a resumed session whose worktree cannot be
  restored. This mode is intentionally unsafe: concurrent agents may overwrite
  each other's files or Git state. Isolated worktree runs are unaffected.

Hardening acceptance checks:

- Re-running creation for the same task returns the same valid worktree.
- Deleting a task worktree directory, pruning Git metadata, and creating it
  again reattaches the surviving task branch and preserves its commits.
- A forced worktree-creation error produces a failed run and executes no
  workflow command in the repository root.
- Two explicit worktree opt-out runs still serialize repository-root access by
  default; with `CEZ_DISABLE_REPO_LOCK=1`, two root runs may overlap and each
  emits a visible unsafe-mode note.
