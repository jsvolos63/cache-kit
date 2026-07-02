// Tests for @jfs/cache-kit. Run with `node --test test.mjs` (or `npm test`).
//
// No DOM is needed here (unlike dom-kit, which shims jsdom): the kit's only
// environment touchpoints are `localStorage` / `indexedDB` /
// `structuredClone`, all resolved at call time or injectable via `deps`. So
// the suite hand-rolls the same in-memory fakes the origin app suites used —
// a Map-backed localStorage (with an optional item cap that throws
// QuotaExceededError like browsers do) and a microtask-driven IndexedDB stub
// — and installs the localStorage fake on globalThis before exercising the
// tier-1 helpers. The tier-2 cases are ported from JFS-Sports'
// tests/cache-store.test.js so the canonical behavior lives here, in the
// kit, from day one.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
    lsGet, lsSet, lsRemove,
    isQuotaError, safeSetItem,
    saveSnapshot, readSnapshot,
    writeTtlJson, readTtlJson, readTtlJsonTimestamp,
    createCacheStore, createPrefsStorage,
} from './index.js';

// --- fakes ------------------------------------------------------------------

// Map-backed localStorage. `maxItems` models a storage cap: setting a NEW key
// beyond the cap throws a QuotaExceededError (as browsers do), while
// removeItem frees room — enough to exercise the evict-and-retry path.
function makeFakeLocalStorage(initial = {}, { maxItems = Infinity } = {}) {
    const map = new Map(Object.entries(initial));
    return {
        get length() { return map.size; },
        key(i) { return Array.from(map.keys())[i] ?? null; },
        getItem(k) { return map.has(k) ? map.get(k) : null; },
        setItem(k, v) {
            if (!map.has(k) && map.size >= maxItems) {
                const e = new Error('quota exceeded');
                e.name = 'QuotaExceededError';
                e.code = 22;
                throw e;
            }
            map.set(k, String(v));
        },
        removeItem(k) { map.delete(k); },
        clear() { map.clear(); },
        _raw: map,
    };
}

// Minimal in-memory IDB stub — supports openCursor for hydration and
// put/delete for the read-modify path. Records the open() arguments so the
// dbName/dbVersion config can be asserted.
function makeFakeIdb(initial = {}) {
    const data = new Map(Object.entries(initial));
    const opened = [];
    const store = {
        openCursor() {
            const entries = Array.from(data.entries());
            const req = {};
            queueMicrotask(() => {
                let i = 0;
                const step = () => {
                    if (i >= entries.length) {
                        req.result = null;
                        req.onsuccess && req.onsuccess();
                        return;
                    }
                    const [key, value] = entries[i++];
                    req.result = { key, value, continue: step };
                    req.onsuccess && req.onsuccess();
                };
                step();
            });
            return req;
        },
        put(value, key) { data.set(key, value); return {}; },
        delete(key) { data.delete(key); return {}; }
    };
    const tx = () => {
        const t = { objectStore: () => store };
        queueMicrotask(() => { t.oncomplete && t.oncomplete(); });
        return t;
    };
    const db = {
        objectStoreNames: { contains: () => true },
        transaction: () => tx(),
        createObjectStore: () => store
    };
    return {
        open(name, version) {
            opened.push({ name, version });
            const req = {};
            queueMicrotask(() => {
                req.result = db;
                req.onsuccess && req.onsuccess();
            });
            return req;
        },
        _data: data,
        _opened: opened,
    };
}

// Swap console.warn for a recorder; returns { calls, restore }.
function spyWarn() {
    const original = console.warn;
    const calls = [];
    console.warn = (...args) => { calls.push(args); };
    return { calls, restore: () => { console.warn = original; } };
}

// Tier-1 helpers read the ambient `localStorage`; install/uninstall a fake
// around each block.
function installLocalStorage(fake) {
    globalThis.localStorage = fake;
    return fake;
}
function uninstallLocalStorage() {
    delete globalThis.localStorage;
}

