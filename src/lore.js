// lore.js — 把人物档案和作品资料写进酒馆的世界书（lorebook）。
// 聊天里提到某人或某部作品时，世界书才把对应条目放进上下文，主对话里的 NPC 就会按推演结果说话。
// 只改动本插件写的条目（标题以【报刊回声】开头），世界书里你自己的条目不动。

import { byId, knowsPen, ROLES, READ_STATES, STRENGTH, EXPRESSION, LAYERS, FORMS, IMPRESSION_LABEL, impressionAt, knownToUser, SIDES, STANCE_STRENGTH, normSide, normStrength, READ_DONE, CIRCLES } from './engine.js';
import { cmp } from './date.js';
import { truncate } from './util.js';
import { clog } from './console.js';
import { RESPECT, FOLLOW } from './analysis.js';
import { factsKnownBy, perceptionsOf, claimsVisible, PERC_KIND, FACT_VIA } from './perception.js';
import { latestImage, SPREAD } from './image.js';

export const LORE_TAG = '【报刊回声】';
const CLOSE = ['陌生', '认识', '朋友', '至交'];

function knowsPenOwner(st, person, pen) {
    return !!(pen?.publicIdentityKnown || knowsPen(st, person, pen.id));
}

export function personEntry(st, p) {
    const today = st.currentDate;
    const recs = (st.receptions || []).filter(r => r.personId === p.id && READ_DONE.includes(r.read) && (!r.readDate || !today || cmp(r.readDate, today) <= 0));
    const L = [`${LORE_TAG}${p.name}${(p.aliases || []).length ? '（' + p.aliases.join('、') + '）' : ''}`];
    const outs = n => (n || []).map(id => byId(st.outlets, id)?.name).filter(Boolean).join('、');
    L.push(`身份：${(p.roles || []).map(r => ROLES[r] || r).join('、') || '—'}${outs(p.outletIds) ? '；为《' + outs(p.outletIds).split('、').join('》《') + '》供稿' : ''}；与主角：${CLOSE[p.closeness || 0]}`);
    for (const pen of st.pennames || []) {
        if (!(st.works || []).some(w => w.pennameId === pen.id)) continue;
        L.push(knowsPenOwner(st, p, pen) ? `他知道署名“${pen.name}”的作品出自主角之手。` : `他不知道署名“${pen.name}”背后是谁（不能对主角说破，最多猜测）。`);
    }
    const kf = factsKnownBy(st, p.id, st.currentDate);
    L.push(kf.length ? `他知道的主角私事：${kf.map(x => `${x.fact.text}（${FACT_VIA[x.via] || '公开'}${x.believes ? '' : '，半信半疑'}）`).join('；')}。这些他会守分寸，不会随便对别人说。` : '他不知道主角的私人情况（身世、国籍、母语等），不会提起，也不会猜成事实。');
    const latest = {};
    for (const b of perceptionsOf(st, p.id, { before: st.currentDate ? st.currentDate + 'z' : null })) latest[b.topic] = b;
    if (Object.keys(latest).length) L.push('他对作者的看法：' + Object.values(latest).map(b => `${b.belief}（${PERC_KIND[b.kind]}）`).join('；'));
    const asm = (st.assumed || []).filter(a => a.personId === p.id && (!a.since || !today || cmp(a.since, today) <= 0));
    if (asm.length) L.push(`主角以为他觉得：${asm.map(a => a.belief).join('；')}。${Object.keys(latest).length ? '这只是主角的猜想，以上面“他对作者的看法”为准；两者不一致时，可以让误会在对话里自然显露。' : '这只是主角的猜想，他本人未必这么想。'}`);
    const sl = (p.stances || []).filter(x => x?.issue).map(x => `${x.issue}${SIDES[normSide(x.side)] || ''}（${STANCE_STRENGTH[normStrength(x.strength)]}）${x.note ? '：' + truncate(x.note, 30) : ''}`);
    if (sl.length) L.push('立场：' + sl.join('；'));
    const pl = (p.stylePrefs || []).filter(x => x?.aspect).map(x => `${x.aspect}：${truncate(x.leaning || '', 30)}`);
    if (pl.length) L.push('读作品时在意：' + pl.join('；'));
    if (recs.length) {
        L.push(`读过的作品（截至 ${today || '今'}）：`);
        for (const r of recs.slice(-8)) {
            const w = byId(st.works, r.workId);
            const pen = byId(st.pennames, w?.pennameId);
            const o = r.opinion;
            const bits = [`${READ_STATES[r.read]}${r.readDate ? ' ' + r.readDate.slice(5) : ''}`, `${['偏批评', '褒贬参半', '偏肯定'][(r.polarity ?? 0) + 1]}，${STRENGTH[r.strength] || ''}`];
            if (r.ideas?.disagree?.length) bits.push('思想上反对：' + r.ideas.disagree.join('、'));
            if (r.ideas?.partial?.length) bits.push('部分赞同：' + r.ideas.partial.join('、'));
            if (o?.summary) bits.push('私下看法：' + truncate(o.summary, 90));
            if (o?.disagreements?.length) bits.push('分歧：' + o.disagreements.map(x => (x.key ? '【关键】' : '') + truncate(x.point, 30)).join('；'));
            if (o?.respectsAuthor) bits.push(RESPECT[o.respectsAuthor]);
            if (o?.follow) bits.push(FOLLOW[o.follow]);
            if (r.expression) bits.push(EXPRESSION[r.expression] || r.expression);
            L.push(`- 《${w?.title || '?'}》（署名 ${pen?.name || '?'}）：${bits.filter(Boolean).join('；')}`);
        }
        for (const pen of st.pennames || []) {
            const v = impressionAt(st, pen.id, p.id, today);
            if (recs.some(r => byId(st.works, r.workId)?.pennameId === pen.id)) L.push(`对“${pen.name}”这个作者的印象：${IMPRESSION_LABEL(v)}`);
        }
    }
    L.push('（以上是此人私下的看法与所知。他会按场合和与主角的交情决定说多少；没见报的评论不会被当作已发表；他不知道的事不能说出来。）');
    return { key: [p.name, ...(p.aliases || [])].filter(Boolean), content: L.join('\n'), comment: `${LORE_TAG}${p.name}` };
}

