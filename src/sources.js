// sources.js — 作品原文存在浏览器本地数据库（IndexedDB），不塞进聊天存档。
// 存档里只留 sourceLen（字数）。浏览器不支持 IndexedDB 时照旧存在存档里。

const DB = 'press-echo', STORE = 'sources';
const cache = new Map(); // `${storeId}:${workId}` → 原文
const loaded = new Set(); // 已读入的 storeId
let dbp = null;

const hasIDB = () => typeof indexedDB !== 'undefined' && indexedDB?.open;
function db() {
    if (!hasIDB()) return Promise.reject(new Error('no indexedDB'));
    if (!dbp) dbp = new Promise((res, rej) => {
        const r = indexedDB.open(DB, 1);
        r.onupgradeneeded = () => r.result.createObjectStore(STORE);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
    });
    return dbp;
}
const tx = (mode, fn) => db().then(d => new Promise((res, rej) => {
    const t = d.transaction(STORE, mode); const s = t.objectStore(STORE);
    const out = fn(s);
    t.oncomplete = () => res(out?.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
}));

export function ensureStoreId(st) {
    if (!st.storeId) st.storeId = 's' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    return st.storeId;
}
const key = (st, w) => `${ensureStoreId(st)}:${w.id}`;
export const sourcesReady = st => { if (!hasIDB()) return true; const c = chatIdNow(); return loaded.has(st?.storeId) && (!c || st?.storeChat === c); };

/** 取原文（同步）：缓存 → 存档里残留的 → 空 */
export function srcOf(st, w) {
    if (!w) return '';
    const k = st ? key(st, w) : null;
    // 还没存下去的（刚从编辑框、txt 读进来的）优先
    if (typeof w.sourceText === 'string' && (w.sourceText || !(k && cache.has(k)))) return w.sourceText;
    return k && cache.has(k) ? cache.get(k) : '';
}
export const srcLen = (st, w) => (typeof w?.sourceText === 'string' ? w.sourceText.length : w?.sourceLen || 0);

/** 读入这个聊天的所有原文（切换聊天后调用一次） */
const chatIdNow = () => { try { const c = globalThis.SillyTavern?.getContext?.(); return String(c?.getCurrentChatId?.() || c?.chatId || ''); } catch { return ''; } };
const readPrefix = id => tx('readonly', s => {
    const r = s.openCursor(IDBKeyRange.bound(id + ':', id + ':\uffff'));
    r.onsuccess = () => { const c = r.result; if (c) { cache.set(c.key, c.value); c.continue(); } };
    return r;
});

export async function loadSources(st) {
    if (!st || !hasIDB()) return false;
    // 聊天分支、复制出来的聊天会带着同一个 storeId：发现换了聊天，就把原文复制一份到新编号下，各改各的
    const chat = chatIdNow();
    if (st.storeId && chat && st.storeChat && st.storeChat !== chat) {
        const old = st.storeId;
        try {
            await readPrefix(old);
            st.storeId = 's' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
            const pairs = [...cache.entries()].filter(([k]) => k.startsWith(old + ':')).map(([k, v]) => [st.storeId + k.slice(old.length), v]);
            for (const [k, v] of pairs) cache.set(k, v);
            if (pairs.length) await tx('readwrite', s => { for (const [k, v] of pairs) s.put(v, k); });
        } catch (e) { console.warn('[报刊回声] 复制原文到分支失败', e); }
    }
    if (chat) st.storeChat = chat;
    const id = ensureStoreId(st);
    if (loaded.has(id)) return false;
    try {
        await tx('readonly', s => {
            const r = s.openCursor(IDBKeyRange.bound(id + ':', id + ':￿'));
            r.onsuccess = () => { const c = r.result; if (c) { cache.set(c.key, c.value); c.continue(); } };
            return r;
        });
        loaded.add(id);
        return true;
    } catch (e) { console.warn('[报刊回声] 读取原文失败', e); loaded.add(id); return false; }
}

/**
 * 保存存档前调用：把作品里的 sourceText 挪进本地数据库，存档里只留字数。
 * 原文还没读入时，编辑框里的空原文不当作“清空”。
 */
export function stripSources(st, onFail) {
    if (!st || !hasIDB()) return;
    const id = ensureStoreId(st);
    for (const w of st.works || []) {
        if (typeof w.sourceText !== 'string') continue;
        const text = w.sourceText;
        const k = key(st, w);
        if (!text && !loaded.has(id) && w.sourceLen) { delete w.sourceText; continue; }
        delete w.sourceText;
        w.sourceLen = text.length;
        if (cache.get(k) === text) continue;
        cache.set(k, text);
        tx('readwrite', s => (text ? s.put(text, k) : s.delete(k))).catch(e => {
            console.warn('[报刊回声] 原文写入本地数据库失败，改存在存档里', e);
            w.sourceText = text; onFail?.(e);
        });
    }
}

/** 导出存档时把原文放回去（不改动当前状态） */
export function withSources(st) {
    const copy = JSON.parse(JSON.stringify(st));
    for (const w of copy.works || []) { const t = srcOf(st, w); if (t) w.sourceText = t; }
    return copy;
}
