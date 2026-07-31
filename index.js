// @jfs/cache-kit — shared, dependency-free client-side storage / cache
// primitives for the JFS family of buildless static sites.
//
// Three sibling apps grew three different wrappers around the same two browser
// facts — localStorage throws (private browsing, quota, locked-down iframes)
// and cached data goes stale — each copy slightly different, and the
// differences are exactly the subtle bugs (a quota rejection that silently
// drops the *rest* of a multi-key save, a snapshot that outlives its data,
// caller mutation poisoning a cached object). This module is the single
// tested copy of those localStorage primitives:
//
//     lsGet / lsSet / lsRemove            (FlightCheck src/tracking/state.js)
//     saveSnapshot / readSnapshot         (Weather js/lib/storage.js — {at, payload})
//     isQuotaError / safeSetItem          (market-monitor js/utils/cache.js)
//     writeTtlJson / readTtlJson /
//       readTtlJsonTimestamp              (market-monitor — {ts, data})
//
// SCOPE (v0.3.0): the kit used to carry a second tier — `createCacheStore` /
// `createPrefsStorage`, an IndexedDB-backed store with an in-memory mirror.
// It had exactly ONE consumer, JFS-Sports, while being half the kit's lines,
// so it went back to that app as ordinary source (`cache-store-idb.js`). The
// family's extraction bar wants a THIRD consumer before shared code earns a
// kit's permanent CI / pin / vendoring overhead; a one-consumer tier never
// cleared it. Should a second and third app need an IDB store, take that
// file back — don't rebuild it from scratch here.
//
// COMPATIBILITY SUPERSET (the netlify-kit rule): the sibling apps adopt this
// kit by changing IMPORT PATHS, not call sites. Every helper keeps its
// origin's exact name, signature, and on-disk format — including both
// snapshot shapes ({at, payload} vs {ts, data}) and both freshness
// comparisons (Weather's inclusive `<= maxAgeMs` vs market-monitor's
// exclusive `< maxAgeMs`), rather than collapsing them into one.
//
// This module imports NOTHING and touches no global at import time —
// `localStorage` is resolved at call time, so node tests can stub it on
// globalThis and non-browser environments degrade to safe no-ops.

// ---------------------------------------------------------------------------
// Safe localStorage wrappers (origin: FlightCheck)
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
// Quota-aware writes (origin: market-monitor)
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
// JSON snapshots with TTL
// ---------------------------------------------------------------------------
//
// Prototype-pollution defense for parsed localStorage entries: JSON.parse
// materializes a `"__proto__"` (or `constructor`/`prototype`) JSON key as an
// OWN property, and callers Object.assign / deep-merge the parsed data onto
// app state — which invokes the real `__proto__` setter and would re-point the
// consumer's prototype chain (or `Object.prototype` itself, for a deep merge).
//
// The strip must be TOTAL: an earlier version only cleaned the top-level
// object, so `{"a":{"__proto__":{"isAdmin":true}}}` walked straight through
// the guard one key deeper and polluted any consumer that deep-merged the
// result. Ingestion therefore parses through `parseSafeJson`, whose reviver
// drops the three dangerous keys at EVERY level (including inside arrays) —
// one chokepoint that cannot miss a nesting depth. Well-formed values are
// otherwise untouched: same shape, same values, ordinary prototypes, so
// callers and round-trip tests still see plain objects. Shape validation still
// runs on the parse result.
const _POLLUTION_KEYS = ['__proto__', 'constructor', 'prototype'];
const _isPollutionKey = (k) => k === '__proto__' || k === 'constructor' || k === 'prototype';

// JSON.parse reviver: returning undefined deletes the key from its holder, so
// a dangerous key is removed at whatever depth it appears (array elements
// included — their own keys are visited too). Applied bottom-up by the spec,
// so nothing can be re-introduced after the fact.
function _pollutionReviver(key, value) {
    return _isPollutionKey(key) ? undefined : value;
}

/** JSON.parse with every `__proto__`/`constructor`/`prototype` key stripped at
 * every level. Throws on malformed JSON exactly like JSON.parse. */
function parseSafeJson(raw) {
    return JSON.parse(raw, _pollutionReviver);
}

// Belt-and-braces for values that did NOT come through parseSafeJson: walks
// own enumerable values (objects AND array elements) and deletes the dangerous
// own keys at every level. Iterative with a WeakSet seen-guard (cyclic input is
// visited once) and a depth cap, so a hostile shape can't hang or blow the
// stack. Mutates in place and returns the same reference.
const _MAX_DEPOLLUTE_DEPTH = 64;
function depollute(parsed) {
    if (parsed == null || typeof parsed !== 'object') return parsed;
    const seen = new WeakSet();
    const stack = [[parsed, 0]];
    while (stack.length) {
        const [node, depth] = stack.pop();
        if (node == null || typeof node !== 'object' || seen.has(node)) continue;
        seen.add(node);
        if (!Array.isArray(node)) {
            for (const k of _POLLUTION_KEYS) {
                if (Object.prototype.hasOwnProperty.call(node, k)) delete node[k];
            }
        }
        if (depth >= _MAX_DEPOLLUTE_DEPTH) continue;
        for (const v of Object.values(node)) {
            if (v !== null && typeof v === 'object') stack.push([v, depth + 1]);
        }
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
        const snap = parseSafeJson(localStorage.getItem(key));
        if (snap && Date.now() - snap.at <= maxAgeMs) {
            // parseSafeJson already stripped every level; depollute is the
            // second layer in case a future call site hands over a value that
            // did not come through the reviver.
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
        const obj = parseSafeJson(raw);
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
        const obj = depollute(parseSafeJson(raw));
        if (!obj || typeof obj.ts !== 'number') return null;
        if (Date.now() - obj.ts >= maxAgeMs) return null;
        return obj.ts;
    } catch { return null; }
}
