// @jfs/cache-kit — shared, dependency-free client-side storage / cache
// primitives for the JFS family of buildless static sites.
//
// Four sibling apps grew four different wrappers around the same two browser
// facts — localStorage throws (private browsing, quota, locked-down iframes)
// and cached data goes stale — each copy slightly different, and the
// differences are exactly the subtle bugs (a quota rejection that silently
// drops the *rest* of a multi-key save, a snapshot that outlives its data,
// caller mutation poisoning a cached object). This module is the single
// tested copy. Two tiers:
//
//   Tier 1 — safe localStorage wrappers + JSON-snapshot-with-TTL (no setup):
//     lsGet / lsSet / lsRemove            (FlightCheck src/tracking/state.js)
//     saveSnapshot / readSnapshot         (Weather js/lib/storage.js — {at, payload})
//     isQuotaError / safeSetItem          (market-monitor js/utils/cache.js)
//     writeTtlJson / readTtlJson /
//       readTtlJsonTimestamp              (market-monitor — {ts, data})
//
//   Tier 2 — an IndexedDB-backed store with an in-memory mirror (advanced,
//   opt-in):
//     createCacheStore / createPrefsStorage  (JFS-Sports cache-store.js —
//     the family's best-in-class implementation: structuredClone isolation,
//     soft TTLs, quota/private-mode degradation, legacy-localStorage
//     migration, and a localStorage-shaped facade)
//
// COMPATIBILITY SUPERSET (the netlify-kit rule): the sibling apps adopt this
// kit by changing IMPORT PATHS, not call sites. Every helper keeps its
// origin's exact name, signature, and on-disk format — including both
// snapshot shapes ({at, payload} vs {ts, data}) and both freshness
// comparisons (Weather's inclusive `<= maxAgeMs` vs market-monitor's
// exclusive `< maxAgeMs`), rather than collapsing them into one.
//
// This module imports NOTHING and touches no global at import time —
// `localStorage` / `indexedDB` / `structuredClone` are resolved at call time
// (or injected via `deps`), so node tests can stub them on globalThis and
// non-browser environments degrade to safe no-ops.

// ---------------------------------------------------------------------------
// Tier 1a — safe localStorage wrappers (origin: FlightCheck)
// ---------------------------------------------------------------------------

// localStorage can throw in private browsing, locked-down iframes, or when
// quota is exhausted. These wrap every access so a storage failure never
// breaks the calling flow — persistence is convenience, not correctness.

/** Read a key; null when missing, unavailable, or on any storage error. */
export function lsGet(key) {
    try {
        return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    } catch {
        return null;
    }
}

/** Best-effort write; silently a no-op when storage is unavailable/full. */
export function lsSet(key, value) {
    try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
    } catch { /* best-effort */ }
}