export function workEntry(st, w) {
    const pen = byId(st.pennames, w.pennameId);
    const o = byId(st.outlets, w.outletId);
    const pub = (st.ledger || []).filter(e => e.workId === w.id && knownToUser(st, e) && LAYERS[e.layer]?.public);
    const L = [`${LORE_TAG}《${w.title}》`];
    L.push(`署名“${pen?.name || '?'}”${pen && !pen.publicIdentityKnown ? '（公众不知道作者是谁）' : ''}；${FORMS[w.form] || ''}；${w.pubDate || '日期不详'}${w.endDate ? '–' + w.endDate : ''} 发表于《${o?.name || '?'}》`);
    if (w.summary) L.push('内容：' + truncate(w.summary, 160));
    if ((w.themes || []).length) L.push('题材：' + w.themes.join('、'));
    if (pub.length) {
        L.push('已见报的反响：');
        for (const e of pub.slice(-6)) L.push(`- ${e.date.slice(5)} ${byId(st.outlets, e.outletId)?.name ? '《' + byId(st.outlets, e.outletId).name + '》' : ''}${byId(st.persons, e.personId)?.name || e.personName || ''} ${LAYERS[e.layer]?.label || ''}${e.count ? '约 ' + e.count : ''}${e.layer === 'mentions' || e.layer === 'reader_letters' ? '' : '（' + ['批评', '褒贬参半', '肯定'][(e.polarity ?? 0) + 1] + '）'}${e.text?.summary ? '：' + truncate(e.text.summary, 60) : ''}`);
    }
    return { key: [w.title, ...(w.aliases || [])].filter(Boolean), content: L.join('\n'), comment: `${LORE_TAG}《${w.title}》` };
}

/** 署名的公众形象：各圈子最近一次整理的公开说法 + 作者的公开说法。没有就不写 */
export function penEntry(st, pen) {
    const today = st.currentDate;
    const L = [`${LORE_TAG}署名“${pen.name}”的公众形象（截至 ${today || '今'}）`];
    let n = 0;
    for (const c of Object.keys(CIRCLES)) {
        const img = latestImage(st, pen.id, c, today);
        if (!img || !img.items.length) continue;
        n++;
        L.push(`${CIRCLES[c]}（${img.asOf} 整理）：${img.summary ? img.summary + '；' : ''}${img.items.map(i => `${i.belief}（${SPREAD[i.spread] || ''}）`).join('；')}`);
    }
    const cl = claimsVisible(st, pen.id, today);
    if (cl.length) { n++; L.push('作者公开说过：' + cl.map(c => c.text).join('；')); }
    if (!n) return null;
    L.push(`这是外界公开流传的印象，可能片面或有误；${pen.publicIdentityKnown ? '' : '公众不知道署名背后是谁，'}不代表某个人私下的看法。`);
    return { key: [pen.name], content: L.join('\n'), comment: `${LORE_TAG}署名“${pen.name}”的公众形象` };
}

