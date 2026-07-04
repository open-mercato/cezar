# Ewaluacja oxc (oxlint + oxfmt) vs ESLint + Prettier

> Branch: `feat/oxc-evaluation` (z `origin/main`, 8d49a41).
> Data: 2026-06-21. Wersje: `oxlint@1.70.0`, `oxfmt@0.55.0`, `eslint@9`, `prettier@3`.
> Porównanie na tym samym kodzie monorepo (~326 plików TS/TSX).

## TL;DR

oxc jest **dramatycznie szybszy** (~20×) i **w pełni zgodny z Prettierem** w formatowaniu,
ale **oxlint nie pokrywa nowoczesnych reguł `react-hooks`** (React Compiler:
`set-state-in-effect`, `purity`, `refs`, `exhaustive-deps`), na których opiera się
obecna konfiguracja ESLint dla pakietu `gui` — to 34 z 53 realnych ostrzeżeń.

**Rekomendacja:** przyjąć **oxfmt zamiast Prettiera od razu** (zero kosztu, ogromny zysk
szybkości), a **oxlint wprowadzić jako szybki pierwszy przebieg obok ESLinta**, nie jako
pełne zastąpienie — dopóki react-hooks/React Compiler nie będą pokryte natywnie
(lub przez stabilne JS plugins, obecnie alpha).

## Szybkość (to samo repo, warm)

| Narzędzie                    | Czas     |
| ---------------------------- | -------- |
| ESLint (`eslint .`)          | ~7,3 s   |
| Prettier (`--check .`)       | ~2,6 s   |
| **Razem ESLint + Prettier**  | **~10 s** |
| oxlint (pełna konfiguracja)  | ~0,2–0,6 s |
| oxfmt (`--check .`)          | ~0,15–0,25 s |
| **Razem oxlint + oxfmt**     | **~0,5 s** |

→ **~20× szybciej.** oxc to natywny binarny Rust z wielowątkowością (10 wątków),
bez narzutu startu Node.

## Pokrycie lintera (po odwzorowaniu obecnej konfiguracji ESLint)

ESLint — 53 ostrzeżenia:

| Reguła                          | Liczba |
| ------------------------------- | ------ |
| react-hooks/set-state-in-effect | 18     |
| @typescript-eslint/no-unused-vars | 11   |
| react-hooks/purity              | 10     |
| react-hooks/exhaustive-deps     | 4      |
| next/no-img-element             | 4      |
| react-hooks/refs                | 2      |
| (pozostałe)                     | 4      |

oxlint — 28 ostrzeżeń:

| Reguła                                | Liczba |
| ------------------------------------- | ------ |
| eslint(no-unused-vars)                | 10     |
| unicorn(no-useless-fallback-in-spread)| 6      |
| next(no-img-element)                  | 4      |
| next(no-html-link-for-pages)          | 4      |
| unicorn(no-thenable)                  | 1      |
| unicorn(no-invalid-remove-event-listener) | 1 |
| eslint(prefer-const)                  | 1      |
| eslint(no-constant-binary-expression) | 1      |

### Luka: reguły `react-hooks` (React Compiler)

To najważniejsze odkrycie. Obecna konfiguracja ESLint używa `eslint-plugin-react-hooks`
v6 (era React Compiler) z regułami `set-state-in-effect`, `purity`, `refs`,
`exhaustive-deps`. **oxlint ich nie implementuje:**

- `set-state-in-effect`, `purity` — **nie istnieją** w schemacie oxlint.
- `rules-of-hooks`, `exhaustive-deps` — są w oxlint, ale nawet po jawnym włączeniu
  (`-W react-hooks/exhaustive-deps`) **nie wykryły** żadnego z 4 przypadków, które
  złapał ESLint.

W praktyce oxlint **przeoczył 34 z 53 realnych ostrzeżeń** ESLinta — wszystkie dotyczące
poprawności hooków React w pakiecie `gui`. To realny ubytek sygnału jakościowego.

### Co oxlint dodaje (czego ESLint tu nie miał)