// ---------------------------------------------------------------------------
// Tier 1a — lsGet / lsSet / lsRemove
// ---------------------------------------------------------------------------

describe('safe localStorage wrappers (FlightCheck)', () => {
    afterEach(uninstallLocalStorage);

    test('round-trip and remove', () => {
        installLocalStorage(makeFakeLocalStorage());
        lsSet('k', 'v');
        assert.equal(lsGet('k'), 'v');
        lsRemove('k');
        assert.equal(lsGet('k'), null);
    });

    test('missing key reads as null', () => {
        installLocalStorage(makeFakeLocalStorage());
        assert.equal(lsGet('nope'), null);
    });

    test('no localStorage at all: get → null, set/remove are silent no-ops', () => {
        uninstallLocalStorage();
        assert.equal(lsGet('k'), null);
        assert.doesNotThrow(() => lsSet('k', 'v'));
        assert.doesNotThrow(() => lsRemove('k'));
    });

    test('a throwing localStorage (private mode) never propagates', () => {
        installLocalStorage({
            getItem() { throw new Error('denied'); },
            setItem() { throw new Error('denied'); },
            removeItem() { throw new Error('denied'); },
        });
        assert.equal(lsGet('k'), null);
        assert.doesNotThrow(() => lsSet('k', 'v'));
        assert.doesNotThrow(() => lsRemove('k'));
    });
});

// ---------------------------------------------------------------------------
// Tier 1b — isQuotaError / safeSetItem
// ---------------------------------------------------------------------------

describe('isQuotaError (market-monitor)', () => {
    test('recognizes the four browser quota signals', () => {
        assert.equal(isQuotaError({ name: 'QuotaExceededError' }), true);
        assert.equal(isQuotaError({ name: 'NS_ERROR_DOM_QUOTA_REACHED' }), true);
        assert.equal(isQuotaError({ code: 22 }), true);
        assert.equal(isQuotaError({ code: 1014 }), true);
    });
    test('rejects other errors and non-errors', () => {
        assert.equal(isQuotaError(new Error('boom')), false);
        assert.equal(isQuotaError(null), false);
        assert.equal(isQuotaError(undefined), false);
    });
});

describe('safeSetItem (market-monitor _safeSet)', () => {
    afterEach(uninstallLocalStorage);

    test('plain write succeeds and returns true', () => {
        const ls = installLocalStorage(makeFakeLocalStorage());
        assert.equal(safeSetItem('a', '1'), true);
        assert.equal(ls.getItem('a'), '1');
    });

    test('non-quota failure gives up quietly (false)', () => {
        installLocalStorage({
            setItem() { throw new Error('SecurityError-ish'); },
            removeItem() {},
        });
        assert.equal(safeSetItem('a', '1'), false);
    });

    test('quota error on an owned key evicts the OTHER owned keys and retries', () => {
        const ls = installLocalStorage(makeFakeLocalStorage(
            { light: 'x', heavy: 'y' }, { maxItems: 2 }
        ));
        const owned = ['light', 'heavy', 'main'];
        assert.equal(safeSetItem('main', 'z', { ownedKeys: owned }), true);
        assert.equal(ls.getItem('main'), 'z');
        // Both siblings were evicted to make room.
        assert.equal(ls.getItem('light'), null);
        assert.equal(ls.getItem('heavy'), null);
    });

    test('quota error on a NON-owned key never evicts — returns false', () => {
        const ls = installLocalStorage(makeFakeLocalStorage(
            { big: 'x' }, { maxItems: 1 }
        ));
        assert.equal(safeSetItem('tiny', 'date', { ownedKeys: ['big'] }), false);
        assert.equal(ls.getItem('big'), 'x'); // untouched
    });

    test('no localStorage at all → false', () => {
        uninstallLocalStorage();
        assert.equal(safeSetItem('a', '1'), false);
    });
});

