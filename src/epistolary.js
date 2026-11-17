// epistolary.js — 与书信簿（st-epistolary）协作。只读，不写回书信簿的档案。
//
// 书信簿把档案挂在 globalThis.epistolary.store.archive 上，剧情日期存在 chatMetadata.epistolary.storyDate。
// 这里做三件事，全部只作“辅助线索”，默认不当作已发生的反响：
//  1. 读取剧情日期，必要时同步；
//  2. 扫描当前角色卡下、截至故事日期已写成的信，找出提到作品或笔名的段落，列为线索；
//  3. 把书信簿的人物档案（含“真实历史人物”标记）转为待合并建议。

import { normalizeISO, cmp } from './date.js';
import { truncate } from './util.js';
import { findByName } from './data.js';

export function epistolaryAvailable() {
    return !!globalThis.epistolary?.store?.archive;
}

function ctx() { return globalThis.SillyTavern?.getContext?.(); }

export function epistolaryStoryDate() {
    const md = ctx()?.chatMetadata;
    return normalizeISO(md?.epistolary?.storyDate || '') || null;
}

function curScopeKey() {
    const c = ctx();
    if (!c) return null;
    if (c.groupId) return `group:${c.groupId}`;
    const ch = c.characters?.[c.characterId];
    return ch ? `char:${ch.avatar || ch.name}` : null;
}

function lettersHere() {
    const arc = globalThis.epistolary?.store?.archive;
    if (!arc?.letters) return [];
    const key = curScopeKey();
    return Object.values(arc.letters).filter(l => !key || (l.scope || '') === key);
}

// 书信簿允许 1890 / 1890-11 / 1890-11-03；只按“不晚于故事日期”过滤
function onOrBefore(written, storyDate) {
    const w = String(written || '').trim();
    if (!storyDate) return true;
    if (!/^\d{4}(-\d{1,2})?(-\d{1,2})?$/.test(w)) return false; // 写不成日期的不参与
    const parts = w.split('-').map(Number);
    const full = normalizeISO(`${parts[0]}-${parts[1] || 1}-${parts[2] || 1}`);
    return full ? cmp(full, storyDate) <= 0 : false;
}

function excerpt(text, idx, len) {
    const a = Math.max(0, idx - 50);
    const b = Math.min(text.length, idx + len + 70);
    return (a > 0 ? '…' : '') + text.slice(a, b).replace(/\s+/g, ' ') + (b < text.length ? '…' : '');
}

/**
 * 扫描书信，找出提到作品/笔名的地方。
 * 返回 [{id, letterId, code, date, author, recipients, work, penname, excerpt, suggestion}]
 */
export function scanLetters(state) {
    if (!epistolaryAvailable()) throw new Error('没有检测到书信簿插件（或它尚未载入档案）');
    const hints = [];
    const titles = (state.works || []).filter(w => w.title).map(w => ({ w, keys: [w.title, w.title.replace(/[《》]/g, '')].filter(k => k.length >= 2) }));
    const pens = (state.pennames || []).filter(p => p.name).map(p => ({ p, keys: [p.name, p.name.replace(/\s+/g, '')] }));
    const owner = new Set((state.pennames || []).map(p => (p.owner || '').trim()).filter(Boolean));
    const userName = (ctx()?.name1 || '').trim();
    if (userName) owner.add(userName);
    for (const l of lettersHere()) {
        if (!onOrBefore(l.writtenAt, state.currentDate)) continue;
        if (['draft', 'unsent'].includes(l.status)) continue;
        const body = String(l.body || '');
        const found = new Map();
        for (const { w, keys } of titles) {
            for (const k of keys) {
                const i = body.indexOf(k);
                if (i >= 0) { found.set('w:' + w.id, { work: w, idx: i, len: k.length }); break; }
            }
        }
        for (const { p, keys } of pens) {
            for (const k of keys) {
                const i = body.indexOf(k);
                if (i >= 0 && ![...found.values()].some(f => f.work?.pennameId === p.id)) { found.set('p:' + p.id, { penname: p, idx: i, len: k.length }); break; }
            }
        }
        for (const f of found.values()) {
            const authorIsOwner = [...owner].some(o => o && String(l.author || '').includes(o));
            const counterpart = authorIsOwner ? (l.recipients || [])[0] : l.author;
            const person = findByName(state.persons, counterpart);
            hints.push({
                id: `${l.id}|${f.work?.id || f.penname?.id}`,
                letterId: l.id,
                code: l.code || '',
                date: normalizeISO(String(l.writtenAt || '').length === 10 ? l.writtenAt : '') || l.writtenAt || '',
                author: l.author || '',
                recipients: l.recipients || [],
                workId: f.work?.id || null,
                workTitle: f.work?.title || '',
                penname: f.penname?.name || '',
                personName: counterpart || '',
                personId: person?.id || null,
                direction: authorIsOwner ? 'from_user' : 'to_user',
                excerpt: excerpt(body, f.idx, f.len),
                suggestion: authorIsOwner
                    ? `主角在信里向 ${counterpart || '收信人'} 提到此作品 → 可记为对方“经书信得知”`
                    : `${counterpart || '写信人'} 在信里提到此作品 → 可记为此人此前已读过`,
            });
        }
    }
    // 去掉已经处理过的
    const done = new Set((state.epiHints || []).filter(h => h.handled).map(h => h.id));
    return hints.filter(h => !done.has(h.id));
}

/** 书信簿人物档案 → 待合并建议（只带名字、真实人物标记和文风备注） */
export function peopleProposals(state) {
    const arc = globalThis.epistolary?.store?.archive;
    if (!arc?.people) return [];
    const out = [];
    for (const p of arc.people) {
        if (!p?.name || findByName(state.persons, p.name)) continue;
        out.push({
            kind: 'person',
            source: '书信簿人物档案',
            evidence: truncate([p.styleSource, p.styleNotes].filter(Boolean).join('；'), 80),
            data: { name: p.name, roles: [], outletNames: [], interests: [], likes: [], dislikes: [], closeness: 1, real: !!p.historical, notes: p.aliases?.length ? `别名：${p.aliases.join('、')}` : '' },
        });
    }
    return out;
}
