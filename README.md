# @jfs/cache-kit

Shared, dependency-free **client-side storage / cache primitives** for the JFS
family of buildless static sites (market-monitor, Surf-Tracker, FlightCheck,
JFS-Sports, Art-Gallery-, Weather, BearsMockDraft, Zepbound-).

Three sibling apps grew three different wrappers around the same two browser
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
nothing and touches no global at import time — `localStorage` is resolved at
call time, so node tests can stub it on `globalThis` and non-browser
environments degrade to safe no-ops.

## Scope (v0.3.0): localStorage primitives only

The kit used to carry a second tier — `createCacheStore` /
`createPrefsStorage`, an IndexedDB-backed store with an in-memory mirror,
`structuredClone` isolation, soft TTLs and legacy-localStorage migration. It
had exactly **one** consumer (JFS-Sports) while being half the kit's lines, so
in v0.3.0 it went back to that app as ordinary source
(`JFS-Sports/cache-store-idb.js`, bound to the app's store identity by
`cache-store.js`). The family's extraction bar wants a **third** consumer
before shared code earns a kit's permanent CI / pin / vendoring overhead — a
one-consumer tier never cleared it.

This is a **breaking** removal for anyone importing those two names; the ten
localStorage helpers below are untouched, so the remaining consumers
(Weather → `saveSnapshot` / `readSnapshot`, FlightCheck → `lsGet` / `lsSet` /
`lsRemove`, market-monitor → `safeSetItem` / `writeTtlJson` / `readTtlJson` /
`readTtlJsonTimestamp`) upgrade with no call-site change.

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

- `FlightCheck/src/tracking/state.js` — `lsGet` / `lsSet` / `lsRemove`
- `Weather/js/lib/storage.js` — `saveSnapshot` / `readSnapshot`
- `market-monitor/js/utils/cache.js` — `isQuotaError`, its private
  `_safeSet` (as `safeSetItem`), `_safeParse` (as `readTtlJson`), and
  `getCacheTimestamp`'s read (as `readTtlJsonTimestamp`)

## Module map

Everything lives in the single `index.js`:

```
index.js
├── safe localStorage wrappers                      (origin: FlightCheck)
│     lsGet(key)                 read; null on missing/unavailable/error
│     lsSet(key, value)          best-effort write, never throws
│     lsRemove(key)              best-effort remove, never throws
│
├── quota-aware writes                              (origin: market-monitor)
│     isQuotaError(e)            QuotaExceededError / NS_ERROR_DOM_QUOTA_REACHED
│                                / code 22 / code 1014
│     safeSetItem(key, value, {ownedKeys})
│                                write one key; on quota, evict the OTHER
│                                ownedKeys and retry once (only when key is
│                                itself owned) → boolean
│
└── JSON snapshots with TTL
      saveSnapshot(key, payload)           write {at: now, payload}   (Weather)
      readSnapshot(key, maxAgeMs)          whole {at, payload} | null (Weather)
      writeTtlJson(key, data, {ts, ownedKeys})
                                           write {ts, data} via safeSetItem
                                           → boolean         (market-monitor)
      readTtlJson(key, maxAgeMs)           data | null; rejects non-object /
                                           array data        (market-monitor)
      readTtlJsonTimestamp(key, maxAgeMs)  ts | null, no data-shape check —
                                           for "as of …" labels
```

Every ingestion path parses through a `__proto__`/`constructor`/`prototype`
stripping reviver, at every nesting level (arrays included), so a poisoned
localStorage entry can't pollute a consumer that deep-merges the result.

## Quick start

```js
import {
  lsGet, lsSet,                 // safe wrappers
  saveSnapshot, readSnapshot,   // snapshots (Weather shape)
  writeTtlJson, readTtlJson,    // snapshots (market-monitor shape)
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

2. Wire the kit's own vendoring CLI (`jfs-cache-kit-vendor`, shipped as
   `bin/vendor.mjs`) into the repo's `vendor:sync` / `vendor:check` npm
   scripts — no hand-rolled `scripts/vendor-cache-kit.mjs` needed:

   ```json
   "vendor:sync":  "jfs-cache-kit-vendor --format esm --out js/vendor/cache-kit/index.js",
   "vendor:check": "jfs-cache-kit-vendor --format esm --out js/vendor/cache-kit/index.js --check"
   ```

   Use `--format bare` for an export-stripped copy for classic-script
   concatenation builds. CI gates `vendor:check`, so a pin bump without a
   regenerated vendored copy fails the build.

3. To upgrade: bump the pinned SHA, `npm install && npm run vendor:sync`,
   commit the refreshed vendored file(s), and bump the repo's shipped version
   per its `CLAUDE.md` (the vendored kit is a shipped asset).

## Versioning

Semver, starting at `0.1.0`. On every change to `index.js`:

- bump `version` in `package.json` (the `index.js` banner deliberately
  carries no version — vendored copies get `v${pkg.version}` stamped by the
  shared vendor CLI, so there is nothing to keep in sync by hand);
- tag the release commit `vX.Y.Z` (tags are for humans; consumers still pin
  by commit SHA).

## Testing

```
npm test        # node --test test.mjs
node --check index.js
```

The suite hand-rolls its `localStorage` fake (with a quota-throwing item cap)
and installs it on `globalThis` before exercising the helpers — the same
pattern the origin app suites used. CI (`.github/workflows/test.yml`) runs
`node --check index.js` plus the suite on every push and PR.

## License

MIT