/** Best-effort remove; silently a no-op when storage is unavailable. */
export function lsRemove(key) {
    try {
        if (typeof localStorage !== 'undefined') localStorage.removeItem(key);
    } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Tier 1b — quota-aware writes (origin: market-monitor)
// ---------------------------------------------------------------------------

/**
 * Recognize a storage-quota rejection across browsers (Chrome/Safari name it
 * QuotaExceededError / code 22; Firefox uses NS_ERROR_DOM_QUOTA_REACHED /
 * 1014).
 */
export function isQuotaError(e) {
    return !!e && (
        e.name === 'QuotaExceededError' ||
        e.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
        e.code === 22 || e.code === 1014
    );
}

/**
 * Write one key with quota recovery. On a quota error, evict the *other*
 * caches in `ownedKeys` — a stale snapshot is worth less than the current
 * write landing — and retry once. Only a key that is itself a member of
 * `ownedKeys` may trigger the eviction: a small non-owned key must never
 * wipe the big caches to squeeze itself in — it just gives up quietly.
 * Callers set survival priority by write order (least- to most-valuable).
 * Returns true when the write landed.
 */
export function safeSetItem(key, value, { ownedKeys = [] } = {}) {
    if (typeof localStorage === 'undefined') return false;
    try {
        localStorage.setItem(key, value);
        return true;
    } catch (e) {
        if (!isQuotaError(e)) return false; // unavailable/private-mode — give up quietly
        if (!ownedKeys.includes(key)) return false;
        for (const k of ownedKeys) {
            if (k !== key) { try { localStorage.removeItem(k); } catch { /* ignore */ } }
        }
        try { localStorage.setItem(key, value); return true; }
        catch { return false; }
    }
}

// ---------------------------------------------------------------------------
// Tier 1c — JSON snapshots with TTL
// ---------------------------------------------------------------------------
//
// Prototype-pollution defense for parsed localStorage entries: JSON.parse
// materializes a `"__proto__"` (or `constructor`/`prototype`) JSON key as an
// OWN property, and callers Object.assign the parsed data onto app state —
// which invokes the real `__proto__` setter and would re-point the consumer's
// prototype chain. `depollute` strips those dangerous own keys from the
// freshly-parsed object so a poisoned entry can neither pollute this object
// nor carry the payload forward through a later Object.assign. The object
// keeps its ordinary prototype (callers and round-trip tests still see a plain
// object); shape validation still runs on the raw parse first.
const _POLLUTION_KEYS = ['__proto__', 'constructor', 'prototype'];
function depollute(parsed) {
    if (parsed == null || typeof parsed !== 'object') return parsed;
    for (const k of _POLLUTION_KEYS) {
        if (Object.prototype.hasOwnProperty.call(parsed, k)) delete parsed[k];
    }
    return parsed;
}

// Two on-disk shapes coexist in the family; both are kept byte-for-byte so
// existing users' stored data keeps parsing after adoption:
//
//   Weather shape        {at: <ms epoch>, payload: <any>}   fresh while
//                        `now - at <= maxAgeMs` (inclusive)
//   market-monitor shape {ts: <ms epoch>, data: <object>}   fresh while
//                        `now - ts <  maxAgeMs` (exclusive)

/**
 * Persist `{at: Date.now(), payload}` under `key` so views can fall back to
 * the last good data when the network is unavailable. Best-effort: private
 * browsing just means snapshots won't persist. (Weather shape.)
 */
export function saveSnapshot(key, payload) {
    try {
        localStorage.setItem(key, JSON.stringify({ at: Date.now(), payload }));
    } catch { /* private browsing — snapshots just won't persist */ }
}

/**
 * Read a snapshot written by `saveSnapshot`. Returns the whole
 * `{at, payload}` object while it is at most `maxAgeMs` old, else null
 * (missing, corrupt, or stale). (Weather shape.)
 */
export function readSnapshot(key, maxAgeMs) {
    try {
        const snap = JSON.parse(localStorage.getItem(key));
        if (snap && Date.now() - snap.at <= maxAgeMs) {
            depollute(snap.payload);
            return depollute(snap);
        }
    } catch { /* corrupt or missing */ }
    return null;
}

/**
 * Persist `{ts, data}` under `key` via `safeSetItem` (so a quota rejection
 * can evict sibling `ownedKeys` and retry). `ts` defaults to now; pass an
 * explicit shared timestamp when stamping several keys in one save pass.
 * Returns true when the write landed. (market-monitor shape.)
 */
export function writeTtlJson(key, data, { ts = Date.now(), ownedKeys = [] } = {}) {
    return safeSetItem(key, JSON.stringify({ ts, data }), { ownedKeys });
}

/**
 * Read an entry written by `writeTtlJson` and return its `data`, or null
 * when the entry is missing, corrupt, stale (age >= maxAgeMs), or its data
 * is not a plain object (arrays rejected). (market-monitor shape — the
 * object-only check matches its callers, which Object.assign the result
 * onto app state.)
 */
export function readTtlJson(key, maxAgeMs) {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        const obj = JSON.parse(raw);
        if (!obj || typeof obj !== 'object' || typeof obj.ts !== 'number') return null;
        if (Date.now() - obj.ts >= maxAgeMs) return null;
        if (obj.data == null || typeof obj.data !== 'object' || Array.isArray(obj.data)) return null;
        return depollute(obj.data);
    } catch { return null; }
}