// ---------------------------------------------------------------------------
// Tier 1c — snapshots
// ---------------------------------------------------------------------------

describe('saveSnapshot / readSnapshot (Weather {at, payload})', () => {
    afterEach(uninstallLocalStorage);

    test('round-trips a fresh snapshot (whole {at, payload} object)', () => {
        installLocalStorage(makeFakeLocalStorage());
        saveSnapshot('k', { temp: 71 });
        const snap = readSnapshot('k', 60_000);
        assert.ok(snap);
        assert.deepEqual(snap.payload, { temp: 71 });
        assert.equal(typeof snap.at, 'number');
    });

    test('freshness is inclusive: age exactly maxAgeMs still reads', () => {
        const ls = installLocalStorage(makeFakeLocalStorage());
        ls.setItem('k', JSON.stringify({ at: Date.now() - 5000, payload: 1 }));
        assert.ok(readSnapshot('k', 5000));
    });

    test('stale snapshot reads as null', () => {
        const ls = installLocalStorage(makeFakeLocalStorage());
        ls.setItem('k', JSON.stringify({ at: Date.now() - 10_000, payload: 1 }));
        assert.equal(readSnapshot('k', 5000), null);
    });

    test('missing, corrupt, or at-less entries read as null', () => {
        const ls = installLocalStorage(makeFakeLocalStorage());
        assert.equal(readSnapshot('missing', 5000), null);
        ls.setItem('corrupt', '{not json');
        assert.equal(readSnapshot('corrupt', 5000), null);
        ls.setItem('no-at', JSON.stringify({ payload: 1 }));
        assert.equal(readSnapshot('no-at', 5000), null);
    });

    test('save into a throwing localStorage is a silent no-op', () => {
        installLocalStorage({ setItem() { throw new Error('quota'); } });
        assert.doesNotThrow(() => saveSnapshot('k', 1));
    });
});

describe('writeTtlJson / readTtlJson / readTtlJsonTimestamp (market-monitor {ts, data})', () => {
    afterEach(uninstallLocalStorage);

    test('round-trips a fresh entry and returns just the data', () => {
        installLocalStorage(makeFakeLocalStorage());
        assert.equal(writeTtlJson('k', { SPY: { price: 500 } }), true);
        assert.deepEqual(readTtlJson('k', 60_000), { SPY: { price: 500 } });
    });

    test('accepts an explicit shared ts for multi-key save passes', () => {
        const ls = installLocalStorage(makeFakeLocalStorage());
        writeTtlJson('a', { x: 1 }, { ts: 123 });
        writeTtlJson('b', { y: 2 }, { ts: 123 });
        assert.equal(JSON.parse(ls.getItem('a')).ts, 123);
        assert.equal(JSON.parse(ls.getItem('b')).ts, 123);
    });

    test('freshness is exclusive: age exactly maxAgeMs is stale', () => {
        const ls = installLocalStorage(makeFakeLocalStorage());
        ls.setItem('k', JSON.stringify({ ts: Date.now() - 5000, data: { a: 1 } }));
        assert.equal(readTtlJson('k', 5000), null);
        assert.deepEqual(readTtlJson('k', 5001), { a: 1 });
    });

    test('rejects entries whose data is missing, an array, or a primitive', () => {
        const ls = installLocalStorage(makeFakeLocalStorage());
        ls.setItem('none', JSON.stringify({ ts: Date.now() }));
        ls.setItem('arr', JSON.stringify({ ts: Date.now(), data: [1, 2] }));
        ls.setItem('prim', JSON.stringify({ ts: Date.now(), data: 5 }));
        assert.equal(readTtlJson('none', 60_000), null);
        assert.equal(readTtlJson('arr', 60_000), null);
        assert.equal(readTtlJson('prim', 60_000), null);
    });

    test('missing / corrupt / ts-less entries read as null', () => {
        const ls = installLocalStorage(makeFakeLocalStorage());
        assert.equal(readTtlJson('missing', 60_000), null);
        ls.setItem('corrupt', '{nope');
        assert.equal(readTtlJson('corrupt', 60_000), null);
        ls.setItem('no-ts', JSON.stringify({ data: { a: 1 } }));
        assert.equal(readTtlJson('no-ts', 60_000), null);
    });

    test('quota recovery flows through safeSetItem eviction', () => {
        const ls = installLocalStorage(makeFakeLocalStorage(
            { other: 'x' }, { maxItems: 1 }
        ));
        const owned = ['other', 'main'];
        assert.equal(writeTtlJson('main', { a: 1 }, { ownedKeys: owned }), true);
        assert.equal(ls.getItem('other'), null);
        assert.deepEqual(readTtlJson('main', 60_000), { a: 1 });
    });

    test('readTtlJsonTimestamp returns ts while fresh, without validating data shape', () => {
        const ls = installLocalStorage(makeFakeLocalStorage());
        const ts = Date.now() - 1000;
        ls.setItem('k', JSON.stringify({ ts, data: [1, 2, 3] })); // array data is fine here
        assert.equal(readTtlJsonTimestamp('k', 60_000), ts);
        ls.setItem('old', JSON.stringify({ ts: Date.now() - 10_000, data: {} }));
        assert.equal(readTtlJsonTimestamp('old', 5000), null);
        assert.equal(readTtlJsonTimestamp('missing', 5000), null);
    });
});

