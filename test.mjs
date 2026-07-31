// Tests for @jfs/cache-kit. Run with `node --test test.mjs` (or `npm test`).
//
// No DOM is needed here: the kit's only environment touchpoint is
// `localStorage`, resolved at call time. So the suite hand-rolls the same
// in-memory fake the origin app suites used — a Map-backed localStorage with
// an optional item cap that throws QuotaExceededError like browsers do — and
// installs it on globalThis before exercising the helpers.
//
// The IndexedDB store's cases left with the implementation in v0.3.0; they
// live in JFS-Sports' tests/cache-store-idb.test.js now.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
    lsGet, lsSet, lsRemove,
    isQuotaError, safeSetItem,
    saveSnapshot, readSnapshot,
    writeTtlJson, readTtlJson, readTtlJsonTimestamp,
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

// The helpers read the ambient `localStorage`; install/uninstall a fake
// around each block.
function installLocalStorage(fake) {
    globalThis.localStorage = fake;
    return fake;
}
function uninstallLocalStorage() {
    delete globalThis.localStorage;
}

// ---------------------------------------------------------------------------
// lsGet / lsSet / lsRemove
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
// isQuotaError / safeSetItem
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
// snapshots
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

    test('a poisoned __proto__ entry does not pollute the returned object prototype', () => {
        const ls = installLocalStorage(makeFakeLocalStorage());
        // Raw JSON so "__proto__" lands as an OWN key (an object literal would
        // set the prototype instead). This is the market-monitor Object.assign
        // threat: readTtlJson's result is assigned onto app state.
        ls.setItem('poison', `{"ts":${Date.now()},"data":{"__proto__":{"polluted":1}}}`);
        const data = readTtlJson('poison', 60_000);
        assert.notEqual(data, null);
        // Global Object.prototype must be untouched...
        assert.equal({}.polluted, undefined);
        // ...and the returned object must not inherit the poisoned proto.
        assert.equal(data.polluted, undefined);
        assert.equal(Object.getPrototypeOf(data), Object.prototype);
        // The dangerous own key must be stripped, so it can't propagate.
        assert.equal(Object.prototype.hasOwnProperty.call(data, '__proto__'), false);
        // Simulating the consumer's Object.assign onto app state must stay clean.
        const state = {};
        Object.assign(state, data);
        assert.equal(state.polluted, undefined);
        assert.equal({}.polluted, undefined);
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
// Prototype-pollution defense — the strip must be TOTAL
// ---------------------------------------------------------------------------
//
// Regression cover for the defect where only the TOP-LEVEL object was
// cleaned: a dangerous key one (or ten) levels down survived, and a consumer
// that deep-merged the result polluted Object.prototype globally. Every case
// below finishes by deep-merging the returned value into a fresh object and
// asserting `({}).polluted === undefined`.

// A naive recursive merge — exactly the consumer shape the guard protects.
// It walks into plain objects, so an own `__proto__` key that survived
// ingestion would be assigned through the real setter and poison the target's
// prototype chain (i.e. Object.prototype).
function deepMerge(target, source) {
    for (const k of Object.keys(source)) {
        const v = source[k];
        if (v && typeof v === 'object' && !Array.isArray(v)) {
            if (!target[k] || typeof target[k] !== 'object') target[k] = {};
            deepMerge(target[k], v);
        } else {
            target[k] = v;
        }
    }
    return target;
}

// Any own dangerous key anywhere in the tree fails the check.
function assertNoDangerousKeys(node, path = '$', seen = new WeakSet()) {
    if (node === null || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    for (const k of ['__proto__', 'constructor', 'prototype']) {
        assert.equal(Object.prototype.hasOwnProperty.call(node, k), false,
            `own "${k}" survived at ${path}`);
    }
    for (const [k, v] of Object.entries(node)) assertNoDangerousKeys(v, `${path}.${k}`, seen);
}

describe('prototype-pollution defense strips at every nesting level', () => {
    afterEach(() => {
        uninstallLocalStorage();
        // Fail loudly (and stop the poison leaking into later tests) if any
        // case actually polluted the global prototype.
        assert.equal({}.polluted, undefined);
        assert.equal({}.isAdmin, undefined);
    });

    test('readTtlJson strips a NESTED __proto__ (the reported defect)', () => {
        const ls = installLocalStorage(makeFakeLocalStorage());
        ls.setItem('poison', `{"ts":${Date.now()},"data":{"a":{"__proto__":{"isAdmin":true}}}}`);
        const data = readTtlJson('poison', 60_000);
        assert.notEqual(data, null);
        assert.equal(Object.prototype.hasOwnProperty.call(data.a, '__proto__'), false);
        assertNoDangerousKeys(data);
        deepMerge({}, data);
        assert.equal({}.isAdmin, undefined);
        assert.equal({}.polluted, undefined);
    });

    test('readTtlJson strips a __proto__ inside an ARRAY element', () => {
        const ls = installLocalStorage(makeFakeLocalStorage());
        ls.setItem('poison',
            `{"ts":${Date.now()},"data":{"rows":[{"ok":1},{"__proto__":{"polluted":1}}]}}`);
        const data = readTtlJson('poison', 60_000);
        assert.equal(data.rows.length, 2);
        assert.equal(data.rows[0].ok, 1);
        assert.equal(Object.prototype.hasOwnProperty.call(data.rows[1], '__proto__'), false);
        assertNoDangerousKeys(data);
        deepMerge({}, data.rows[1]);
        assert.equal({}.polluted, undefined);
    });

    test('readTtlJson strips at DEEP nesting (5 levels down)', () => {
        const ls = installLocalStorage(makeFakeLocalStorage());
        ls.setItem('poison',
            `{"ts":${Date.now()},"data":{"a":{"b":{"c":{"d":{"e":{"__proto__":{"polluted":1}}}}}}}}`);
        const data = readTtlJson('poison', 60_000);
        const deep = data.a.b.c.d.e;
        assert.equal(Object.prototype.hasOwnProperty.call(deep, '__proto__'), false);
        assertNoDangerousKeys(data);
        deepMerge({}, data);
        assert.equal({}.polluted, undefined);
    });

    test('readTtlJson strips nested "constructor" and "prototype" too', () => {
        const ls = installLocalStorage(makeFakeLocalStorage());
        ls.setItem('poison', `{"ts":${Date.now()},"data":{"a":{"constructor":{"prototype":{"polluted":1}}},` +
            `"b":{"prototype":{"polluted":1}},"list":[{"constructor":{"polluted":1}}]}}`);
        const data = readTtlJson('poison', 60_000);
        assert.deepEqual(data.a, {});
        assert.deepEqual(data.b, {});
        assert.deepEqual(data.list, [{}]);
        assertNoDangerousKeys(data);
        deepMerge({}, data);
        assert.equal({}.polluted, undefined);
    });

    test('readSnapshot strips a nested __proto__ inside the payload', () => {
        const ls = installLocalStorage(makeFakeLocalStorage());
        ls.setItem('snap', `{"at":${Date.now()},"payload":{"deep":{"x":[{"__proto__":{"polluted":1}}]}}}`);
        const snap = readSnapshot('snap', 60_000);
        assert.notEqual(snap, null);
        assertNoDangerousKeys(snap);
        assert.equal(snap.payload.deep.x.length, 1);
        deepMerge({}, snap.payload);
        assert.equal({}.polluted, undefined);
    });

    test('CONTROL: ordinary nested data (objects, arrays, primitives) survives untouched', () => {
        const ls = installLocalStorage(makeFakeLocalStorage());
        const payload = {
            a: 1, s: 'text', t: true, n: null,
            nested: { deep: { deeper: [1, 'two', { three: 3 }] } },
            list: [[1, 2], { k: 'v' }],
            protoLike: 'the string "__proto__" as a VALUE is fine'
        };
        assert.equal(writeTtlJson('ok', payload), true);
        const data = readTtlJson('ok', 60_000);
        assert.deepEqual(data, payload, 'well-formed data deserializes exactly as before');
        assert.equal(Object.getPrototypeOf(data), Object.prototype);
        assert.equal(Object.getPrototypeOf(data.nested.deep), Object.prototype);
        assert.ok(Array.isArray(data.nested.deep.deeper));
        deepMerge({}, data);
        assert.equal({}.polluted, undefined);
    });
});
