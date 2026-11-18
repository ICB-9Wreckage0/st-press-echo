// segments.js — 回溯推演的分段：从聊天楼层读出故事日期，按楼数 / 字数切段。
// 关键是别被一句“九月五日交稿”“1999年12月31日”之类的顺口提到的日期带跑：
// 超过目标日期的不要；一下往前跳太多、后面几楼又没跟上的，当成顺口一提。

import { cmp, addDays, diffDays, pickStoryDate } from './date.js';
import { isStoryMessage } from './util.js';

const JUMP_CHECK = 14; // 一次往前跳超过这么多天，要后面的楼层确认
const LOOKAHEAD = 6;
const CONFIRM = 2;

/** 每个剧情楼层的故事日期（已剔除顺口一提的日期）。返回 [{ i, iso, raw, rejected }] */
export function storyTimeline(chat, { target = null, headChars = 160, includeHidden = true } = {}) {
    const rows = [];
    (chat || []).forEach((m, i) => {
        if (!isStoryMessage(m, includeHidden)) return;
        const p = pickStoryDate(m.mes || '', null, { headChars });
        rows.push({ i, chars: String(m.mes || '').length, raw: p?.iso || null });
    });
    let acc = null;
    rows.forEach((r, k) => {
        const d = r.raw;
        if (!d) { r.iso = acc; return; }
        let why = '';
        if (target && cmp(d, target) > 0) why = 'after-target';
        else if (!acc) {
            const next = rows.slice(k + 1).filter(x => x.raw && (!target || cmp(x.raw, target) <= 0)).slice(0, LOOKAHEAD);
            const ok = next.filter(x => diffDays(x.raw, d) >= -3 && diffDays(x.raw, d) <= 60).length;
            if (next.length && ok < Math.min(CONFIRM, next.length)) why = 'unconfirmed';
        }
        else if (acc && cmp(d, acc) < 0) why = 'backward';
        else if (acc && diffDays(d, acc) > 400) why = 'too-far';
        else if (acc && diffDays(d, acc) > JUMP_CHECK) {
            const next = rows.slice(k + 1).filter(x => x.raw && (!target || cmp(x.raw, target) <= 0)).slice(0, LOOKAHEAD);
            const ok = next.filter(x => cmp(x.raw, addDays(d, -3)) >= 0).length;
            if (ok < Math.min(CONFIRM, next.length || CONFIRM)) why = 'unconfirmed';
        }
        if (why) r.rejected = why; else acc = d;
        r.iso = acc;
    });
    return rows;
}

/**
 * 按楼数 / 字数切段。first：最早发表日期；target：推到哪天。
 * 返回 { segs: [{ fromMes, toMes, chars, floors, endDate }], merged, rejected: [{ i, raw, why }] }
 * 日期没往前走的段并进前一段（同一天推两次没有意义），merged 记并了几段。
 */
export function planFloorSegments(chat, { by = 'floors', size = 100, first, target, headChars, includeHidden = true } = {}) {
    const tl = storyTimeline(chat, { target, headChars, includeHidden });
    const raw = [];
    let cur = null;
    for (const r of tl) {
        if (!cur) cur = { fromMes: r.i, toMes: r.i, chars: 0, floors: 0, endDate: null };
        cur.toMes = r.i; cur.chars += r.chars; cur.floors++;
        if (r.iso) cur.endDate = r.iso;
        if ((by === 'floors' && cur.floors >= size) || (by === 'chars' && cur.chars >= size)) { raw.push(cur); cur = null; }
    }
    if (cur) raw.push(cur);
    const out = [];
    let last = first ? addDays(first, -1) : null, merged = 0;
    const mergePrev = g => { const p = out[out.length - 1]; if (p) { p.toMes = g.toMes; p.chars += g.chars; p.floors += g.floors; merged++; } };
    for (const g of raw) {
        if (!g.endDate || !first || cmp(g.endDate, first) < 0) { mergePrev(g); continue; }
        if (last && cmp(g.endDate, last) <= 0) { mergePrev(g); continue; }
        out.push({ ...g });
        last = g.endDate;
    }
    return { segs: out, merged, rejected: tl.filter(r => r.rejected).map(r => ({ i: r.i, raw: r.raw, why: r.rejected })) };
}