// ---------------------------------------------------------------------------
// Tier 2 — createCacheStore (ported from JFS-Sports tests/cache-store.test.js)
// ---------------------------------------------------------------------------

describe('CacheStore (memory-only mode)', () => {
    let store;
    beforeEach(async () => {
        // indexedDB: null forces memory-only — exercises the "private
        // browsing / IDB blocked" fallback path.
        store = createCacheStore({ indexedDB: null, localStorage: null });
        await store.init();
    });

    test('returns null for missing keys', () => {
        assert.equal(store.get('missing'), null);
    });

    test('round-trips a value via set/get', () => {
        store.set('a', { hello: 'world', n: 1 });
        assert.deepEqual(store.get('a'), { hello: 'world', n: 1 });
    });

    test('isolates the stored value so caller mutation cannot poison the cache', () => {
        const value = { events: [{ id: 1 }] };
        store.set('k', value);
        value.events.push({ id: 2 });
        value.events[0].id = 999;
        assert.deepEqual(store.get('k'), { events: [{ id: 1 }] });
    });

    test('isolates the returned value so reader mutation cannot poison the cache', () => {
        store.set('k', { events: [{ id: 1 }] });
        const got = store.get('k');
        got.events.push({ id: 99 });
        got.events[0].id = 555;
        assert.deepEqual(store.get('k'), { events: [{ id: 1 }] });
    });

    test('delete removes an entry', () => {
        store.set('k', 1);
        store.delete('k');
        assert.equal(store.get('k'), null);
    });

    test('keys lists current entries', () => {
        store.set('cache_2026-05-01', []);
        store.set('cache_2026-05-02', []);
        store.set('news', { events: [] });
        assert.deepEqual(store.keys().sort(), ['cache_2026-05-01', 'cache_2026-05-02', 'news']);
    });

    test('init is idempotent (returns the same promise across calls)', () => {
        assert.equal(store.init(), store.init());
    });
});