/**
 * When an entry written by `writeTtlJson` was last saved (ms epoch), or null
 * if there is no usable entry. Unlike `readTtlJson` this does not validate
 * the data shape — it answers "how old is the snapshot?", e.g. for an
 * "as of …" label. (market-monitor shape.)
 */
export function readTtlJsonTimestamp(key, maxAgeMs) {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        const obj = depollute(JSON.parse(raw));
        if (!obj || typeof obj.ts !== 'number') return null;
        if (Date.now() - obj.ts >= maxAgeMs) return null;
        return obj.ts;
    } catch { return null; }
}

// ---------------------------------------------------------------------------
// Tier 2 — IndexedDB-backed store with in-memory mirror (origin: JFS-Sports)
// ---------------------------------------------------------------------------

/**
 * IndexedDB-backed key/value cache with a synchronous in-memory mirror.
 * Designed as a near drop-in for a `localStorage.getItem(...)` flow with
 * three changes:
 *
 *   * Values are stored as live JS objects, not JSON strings — IndexedDB's
 *     structured clone handles them natively, so callers no longer
 *     stringify/parse on every read or write.
 *   * `get`/`set`/`delete`/`keys` are synchronous against an in-memory
 *     mirror that's hydrated once at startup. The first paint can run
 *     against the mirror without awaiting IndexedDB on every read.
 *   * Persistence is best-effort and async; quota-exceeded errors are
 *     no longer expected at this scale (IndexedDB grants ~50%+ of disk).
 *
 * `set(key, value, options?)` accepts `{ ttlMs }` to set a soft expiry —
 * `get` returns null and prunes the entry once `Date.now()` passes the
 * stamped expiration. Entries written without a TTL never expire.
 * Pre-existing IDB rows (no wrapper) are returned as-is so an upgrade
 * from an unwrapped shape is non-disruptive.
 *
 * `init()` is idempotent and must be awaited before the first `get`.
 *
 * `deps` carries both environment injections (for tests / non-browser
 * runtimes) and per-app configuration:
 *   indexedDB, localStorage, structuredClone, now  — environment (default:
 *     the globals; pass null to force memory-only / skip migration)
 *   dbName ('jfs-cache'), dbVersion (1), storeName ('kv') — IDB identity
 *   legacyPrefixes ([]) — localStorage keys (exact or prefix match) migrated
 *     into the store on first init(), then removed from localStorage
 *   wrapMarker ('__jfsW') — marker property on the TTL wrapper objects; the
 *     default matches data already on disk in deployed apps, so only change
 *     it for a store with no history
 *   warnLabel ('[cache-kit]') — prefix for the once-per-session console
 *     warnings
 */
