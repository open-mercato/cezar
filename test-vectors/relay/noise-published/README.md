# Published Noise vectors

`vectors.json` is the subset of two public vector files that uses this protocol's suite, unchanged
apart from the added `source` key:

| Source | File | Upstream SHA-256 | Patterns taken |
| --- | --- | --- | --- |
| cacophony | `tests/vectors/cacophony.txt` in `mcginty/snow` at `8ac60f51cfe3e010c84f0a454cc575ad9204fa12` | `3bde7c09a6f349ee11c825c50fcc02649f8f02a47c857a459206b357f9386cae` | KK, XX, XXpsk3 |
| snow | `tests/vectors/snow.txt` in the same commit | `69da433305fd045f6c9f01b656662a389d022688986fd39fbe7af009cd402fd3` | KK, XX |

`snow.txt` has no `XXpsk3` entry for this suite, so `XXpsk3` rests on cacophony's vector here. The
`snow-check` crate adds a second implementation for it. Rekey appears in neither file, and is
covered by `snow-check` alone.