/** 哪些人物写进世界书：读过主角作品、登记了立场，或与主角相识的 */
export function lorePersons(st, scope = 'involved') {
    return (st.persons || []).filter(p => p.active !== false && (scope === 'all' || (st.receptions || []).some(r => r.personId === p.id && READ_DONE.includes(r.read)) || (p.stances || []).length || (p.closeness || 0) >= 1));
}

const TEMPLATE = { keysecondary: [], constant: false, vectorized: false, selective: true, selectiveLogic: 0, addMemo: true, order: 100, position: 0, disable: false, excludeRecursion: true, preventRecursion: true, delayUntilRecursion: false, probability: 100, useProbability: true, depth: 4, group: '', groupOverride: false, groupWeight: 100, scanDepth: null, caseSensitive: null, matchWholeWords: null, useGroupScoring: null, automationId: '', role: null, sticky: 0, cooldown: 0, delay: 0 };

/** 同步到世界书。返回 { book, added, updated, removed } */
export async function syncLore(st, settings) {
    const c = globalThis.SillyTavern?.getContext?.();
    if (!c || typeof c.saveWorldInfo !== 'function' || typeof c.loadWorldInfo !== 'function') throw new Error('当前酒馆版本没有世界书接口（loadWorldInfo / saveWorldInfo）');
    const name = String(settings.loreBook || '报刊回声').trim() || '报刊回声';
    let data = null;
    try { data = await c.loadWorldInfo(name); } catch { data = null; }
    const created = !data;
    if (!data || typeof data !== 'object') data = { entries: {} };
    data.entries = data.entries || {};
    const want = [
        ...lorePersons(st, settings.loreScope).map(p => ({ id: 'per:' + p.id, ...personEntry(st, p) })),
        ...(st.pennames || []).map(pen => ({ pen, e: penEntry(st, pen) })).filter(x => x.e).map(x => ({ id: 'pen:' + x.pen.id, ...x.e })),
        ...(settings.loreWorks !== false ? (st.works || []).filter(w => !w.pubDate || !st.currentDate || cmp(w.pubDate, st.currentDate) <= 0).map(w => ({ id: 'wrk:' + w.id, ...workEntry(st, w) })) : []),
    ];
    st.lore = st.lore && st.lore.book === name ? st.lore : { book: name, uids: {} };
    const uids = st.lore.uids;
    const ours = e => typeof e?.comment === 'string' && e.comment.startsWith(LORE_TAG);
    let next = Math.max(-1, ...Object.keys(data.entries).map(Number).filter(n => !isNaN(n))) + 1;
    let added = 0, updated = 0, removed = 0;
    const keep = new Set();
    for (const x of want) {
        let uid = uids[x.id];
        if (uid == null || !data.entries[uid] || !ours(data.entries[uid])) {
            // 名字找回（例如换了电脑、存档里没记 uid）
            const found = Object.entries(data.entries).find(([, e]) => ours(e) && e.comment === x.comment);
            uid = found ? Number(found[0]) : next++;
        }
        const old = data.entries[uid];
        const entry = { ...TEMPLATE, ...(old || {}), uid, key: x.key, comment: x.comment, content: x.content, displayIndex: old?.displayIndex ?? uid };
        if (!old) added++; else if (old.content !== x.content || JSON.stringify(old.key) !== JSON.stringify(x.key)) updated++;
        data.entries[uid] = entry;
        uids[x.id] = uid;
        keep.add(String(uid));
    }
    for (const [uid, e] of Object.entries(data.entries)) {
        if (ours(e) && !keep.has(String(uid))) { delete data.entries[uid]; removed++; }
    }
    for (const k of Object.keys(uids)) if (!keep.has(String(uids[k]))) delete uids[k];
    await c.saveWorldInfo(name, data, true);
    if (created) { try { await c.updateWorldInfoList?.(); } catch { /* 旧版没有 */ } }
    if (settings.loreBindChat !== false && c.chatMetadata && !c.chatMetadata.world_info) {
        c.chatMetadata.world_info = name;
        try { await c.saveMetadata?.(); } catch { /* 下次保存时一起存 */ }
    }
    st.lore.at = new Date().toISOString();
    clog('info', `世界书“${name}”已同步：新增 ${added}、更新 ${updated}、删除 ${removed}（共 ${want.length} 条）${created ? '；世界书是新建的' : ''}`, want.map(x => x.comment).join('、'));
    return { book: name, added, updated, removed, total: want.length, created };
}