describe('CacheStore TTL', () => {
    let clock;
    let store;
    beforeEach(async () => {
        clock = { t: 1_000_000 };
        store = createCacheStore({
            indexedDB: null,
            localStorage: null,
            now: () => clock.t
        });
        await store.init();
    });

    test('returns the value while it is still fresh', () => {
        store.set('k', { hello: 'world' }, { ttlMs: 5000 });
        clock.t += 4999;
        assert.deepEqual(store.get('k'), { hello: 'world' });
    });

    test('returns null and prunes the entry once the TTL passes', () => {
        store.set('k', { hello: 'world' }, { ttlMs: 5000 });
        clock.t += 5001;
        assert.equal(store.get('k'), null);
        // Entry should also be removed from keys() after a get.
        assert.ok(!store.keys().includes('k'));
    });

    test('treats no-options sets as never expiring', () => {
        store.set('k', { hello: 'world' });
        clock.t += 365 * 24 * 60 * 60 * 1000; // a year
        assert.deepEqual(store.get('k'), { hello: 'world' });
    });

    test('ignores non-positive TTLs (treats them as no expiry)', () => {
        store.set('a', 1, { ttlMs: 0 });
        store.set('b', 2, { ttlMs: -100 });
        clock.t += 60_000;
        assert.equal(store.get('a'), 1);
        assert.equal(store.get('b'), 2);
    });

    test('still returns legacy unwrapped values that pre-date the TTL wrapper', async () => {
        // Simulate a row written by an old code path: a raw value in IDB,
        // hydrated into the mirror without a wrapper.
        const idb = makeFakeIdb({
            'news_cache': { endpoint: { name: 'Top Stories' }, events: [{ id: 'a' }] }
        });
        const legacyStore = createCacheStore({ indexedDB: idb, localStorage: null });
        await legacyStore.init();
        assert.deepEqual(legacyStore.get('news_cache'), {
            endpoint: { name: 'Top Stories' },
            events: [{ id: 'a' }]
        });
    });

    test('isolates the wrapped value so caller mutation cannot poison expiry checks', () => {
        const value = { events: [1, 2, 3] };
        store.set('k', value, { ttlMs: 5000 });
        value.events.push(99);
        assert.deepEqual(store.get('k'), { events: [1, 2, 3] });
    });
});

