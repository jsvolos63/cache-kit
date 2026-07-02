# @jfs/cache-kit

Shared, dependency-free **client-side storage / cache primitives** for the JFS
family of buildless static sites (market-monitor, Surf-Tracker, FlightCheck,
JFS-Sports, Art-Gallery-, Weather, BearsMockDraft, Zepbound-).

Four sibling apps grew four different wrappers around the same two browser
facts — `localStorage` throws (private browsing, quota, locked-down iframes)
and cached data goes stale — each copy slightly different, and the differences
are exactly the subtle bugs (a quota rejection that silently drops the *rest*
of a multi-key save, a snapshot that outlives its data, caller mutation
poisoning a cached object). This module is the single tested copy. It is the
5th kit in the family, after
[`@jfs/netlify-kit`](https://github.com/jsvolos63/netlify-kit) (serverless
primitives), `@jfs/pwa-kit` (service-worker strategies),
[`@jfs/news-kit`](https://github.com/jsvolos63/news-kit) (RSS pipeline), and
[`@jfs/dom-kit`](https://github.com/jsvolos63/dom-kit) (escaping / URL
guards).

Pure ESM, **dependency-free at install and runtime**. `index.js` imports
nothing and touches no global at import time — `localStorage` / `indexedDB` /
`structuredClone` are resolved at call time (or injected via `deps`), so node
tests can stub them on `globalThis` and non-browser environments degrade to
safe no-ops.

## Compatibility superset

Apps adopt the kit by **changing import paths, not call sites** — the same
rule `netlify-kit` and `dom-kit` follow. Every helper keeps its origin's exact
name, signature, and **on-disk format**, so data already in users' browsers
keeps parsing after adoption. In particular, the two snapshot shapes and their
two freshness comparisons are kept side by side rather than collapsed:

| | shape | fresh while | origin |
|---|---|---|---|
| `saveSnapshot` / `readSnapshot` | `{at, payload}` | `now - at <= maxAgeMs` (inclusive) | Weather |
| `writeTtlJson` / `readTtlJson` | `{ts, data}` | `now - ts < maxAgeMs` (exclusive) | market-monitor |

The consolidated canonical sources:

- `JFS-Sports/cache-store.js` — `createCacheStore` (the family's
  best-in-class store: IndexedDB + in-memory mirror + `structuredClone`
  isolation + soft TTLs + legacy-localStorage migration + localStorage-shaped
  facade), `prefsStorage` (as the `createPrefsStorage` factory)
- `FlightCheck/src/tracking/state.js` — `lsGet` / `lsSet` / `lsRemove`
- `Weather/js/lib/storage.js` — `saveSnapshot` / `readSnapshot`
- `market-monitor/js/utils/cache.js` — `isQuotaError`, its private
  `_safeSet` (as `safeSetItem`), `_safeParse` (as `readTtlJson`), and
  `getCacheTimestamp`'s read (as `readTtlJsonTimestamp`)

## Module map

Everything lives in the single `index.js`:

```
index.js
├── Tier 1a — safe localStorage wrappers            (origin: FlightCheck)
│     lsGet(key)                 read; null on missing/unavailable/error
│     lsSet(key, value)          best-effort write, never throws
│     lsRemove(key)              best-effort remove, never throws
│
├── Tier 1b — quota-aware writes                    (origin: market-monitor)
│     isQuotaError(e)            QuotaExceededError / NS_ERROR_DOM_QUOTA_REACHED
│                                / code 22 / code 1014
│     safeSetItem(key, value, {ownedKeys})
│                                write one key; on quota, evict the OTHER
│                                ownedKeys and retry once (only when key is
│                                itself owned) → boolean
│
├── Tier 1c — JSON snapshots with TTL
│     saveSnapshot(key, payload)           write {at: now, payload}   (Weather)
│     readSnapshot(key, maxAgeMs)          whole {at, payload} | null (Weather)
│     writeTtlJson(key, data, {ts, ownedKeys})
│                                          write {ts, data} via safeSetItem
│                                          → boolean         (market-monitor)
│     readTtlJson(key, maxAgeMs)           data | null; rejects non-object /
│                                          array data        (market-monitor)
│     readTtlJsonTimestamp(key, maxAgeMs)  ts | null, no data-shape check —
│                                          for "as of …" labels
│
└── Tier 2 — IndexedDB store (advanced, opt-in)     (origin: JFS-Sports)
      createCacheStore(deps)     async-persisted, sync-read KV store:
                                 init() / get / set(key, value, {ttlMs}) /
                                 delete / keys() / isReady /
                                 localStorageFacade / _drain (test hook)
      createPrefsStorage(store, {localStorage})
                                 () => facade once store.isReady, else raw
                                 localStorage (call-time resolution) or null
```

### `createCacheStore(deps)` configuration

`deps` carries both environment injections and per-app config, all optional:

- `indexedDB`, `localStorage`, `structuredClone`, `now` — environment
  (default: the globals; pass `null` to force memory-only / skip migration).
- `dbName` (`'jfs-cache'`), `dbVersion` (`1`), `storeName` (`'kv'`) — IDB
  identity. The defaults match the database JFS-Sports already deployed;
  pass your own for a store with no history.
- `legacyPrefixes` (`[]`) — localStorage keys (exact or prefix match)
  migrated into the store on first `init()`, then removed from localStorage.
- `wrapMarker` (`'__jfsW'`) — marker property on the TTL wrapper objects.
  The default matches data already on disk in deployed apps; only change it
  for a fresh store.
- `warnLabel` (`'[cache-kit]'`) — prefix for the once-per-session console
  warnings (hydrate failure, first failed write).

## Quick start

```js
import {
  lsGet, lsSet,                          // tier 1a
  saveSnapshot, readSnapshot,            // tier 1c (Weather shape)
  writeTtlJson, readTtlJson,             // tier 1c (market-monitor shape)
  createCacheStore, createPrefsStorage,  // tier 2
} from '@jfs/cache-kit';

// Never-throwing localStorage:
lsSet('last_flight', 'UA123');
const last = lsGet('last_flight');       // null in private mode, never throws

// Offline fallback snapshot with a 6h TTL:
saveSnapshot('forecast', data);
const snap = readSnapshot('forecast', 6 * 3600e3);
if (snap) render(snap.payload, snap.at);

// Multi-key save that survives quota pressure (most valuable written last):
const OWNED = ['app_light_cache', 'app_main_cache'];
const ts = Date.now();
writeTtlJson('app_light_cache', light, { ts, ownedKeys: OWNED });
writeTtlJson('app_main_cache', main, { ts, ownedKeys: OWNED });

// IndexedDB-backed store with sync reads:
const store = createCacheStore({ dbName: 'my-app', legacyPrefixes: ['myapp_'] });
await store.init();
store.set('scores_2026-07-01', payload, { ttlMs: 45_000 });
const scores = store.get('scores_2026-07-01');   // isolated copy, or null
const prefsStorage = createPrefsStorage(store);  // localStorage-shaped facade
```

## Consuming from the sibling apps

The consumers are buildless static sites — the browser can't `npm install` at
runtime. Follow `netlify-kit`'s vendoring model:

1. Pin the kit in `package.json` **by full commit SHA** (never a tag — tags
   are mutable):

   ```json
   "devDependencies": {
     "@jfs/cache-kit": "github:jsvolos63/cache-kit#<full-commit-sha>"
   }
   ```

2. Add a `scripts/vendor-cache-kit.mjs` that copies
   `node_modules/@jfs/cache-kit/index.js` into the app tree (ESM copy; plus
   an export-stripped `index.global.js` for classic-script concatenation
   builds like JFS-Sports'), and wire it into the repo's existing
   `vendor:sync` / `vendor:check` npm scripts. CI gates `vendor:check`, so a
   pin bump without a regenerated vendored copy fails the build.

3. To upgrade: bump the pinned SHA, `npm install && npm run vendor:sync`,
   commit the refreshed vendored file(s), and bump the repo's shipped version
   per its `CLAUDE.md` (the vendored kit is a shipped asset).

## Versioning

Semver, starting at `0.1.0`. On every change to `index.js`:

- bump `version` in `package.json` **and** the `@jfs/cache-kit vX.Y.Z` header
  comment at the top of `index.js` — same value, same commit;
- tag the release commit `vX.Y.Z` (tags are for humans; consumers still pin
  by commit SHA).

## Testing

```
npm test        # node --test test.mjs
node --check index.js
```

No devDependencies: the suite hand-rolls its `localStorage` fake (with a
quota-throwing item cap) and a microtask-driven IndexedDB stub, installing
them on `globalThis` before exercising the helpers — the same pattern the
origin app suites used. The tier-2 cases are ported from JFS-Sports'
`tests/cache-store.test.js` so the canonical behavior is enforced here, in
the kit, from day one. CI (`.github/workflows/test.yml`) runs
`node --check index.js` plus the suite on every push and PR.

## License

MIT
