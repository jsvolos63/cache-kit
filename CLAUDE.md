# @jfs/cache-kit — working notes for Claude

Shared, dependency-free client-side **localStorage** primitives (safe
wrappers that never throw, JSON snapshots with TTL, and quota-aware
multi-key saves) extracted from the JFS family of buildless static sites.
Consumers vendor this kit via its own CLI rather than installing it at
runtime, so a change here reaches an app only once that app bumps its pin
and re-runs `vendor:sync`.

## Scope: no IndexedDB store here (v0.3.0)

The kit shipped a second tier until v0.3.0 — `createCacheStore` /
`createPrefsStorage`, an IndexedDB store with an in-memory mirror,
structuredClone isolation, soft TTLs and legacy-localStorage migration.
It had exactly ONE consumer, JFS-Sports, while being half the kit's 583
lines, so it went home as ordinary app source
(`JFS-Sports/cache-store-idb.js` + its `tests/cache-store-idb.test.js`,
bound to the app's deployed store identity by `cache-store.js`). Per the
family's extraction bar below, a one-consumer tier never qualified.

What's left is what three apps actually import, and nothing else:

| export | consumer |
| --- | --- |
| `lsGet` / `lsSet` / `lsRemove` | FlightCheck `src/tracking/state.js` |
| `saveSnapshot` / `readSnapshot` | Weather `js/lib/storage.js` |
| `safeSetItem` / `writeTtlJson` / `readTtlJson` / `readTtlJsonTimestamp` | market-monitor `js/utils/cache.js`, `js/ui/news.js` |

(`isQuotaError` is exported too — used internally by `safeSetItem`.)

Don't re-add an IndexedDB store on one app's behalf: if a second and a
third app need one, take `cache-store-idb.js` back rather than rebuilding
it. `parseSafeJson` / `depollute` are NOT tier-2 leftovers — every
snapshot reader here parses through them, and JFS-Sports carries its own
copy for the two ingestion paths its store owns.

<!-- jfs-family-conventions:start — managed by jfs-claude-md-sync; edit family/family-conventions.md in @jfs/vendor-cli -->

## Family conventions

These conventions are identical across every repo in the @jfs family. The
section is managed by `jfs-claude-md-sync` (@jfs/vendor-cli) and checked by
family CI — edit `family/family-conventions.md` in the vendor-cli repo, not
here.

### Pull requests

Open pull requests **ready for review — never as drafts.** This applies to
PRs opened by automated Claude Code sessions too: some hosted environments
default to creating drafts, so mark the PR ready as part of opening it
rather than leaving it for a follow-up.

### Kit extraction bar

Extract shared code into a NEW `@jfs/*` kit only when both hold: a third
repo needs the same code, AND drift between the existing copies has already
caused a real bug or a manual reconciliation. Until then, copy-pasting
between two repos is cheaper than a new repo's permanent CI, pin, and
vendoring overhead. Prefer growing an existing kit over minting a new one.

<!-- jfs-family-conventions:end -->
