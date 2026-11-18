// undo.js — 批量操作前留一个还原点，可以撤销最近几步。只放在内存里（刷新页面就清空）。

const MAX = 6;
const stacks = new Map(); // storeId → [{ label, at, json }]

const sid = st => st?.storeId || '_';
export function pushUndo(st, label) {
    if (!st) return;
    const list = stacks.get(sid(st)) || [];
    try { list.push({ label, at: Date.now(), json: JSON.stringify(st) }); } catch { return; }
    while (list.length > MAX) list.shift();
    stacks.set(sid(st), list);
}
export const lastUndo = st => { const l = stacks.get(sid(st)); return l?.length ? l[l.length - 1] : null; };
export const undoCount = st => stacks.get(sid(st))?.length || 0;
/** 取出最近一个还原点（调用方负责写回存档） */
export function popUndo(st) {
    const l = stacks.get(sid(st));
    const x = l?.pop();
    return x ? { label: x.label, state: JSON.parse(x.json) } : null;
}