describe('CacheStore legacy migration', () => {
    const PREFIXES = ['app_cache_', 'app_news_cache', 'appFavorites'];

    test('copies matching localStorage entries into the mirror and removes them from localStorage', async () => {
        const ls = makeFakeLocalStorage({
            'app_cache_2026-04-30': JSON.stringify([{ events: [{ id: 'a' }] }]),
            'app_news_cache': JSON.stringify({ events: [{ id: 'n' }] }),
            'appFavorites': '[{"name":"Bulls"}]',
            // Unrelated key — must be left alone
            'FAVORITES': '[]'
        });
        const store = createCacheStore({ indexedDB: null, localStorage: ls, legacyPrefixes: PREFIXES });
        await store.init();

        assert.deepEqual(store.get('app_cache_2026-04-30'), [{ events: [{ id: 'a' }] }]);
        assert.deepEqual(store.get('app_news_cache'), { events: [{ id: 'n' }] });
        assert.deepEqual(store.get('appFavorites'), [{ name: 'Bulls' }]);
        // Legacy keys removed from localStorage
        assert.equal(ls.getItem('app_cache_2026-04-30'), null);
        assert.equal(ls.getItem('app_news_cache'), null);
        assert.equal(ls.getItem('appFavorites'), null);
        // Unrelated key preserved
        assert.equal(ls.getItem('FAVORITES'), '[]');
    });

    test('no legacyPrefixes (the default) → migration is a no-op', async () => {
        const ls = makeFakeLocalStorage({ 'app_cache_x': '[1]' });
        const store = createCacheStore({ indexedDB: null, localStorage: ls });
        await store.init();
        assert.equal(store.get('app_cache_x'), null);
        assert.equal(ls.getItem('app_cache_x'), '[1]'); // untouched
    });

    test('exposes a localStorageFacade that round-trips JSON values through the cache', async () => {
        const store = createCacheStore({ indexedDB: null, localStorage: makeFakeLocalStorage() });
        await store.init();
        const facade = store.localStorageFacade;
        assert.ok(facade);

        // setItem / getItem round-trip a JSON value through the store.
        facade.setItem('hidden', JSON.stringify({ NBA: true }));
        assert.deepEqual(JSON.parse(facade.getItem('hidden')), { NBA: true });
        // The underlying store keeps the parsed object, not the string.
        assert.deepEqual(store.get('hidden'), { NBA: true });

        // removeItem clears it from both views.
        facade.removeItem('hidden');
        assert.equal(facade.getItem('hidden'), null);
        assert.equal(store.get('hidden'), null);

        // getItem returns null for unknown keys (matches localStorage).
        assert.equal(facade.getItem('not-a-key'), null);

        // setItem of a non-JSON string stores it as-is, getItem returns it
        // as a JSON-stringified string (so callers that JSON.parse always
        // get a defined value).
        facade.setItem('tz', 'America/Chicago');
        assert.equal(JSON.parse(facade.getItem('tz')), 'America/Chicago');
    });

    test('skips unparseable legacy entries without throwing', async () => {
        const ls = makeFakeLocalStorage({
            'app_cache_2026-04-30': '{not json',
            'app_news_cache': JSON.stringify({ events: [] })
        });
        const store = createCacheStore({ indexedDB: null, localStorage: ls, legacyPrefixes: PREFIXES });
        await store.init();
        // Bad entry: no value migrated, but key cleared from localStorage
        assert.equal(store.get('app_cache_2026-04-30'), null);
        assert.equal(ls.getItem('app_cache_2026-04-30'), null);
        // Good entry still migrated
        assert.deepEqual(store.get('app_news_cache'), { events: [] });
    });

    test('survives a thrown localStorage on access', async () => {
        const ls = {
            get length() { throw new Error('private mode'); },
            key() { return null; },
            getItem() { return null; },
            setItem() {},
            removeItem() {}
        };
        const store = createCacheStore({ indexedDB: null, localStorage: ls, legacyPrefixes: PREFIXES });
        await store.init();
        assert.equal(store.isReady, true);
    });
});