export function createCacheStore(deps = {}) {
    const idbFactory = deps.indexedDB !== undefined
        ? deps.indexedDB
        : (typeof indexedDB !== 'undefined' ? indexedDB : null);
    const ls = deps.localStorage !== undefined
        ? deps.localStorage
        : (typeof localStorage !== 'undefined' ? localStorage : null);
    const cloneFn = deps.structuredClone || (typeof structuredClone !== 'undefined' ? structuredClone : null);

    const DB_NAME = deps.dbName || 'jfs-cache';
    const DB_VERSION = deps.dbVersion || 1;
    const STORE = deps.storeName || 'kv';
    // Keys whose values used to live in localStorage and migrate into the
    // IDB cache on first run (then get removed so localStorage stops
    // counting them against its small quota). Matched exactly or by prefix.
    const LEGACY_PREFIXES = deps.legacyPrefixes || [];

    // Marker on every wrapper object the store writes. Disambiguates
    // wrapper objects from legacy unwrapped values (e.g. arrays, or
    // user objects that happen to have a `v` property).
    const WRAP_MARKER = deps.wrapMarker || '__jfsW';

    const WARN_LABEL = deps.warnLabel || '[cache-kit]';

    const now = deps.now || (() => Date.now());

    const mirror = new Map();
    let dbPromise = null;
    let initPromise = null;
    let ready = false;
    // Hoisted out so persist() / removeFromDb() can warn the developer
    // exactly once per session — useful when the DB has gone bad
    // (quota exceeded, private mode, schema mismatch) without flooding
    // the console on every subsequent write.
    let loggedWriteError = false;

    // structuredClone isolates stored values from later caller mutation.
    // Falls back to JSON round-trip on older runtimes (Safari < 15.4) so
    // the cache still behaves safely there.
    const isolate = (value) => {
        if (value == null) return value;
        if (cloneFn) {
            try { return cloneFn(value); } catch { /* fall through */ }
        }
        try { return JSON.parse(JSON.stringify(value)); } catch { return value; }
    };

    const isWrapped = (stored) =>
        !!stored && typeof stored === 'object' && !Array.isArray(stored) && stored[WRAP_MARKER] === 1;
    const unwrapValue = (stored) => isWrapped(stored) ? stored.v : stored;
    const isExpired = (stored) =>
        isWrapped(stored) && typeof stored.e === 'number' && now() >= stored.e;
    const wrap = (value, ttlMs) => {
        const wrapped = { [WRAP_MARKER]: 1, v: value };
        if (typeof ttlMs === 'number' && ttlMs > 0) wrapped.e = now() + ttlMs;
        return wrapped;
    };

    const openDb = () => {
        if (!idbFactory) return Promise.reject(new Error('IndexedDB unavailable'));
        if (dbPromise) return dbPromise;
        dbPromise = new Promise((resolve, reject) => {
            let req;
            try { req = idbFactory.open(DB_NAME, DB_VERSION); }
            catch (e) { reject(e); return; }
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
            req.onblocked = () => reject(new Error('IndexedDB open blocked'));
        });
        // If the open fails, allow a retry on the next call — otherwise
        // every later op gets the same rejection forever.
        dbPromise.catch(() => { dbPromise = null; });
        return dbPromise;
    };

    const hydrate = async () => {
        const db = await openDb();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readonly');
            const store = tx.objectStore(STORE);
            const req = store.openCursor();
            req.onsuccess = () => {
                const cur = req.result;
                if (cur) {
                    // A caller can race ahead and `set(k, v)` before
                    // hydrate finishes (the contract is "await init()"
                    // but nothing enforces it). If the mirror already
                    // has this key, the caller's write wins — we
                    // mustn't clobber it with the on-disk value.
                    if (typeof cur.key === 'string' && !mirror.has(cur.key)) {
                        mirror.set(cur.key, cur.value);
                    }
                    cur.continue();
                } else {
                    resolve();
                }
            };
            req.onerror = () => reject(req.error);
        });
    };

    // One-shot migration: copy any existing cache entries out of
    // localStorage and into IndexedDB on first run, then drop them so
    // localStorage stops counting against its small quota.
    const migrateLegacy = async () => {
        if (!ls || LEGACY_PREFIXES.length === 0) return;
        const legacyKeys = [];
        try {
            for (let i = 0; i < ls.length; i++) {
                const k = ls.key(i);
                if (!k) continue;
                if (LEGACY_PREFIXES.some(p => k === p || k.startsWith(p))) legacyKeys.push(k);
            }
        } catch { return; }
        for (const k of legacyKeys) {
            let raw;
            try { raw = ls.getItem(k); } catch { continue; }
            if (raw == null) continue;
            if (!mirror.has(k)) {
                try {
                    const parsed = depollute(JSON.parse(raw));
                    mirror.set(k, parsed);
                    persist(k, parsed).catch(() => {});
                } catch { /* skip unparseable legacy entry */ }
            }
            try { ls.removeItem(k); } catch { /* ignore */ }
        }
    };

    const warnWriteOnce = (action, e) => {
        if (loggedWriteError || typeof console === 'undefined') return;
        loggedWriteError = true;
        console.warn(`${WARN_LABEL} ${action} failed; further write errors suppressed`, e);
    };

    const persist = async (key, value) => {
        try {
            const db = await openDb();
            await new Promise((resolve, reject) => {
                const tx = db.transaction(STORE, 'readwrite');
                tx.objectStore(STORE).put(value, key);
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
                tx.onabort = () => reject(tx.error);
            });
        } catch (e) {
            // The mirror still has the value; the next session will simply
            // re-fetch from the network. No user-facing error, but log the
            // first failure so quota / private-mode issues are debuggable.
            warnWriteOnce('persist', e);
        }
    };

    const removeFromDb = async (key) => {
        try {
            const db = await openDb();
            await new Promise((resolve, reject) => {
                const tx = db.transaction(STORE, 'readwrite');
                tx.objectStore(STORE).delete(key);
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
                tx.onabort = () => reject(tx.error);
            });
        } catch (e) {
            warnWriteOnce('delete', e);
        }
    };

    const init = () => {
        if (initPromise) return initPromise;
        initPromise = (async () => {
            try { await hydrate(); }
            catch (e) {
                // Private browsing or a corrupted DB — fall back to
                // memory-only. The app still functions, just without
                // persistence between sessions.
                if (typeof console !== 'undefined') console.warn(`${WARN_LABEL} IndexedDB hydrate failed; memory-only mode`, e);
            }
            await migrateLegacy();
            ready = true;
        })();
        return initPromise;
    };

    const cacheGet = (key) => {
        if (!mirror.has(key)) return null;
        const stored = mirror.get(key);
        if (isExpired(stored)) {
            mirror.delete(key);
            removeFromDb(key);
            return null;
        }
        return isolate(unwrapValue(stored));
    };
    const cacheSet = (key, value, options) => {
        const ttlMs = options && typeof options.ttlMs === 'number' ? options.ttlMs : undefined;
        const wrapped = wrap(isolate(value), ttlMs);
        mirror.set(key, wrapped);
        persist(key, wrapped);
    };
    const cacheDelete = (key) => {
        mirror.delete(key);
        removeFromDb(key);
    };

    // localStorage-shaped facade so callers can keep their existing
    // `JSON.parse(storage.getItem(KEY))` / `storage.setItem(KEY,
    // JSON.stringify(value))` dance without changing call sites. The facade
    // JSON-serializes / parses on the wire while the store keeps live JS
    // objects internally — a bit of redundant work, but the trade-off avoids
    // touching every prefs call site for marginal cleanup.
    const localStorageFacade = {
        getItem(key) {
            const v = cacheGet(key);
            if (v === null || v === undefined) return null;
            try { return JSON.stringify(v); }
            catch { return null; }
        },
        setItem(key, value) {
            try {
                cacheSet(key, JSON.parse(value));
            } catch {
                // Non-JSON value (e.g. a bare string). Store as-is.
                cacheSet(key, value);
            }
        },
        removeItem(key) {
            cacheDelete(key);
        }
    };

    return {
        init,
        get isReady() { return ready; },
        get: cacheGet,
        set: cacheSet,
        delete: cacheDelete,
        localStorageFacade,
        keys() {
            return Array.from(mirror.keys());
        },
        // Test hook — flushes pending writes by waiting for the next IDB
        // transaction to settle. Not used by production code.
        _drain: async () => {
            try {
                const db = await openDb();
                await new Promise((resolve) => {
                    const tx = db.transaction(STORE, 'readonly');
                    tx.oncomplete = () => resolve();
                    tx.onerror = () => resolve();
                    tx.onabort = () => resolve();
                });
            } catch { /* ignore */ }
        }
    };
}

/**
 * Build the "preferred prefs storage" resolver for a CacheStore: a function
 * that hands callers the store's localStorage-shaped facade once `init()`
 * has completed, and falls back to raw localStorage (resolved at call time,
 * so test stubs on globalThis are honored) — or null when neither exists —
 * before that. Lets app modules share one fallback chain instead of each
 * keeping its own copy.
 *
 * `opts.localStorage` overrides the fallback backend (pass null to disable
 * the fallback entirely).
 */
export function createPrefsStorage(store, opts = {}) {
    return () => {
        if (store && store.isReady && store.localStorageFacade) {
            return store.localStorageFacade;
        }
        if (opts.localStorage !== undefined) return opts.localStorage;
        return typeof localStorage !== 'undefined' ? localStorage : null;
    };
}
