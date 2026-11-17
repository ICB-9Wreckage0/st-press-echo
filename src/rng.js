// rng.js — 可复现的随机数。同一存档、同一事件键，永远掷出同一个结果，
// 所以在酒馆里重新生成（swipe）回复，不会让“谁写了书评”跟着变。

export function hashString(str) {
    // FNV-1a 32 位
    let h = 0x811c9dc5;
    const s = String(str);
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

export function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** 对某个键取一个 [0,1) 的确定性随机数 */
export function roll(seed, key) {
    return mulberry32(hashString(`${seed}|${key}`))();
}