describe('CacheStore IndexedDB behavior', () => {
    test('init resolves and falls back to memory-only when IDB throws on open', async () => {
        const warn = spyWarn();
        try {
            const idb = { open() { throw new Error('blocked'); } };
            const store = createCacheStore({ indexedDB: idb, localStorage: null });
            await store.init();
            assert.equal(store.isReady, true);
            store.set('k', 1);
            assert.equal(store.get('k'), 1);
        } finally { warn.restore(); }
    });

    test('a caller set() before hydrate completes wins over the stored value', async () => {
        // Contract: callers should await init(), but if they don't, their
        // write must not be silently clobbered by the hydrated on-disk value
        // once the cursor catches up.
        const idb = makeFakeIdb({ k: { __jfsW: 1, v: 'STORED' } });
        const store = createCacheStore({ indexedDB: idb, localStorage: null });
        const initP = store.init();
        // Run synchronously while hydrate is mid-microtask
        store.set('k', 'CALLER');
        await initP;
        assert.equal(store.get('k'), 'CALLER');
    });

    test('persisted writes land in IndexedDB with the wrap marker', async () => {
        const idb = makeFakeIdb();
        const store = createCacheStore({ indexedDB: idb, localStorage: null });
        await store.init();
        store.set('k', { a: 1 });
        await store._drain();
        const stored = idb._data.get('k');
        assert.equal(stored.__jfsW, 1);
        assert.deepEqual(stored.v, { a: 1 });
    });

    test('opens the configured dbName / dbVersion (defaults preserved for deployed data)', async () => {
        const idb = makeFakeIdb();
        const store = createCacheStore({ indexedDB: idb, localStorage: null });
        await store.init();
        assert.deepEqual(idb._opened[0], { name: 'jfs-cache', version: 1 });

        const idb2 = makeFakeIdb();
        const store2 = createCacheStore({ indexedDB: idb2, localStorage: null, dbName: 'my-app', dbVersion: 3 });
        await store2.init();
        assert.deepEqual(idb2._opened[0], { name: 'my-app', version: 3 });
    });

    test('a custom wrapMarker stamps the wrapper objects', async () => {
        const idb = makeFakeIdb();
        const store = createCacheStore({ indexedDB: idb, localStorage: null, wrapMarker: '__w' });
        await store.init();
        store.set('k', 'v');
        await store._drain();
        assert.equal(idb._data.get('k').__w, 1);
        assert.equal(store.get('k'), 'v');
    });

    test('warns once when persistence fails and suppresses further warnings', async () => {
        const warn = spyWarn();
        try {
            // Build an IDB whose readwrite tx always errors. Reads still
            // succeed so init() resolves cleanly; only writes blow up.
            const failingIdb = {
                open() {
                    const req = {};
                    queueMicrotask(() => {
                        const db = {
                            objectStoreNames: { contains: () => true },
                            transaction: (_store, mode) => {
                                const tx = { objectStore: () => ({
                                    openCursor: () => {
                                        const r = {};
                                        queueMicrotask(() => { r.result = null; r.onsuccess && r.onsuccess(); });
                                        return r;
                                    },
                                    put: () => ({}),
                                    delete: () => ({})
                                }) };
                                queueMicrotask(() => {
                                    if (mode === 'readwrite') {
                                        tx.error = new Error('quota');
                                        tx.onerror && tx.onerror();
                                    } else {
                                        tx.oncomplete && tx.oncomplete();
                                    }
                                });
                                return tx;
                            },
                            createObjectStore: () => ({})
                        };
                        req.result = db;
                        req.onsuccess && req.onsuccess();
                    });
                    return req;
                }
            };
            const store = createCacheStore({ indexedDB: failingIdb, localStorage: null, warnLabel: '[test cache]' });
            await store.init();
            store.set('a', 1);
            store.set('b', 2);
            store.delete('a');
            await store._drain();
            // Multiple write failures, but only the first surfaces a warn.
            assert.equal(warn.calls.length, 1);
            assert.match(warn.calls[0][0], /persist failed|delete failed/);
            assert.match(warn.calls[0][0], /^\[test cache\]/);
        } finally { warn.restore(); }
    });

    test('logs a warning but still initializes when hydrate fails', async () => {
        const warn = spyWarn();
        try {
            const idb = {
                open() {
                    const req = {};
                    queueMicrotask(() => {
                        req.error = new Error('boom');
                        req.onerror && req.onerror();
                    });
                    return req;
                }
            };
            const store = createCacheStore({ indexedDB: idb, localStorage: null });
            await store.init();
            assert.equal(store.isReady, true);
            assert.ok(warn.calls.length >= 1);
        } finally { warn.restore(); }
    });
});

describe('createPrefsStorage', () => {
    afterEach(uninstallLocalStorage);

    test('hands out the facade once the store is ready', async () => {
        const store = createCacheStore({ indexedDB: null, localStorage: null });
        const prefs = createPrefsStorage(store);
        installLocalStorage(makeFakeLocalStorage());
        // Before init: raw localStorage fallback (call-time resolution, so
        // test stubs on globalThis are honored).
        assert.equal(prefs(), globalThis.localStorage);
        await store.init();
        assert.equal(prefs(), store.localStorageFacade);
    });

    test('falls back to an injected backend, or null when nothing exists', () => {
        const store = createCacheStore({ indexedDB: null, localStorage: null });
        const fake = makeFakeLocalStorage();
        assert.equal(createPrefsStorage(store, { localStorage: fake })(), fake);
        assert.equal(createPrefsStorage(store, { localStorage: null })(), null);
        uninstallLocalStorage();
        assert.equal(createPrefsStorage(store)(), null);
    });
});