- `unicorn/no-useless-fallback-in-spread` (6), `unicorn/no-thenable` (1),
  `unicorn/no-invalid-remove-event-listener` (1) — przydatne reguły z domyślnego unicorn.
- `next/no-html-link-for-pages` (4).

## Formatowanie: oxfmt vs Prettier

Zgodność z Prettierem na tym repo jest **pełna i dwukierunkowa**:

- Kod sformatowany Prettierem → `oxfmt --check` przechodzi w 100% ("All matched files use the correct format").
- Kod sformatowany oxfmt → `prettier --check` zgłasza **0 różnic** na wszystkich plikach TS/TSX.
- Konfiguracja `.prettierrc.json` migruje 1:1 przez `oxfmt --migrate prettier` (+ import `.prettierignore`).

**Znaleziony problem (oxfmt 0.55.0 beta):** jeden plik
(`packages/core/tests/actions/autofix/orchestrator.test.ts`) wymagał **dwóch**
przebiegów `--write`, by się ustabilizować (łańcuch `vi.fn().mockResolvedValue(...)`) —
drobny błąd idempotencji. Prettier gwarantuje idempotencję. Po drugim przebiegu wynik
jest zgodny z Prettierem.

## Dodatkowe czynniki

- **Type-aware linting:** oxlint oferuje je przez `tsgolint` (59/61 reguł
  typescript-eslint). Obecna konfiguracja ESLint i tak nie jest type-aware, więc to
  potencjalny bonus, nie regres.
- **JS plugins (alpha, marzec 2026):** oxlint potrafi uruchamiać pluginy ESLinta przez
  API zgodne z ESLint — teoretycznie mógłby uruchomić prawdziwy `eslint-plugin-react-hooks`
  i domknąć lukę. Status alpha + narzut wydajnościowy — nie do produkcji jeszcze.
- **Konfiguracja:** oxlint czyta jeden `.oxlintrc.json` dla całego monorepo (prostsze niż
  per-workspace `eslint .`); format zgodny z ESLint v8. Kilka reguł ESLinta nie istnieje
  (`react/prop-types` itd.) i trzeba je usunąć z konfiguracji.

## Macierz decyzyjna

| Kryterium                       | ESLint + Prettier | oxc (oxlint + oxfmt) |
| ------------------------------- | ----------------- | -------------------- |
| Szybkość                        | ~10 s             | ~0,5 s (**~20×**)    |
| Formatowanie (zgodność)         | baseline          | 100% zgodne, ~17× szybsze |
| Reguły react-hooks / React Compiler | ✅ pełne       | ❌ brak (–34 ostrzeżenia) |
| Type-aware linting              | nie skonfigurowane | dostępne (tsgolint) |
| Ekosystem pluginów              | dojrzały          | alpha (JS plugins)   |
| Dojrzałość                      | stabilny          | oxlint stabilny, oxfmt beta |
| Koszt migracji                  | —                 | niski (config 1:1)   |

## Rekomendacja

1. **oxfmt zastępuje Prettiera teraz.** Zgodność pełna, migracja trywialna, ~17× szybciej.
   Jedyne zastrzeżenie: oxfmt to beta — uruchomić `oxfmt` w CI z `--check` i obserwować
   idempotencję (lub przypiąć wersję).
2. **oxlint jako szybki przebieg, nie pełne zastąpienie ESLinta.** Dodać oxlint jako
   pierwszą, błyskawiczną bramkę (świetny lokalnie / na pre-commit), ale **utrzymać ESLint
   dla `gui`** dopóki reguły React Compiler nie są pokryte natywnie. Użyć
   `eslint-plugin-oxlint`, by wyłączyć w ESLint reguły już pokryte przez oxlint i nie
   dublować pracy.
3. **Re-ewaluować** pełne przejście na oxlint, gdy JS plugins wyjdą ze stanu alpha
   (wtedy realny `eslint-plugin-react-hooks` ruszy w oxlint).

## Jak odtworzyć

```bash
git checkout feat/oxc-evaluation
yarn install
yarn lint           # oxlint, ~0.5s
yarn format:check   # oxfmt --check
yarn format         # oxfmt --write
```
