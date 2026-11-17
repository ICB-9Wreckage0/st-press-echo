// engine.js — 确定性推演核心（v0.2）
//
// 一部作品发表后，每个人都要依次过四关：
//   ① 接触：有没有机会看到（供职、订阅、朋友、风声、看到别人的评论）
//   ② 阅读：看到了读不读、读多少（兴趣、篇幅、忙不忙、是否读过另一个版本）
//   ③ 看法：读了有没有值得说的看法（褒贬方向、强弱）。具体内容等需要时才让模型写
//   ④ 表达：沉默、私下谈起、写私信、还是公开发表；公开发表还要过刊物版面和截稿日
// 模型不参与这里的任何判断。

import { reapplyDecisions } from './rollback.js';
import { addDays, diffDays, monthOf, monthKey, weekday, dayOf, cmp, normalizeISO } from './date.js';
import { roll } from './rng.js';
import { clamp, uid, deepClone } from './util.js';
import { matchCount, useConcepts } from './concepts.js';

// ———————————— 常量 ————————————

export const FORMS = {
    serial: '报纸连载',
    article: '单篇文章',
    book: '成书',
    pamphlet: '小册子/附赠本',
    translation_serial: '译作连载',
    translation_book: '译作单行本',
};

export const PERIODICITY = { daily: '日报', weekly: '周刊/周报', biweekly: '半月刊', monthly: '月刊', irregular: '不定期' };

export const CIRCLES = {
    critics: '评论界',
    literary: '文学圈',
    general: '普通读者',
    radical: '激进/社会主义报刊圈',
    religious: '宗教界',
    professional: '专业界（法、医、学术）',
    political: '政界与政论',
};

export const LAYERS = {
    review: { label: '正式书评', public: true, needsOutlet: true, repWeight: 0.5, major: true },
    polemic: { label: '论战文章', public: true, needsOutlet: true, repWeight: 0.35, major: true },
    notice: { label: '书讯/短评', public: true, needsOutlet: true, repWeight: 0.15 },
    echo: { label: '短讯/八卦', public: true, needsOutlet: true, repWeight: 0.05 },
    private_letter: { label: '私信', public: false, needsOutlet: false, repWeight: 0 },
    reader_letters: { label: '读者来信', public: false, needsOutlet: true, repWeight: 0.1 },
    mentions: { label: '转载/提及（剪报）', public: true, needsOutlet: false, repWeight: 0.05 },
};

export const REL_TYPES = { friend: '朋友', colleague: '同事', family: '家人/伴侣', mentor: '师友/前辈', editor: '编辑与作者', salon: '沙龙/聚会常客', correspondent: '通信往来', rival: '对手/论敌' };
export const REL_FREQ = { daily: '几乎天天见', weekly: '每周', monthly: '每月', rare: '偶尔' };

export const ROLES = { critic: '评论家', journalist: '记者/专栏作者', editor: '编辑', writer: '作家', scholar: '学者/专业人士' };

const ROLE_LAYERS = {
    critic: ['review', 'notice', 'polemic'],
    journalist: ['echo', 'notice', 'polemic'],
    editor: ['notice'],
    writer: ['review'],
    scholar: ['polemic', 'notice'],
};
const ROLE_MOTIVE = { critic: 1, journalist: 0.9, scholar: 0.7, editor: 0.5, writer: 0.35 };

export const READ_STATES = { none: '未接触', ignored: '接触但没读', skimmed: '浏览/读了一部分', finished: '读完' };
export const STRENGTH = { none: '印象不深', mild: '有些想法', strong: '想法强烈' };

/**
 * 看法的状态。推演只掷出“印象深浅、偏褒偏贬”；具体看法要调模型才生成。两者分开，避免
 * “先记着某人没什么想法，后来他却写出一篇深刻的评论”这种矛盾。
 */
export const OPINION_STATUS = {
    unread: '没读',
    unanalyzed: '尚未分析',
    shallow: '印象不深',
    private: '有私人意见',
    expressed: '已表达',
};
export function opinionStatus(rec) {
    if (!rec || !['skimmed', 'finished'].includes(rec.read)) return 'unread';
    const said = ['private_letter', 'public'].includes(rec.expression) || (rec.expression === 'remark' && rec.told > 0);
    if (rec.opinion) return said ? 'expressed' : 'private';
    if (said) return 'expressed';
    return rec.strength === 'none' ? 'shallow' : 'unanalyzed';
}
export const EXPRESSION = {
    silent: '放在心里',
    remark: '私下谈起',
    private_letter: '写私信',
    public: '公开发表',
    blocked: '想发表但没有版面',
};
export const CHANNELS = {
    staff: '供职于发表刊物',
    reader: '订阅/常读该刊',
    friend: '朋友相告或作者赠阅',
    buzz: '风声与名气',
    review: '读到别人的评论',
    letter: '书信中得知',
    seek: '读过同一作者的作品，主动找来读',
    follow: '追读这位作者，新作一出就看',
    recommend: '熟人谈起或推荐',
    manual: '手动记录',
};

// 发表后最晚多少天还会有回应
const LAG_CLOSE = { daily: 30, weekly: 40, biweekly: 50, monthly: 70, irregular: 50 };
// 默认版面：每期（日报按每周）最多登几篇与该作者相关的稿件
const DEFAULT_CAPACITY = { daily: 2, weekly: 1, biweekly: 1, monthly: 1, irregular: 1 };
// 默认截稿：出刊前几天
const DEFAULT_DEADLINE = { daily: 1, weekly: 3, biweekly: 5, monthly: 8, irregular: 5 };
// 写一篇要几天
const WRITE_DAYS = { review: [3, 9], polemic: [2, 6], notice: [1, 3], echo: [0, 2], private_letter: [1, 7] };

const FORM_FACTOR = {
    review: { book: 1, translation_book: 1, pamphlet: 0.65, serial: 0.15, translation_serial: 0.15, article: 0.1 },
    notice: { book: 0.9, translation_book: 0.9, pamphlet: 0.9, serial: 0.5, translation_serial: 0.5, article: 0.4 },
    echo: { book: 0.4, translation_book: 0.4, pamphlet: 0.3, serial: 0.6, translation_serial: 0.6, article: 0.5 },
    polemic: { book: 0.8, translation_book: 0.6, pamphlet: 0.8, serial: 0.7, translation_serial: 0.5, article: 0.7 },
};
const READ_LENGTH = { article: 0.95, serial: 0.85, translation_serial: 0.8, pamphlet: 0.75, book: 0.6, translation_book: 0.6 };

const DEFAULT_SEASON = { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 0.95, 7: 0.8, 8: 0.55, 9: 0.85, 10: 1, 11: 1, 12: 0.9 };

const DEFAULT_SECTIONS = {
    daily: ['review', 'notice', 'echo', 'polemic', 'reader_letters'],
    weekly: ['review', 'notice', 'echo', 'polemic'],
    biweekly: ['review', 'notice', 'polemic'],
    monthly: ['review', 'notice', 'polemic'],
    irregular: ['notice', 'polemic'],
};

export const DEFAULT_ENGINE_SETTINGS = {
    intensity: 0.5,
    layerMult: { review: 1, notice: 1, echo: 1, polemic: 1, private_letter: 1 },
    rumorHalfLife: 21,
    autoApprove: 'minor', // 'none' 全部手动；'minor' 次要事件自动通过，重要事件仍需确认
};

// ———————————— 工具 ————————————

export function byId(list, id) {
    return (list || []).find(x => x.id === id) || null;
}

export function outletSections(o) {
    if (o && Array.isArray(o.sections) && o.sections.length) return o.sections;
    return DEFAULT_SECTIONS[o?.periodicity] || DEFAULT_SECTIONS.irregular;
}

export function workTags(state, work) {
    const host = byId(state.outlets, work.outletId);
    return [...(work.themes || []), ...(host?.politics || [])];
}

export function readsOutlets(state, person) {
    if (person.reads?.length) return new Set([...person.reads, ...(person.outletIds || [])]);
    // 没填就默认：自己供稿的刊物 + 影响力 4 级以上的大报（人人都会翻）
    return new Set([...(person.outletIds || []), ...(state.outlets || []).filter(o => (o.tier || 3) >= 4).map(o => o.id)]);
}

export function parseBusy(text) {
    const out = [];
    for (const part of String(text || '').split(/[;；,，\n]+/)) {
        const m = part.split(/[~～至到—–-]{1,2}(?=\d{4})/).map(s => normalizeISO(s.trim()));
        if (m[0] && m[1]) out.push([m[0], m[1]]);
        else if (m[0]) out.push([m[0], m[0]]);
    }
    return out;
}

function isBusy(person, iso) {
    return parseBusy(person.busy).some(([a, b]) => cmp(iso, a) >= 0 && cmp(iso, b) <= 0);
}

/** 某刊物在 [from, to] 内的出刊日 */
export function columnSlots(outlet, from, to) {
    const out = [];
    const per = outlet?.periodicity || 'irregular';
    const days = Math.min(400, Math.max(0, diffDays(to, from)));
    for (let i = 0; i <= days; i++) {
        const d = addDays(from, i);
        if (per === 'daily' || per === 'irregular') out.push(d);
        else if (per === 'weekly') {
            const wd = Number.isInteger(outlet.weekday) ? outlet.weekday : 0;
            if (weekday(d) === wd) out.push(d);
        } else if (per === 'biweekly') {
            const md = outlet.monthDays?.length ? outlet.monthDays : [1, 15];
            if (md.includes(dayOf(d))) out.push(d);
        } else if (per === 'monthly') {
            const md = outlet.monthDays?.length ? outlet.monthDays : [1];
            if (md.includes(dayOf(d))) out.push(d);
        }
    }
    return out;
}

export function repLabel(v) {
    const n = Math.round(clamp(v || 0, -2, 2));
    return { '-2': '声名狼藉', '-1': '颇受非议', '0': '默默无闻', '1': '小有名气', '2': '声誉卓著' }[String(n)];
}

function fameFactor(state, pennameId) {
    const rep = state.reputation?.[pennameId] || {};
    const avg = ((rep.critics || 0) + (rep.literary || 0)) / 2;
    return clamp(1 + 0.25 * avg, 0.7, 1.5);
}

function seasonFactor(era, iso) {
    const m = monthOf(iso);
    const sf = era?.seasonFactors?.[m] ?? era?.seasonFactors?.[String(m)];
    return typeof sf === 'number' ? sf : DEFAULT_SEASON[m];
}

function between(seed, key, [lo, hi]) {
    return lo + Math.floor(roll(seed, key) * (hi - lo + 1));
}

function interestOf(person, tags) {
    const pool = [...(person.interests || []), ...(person.likes || []), ...(person.dislikes || [])];
    return clamp((matchCount(pool, tags, true) / Math.max(1, tags.length)) * 2, 0, 1);
}

/** 立场：欣赏/反感标签对作品标签（含发表刊物的倾向）的重叠 */
export function computePolarity(state, person, work, r, layer) {
    useConcepts(state.concepts);
    const tags = workTags(state, work);
    const likes = matchCount(person.likes, tags, false);
    const dislikes = matchCount(person.dislikes, tags, false);
    if (layer === 'polemic' && dislikes > likes) return -1;
    // 标签重叠是主因；私交深的人下笔更宽厚；剩下交给运气（没有任何重叠时，约八分之一偏好、八分之一偏坏）
    const score = likes - dislikes + 0.15 * (Number(person.closeness) || 0) + (r - 0.5) * 1.6;
    return score > 0.6 ? 1 : score < -0.6 ? -1 : 0;
}

function issueKey(outlet, date) {
    if (outlet.periodicity === 'daily' || outlet.periodicity === 'irregular') {
        // 按周计
        const d = addDays(date, -((weekday(date) + 6) % 7));
        return 'W' + d;
    }
    return 'I' + date;
}

function outletLoad(state, outlet, date) {
    const k = issueKey(outlet, date);
    return state.ledger.filter(e => e.outletId === outlet.id && LAYERS[e.layer]?.public && e.layer !== 'mentions'
        && e.status !== 'rejected' && issueKey(outlet, e.date) === k).length;
}

function personMonthLoad(state, personId, date) {
    const mk = monthKey(date);
    return state.ledger.filter(e => e.personId === personId && LAYERS[e.layer]?.public && e.status !== 'rejected' && monthKey(e.date) === mk).length;
}

export function isMajor(state, ev) {
    if (LAYERS[ev.layer]?.major) return true;
    const person = byId(state.persons, ev.personId);
    if (ev.layer === 'private_letter' && person?.real) return true;
    return !!ev.identity;
}

// ———————————— 声誉 ————————————

function repDelta(state, ev) {
    const info = LAYERS[ev.layer];
    if (!info || !ev.pennameId) return null;
    const outlet = byId(state.outlets, ev.outletId);
    if (ev.layer === 'reader_letters') return { circle: 'general', delta: (ev.count || 0) >= 20 ? 0.1 : 0.03 };
    if (ev.layer === 'mentions') return { circle: 'general', delta: Math.min(0.15, 0.02 * (ev.count || 0)) };
    if (!info.public) return null;
    const delta = ev.polarity > 0 ? info.repWeight : ev.polarity < 0 ? -info.repWeight * 0.5 : info.repWeight * 0.3;
    return { circle: outlet?.circle || 'general', delta };
}

/** 声誉完全由“已批准事件”按日期顺序算出，因此回滚、撤销后总能自洽 */
export function recomputeReputation(state) {
    const rep = {};
    const list = (state.ledger || []).filter(e => e.status === 'approved').sort((a, b) => cmp(a.date, b.date));
    for (const ev of list) {
        const d = repDelta(state, ev);
        ev.repApplied = null;
        if (!d) continue;
        const r = (rep[ev.pennameId] = rep[ev.pennameId] || {});
        const before = r[d.circle] || 0;
        const after = clamp(before + d.delta, -2, 2);
        r[d.circle] = +after.toFixed(3);
        ev.repApplied = { penId: ev.pennameId, circle: d.circle, delta: +(after - before).toFixed(3) };
    }
    state.reputation = rep;
}

export function setStatus(state, ev, status) {
    ev.status = status;
    recomputeReputation(state);
}

// ———————————— 四关 ————————————

function contactStage(state, s, era, work, person, seed, extra) {
    const host = byId(state.outlets, work.outletId);
    const pen = byId(state.pennames, work.pennameId);
    const channels = [];
    const why = [];
    const add = (ch, p, lag, from = null) => channels.push({ ch, p, lag, from });
    if (extra) {
        // 因看到别人的评论才知道原作：只看这一条渠道（常规渠道第一次已经掷过）
        add(extra.ch, extra.p, extra.lag);
    } else if (host && (person.outletIds || []).includes(host.id)) add('staff', 0.95, [0, 1]);
    else if (host && readsOutlets(state, person).has(host.id)) {
        add('reader', { daily: 0.7, weekly: 0.75, biweekly: 0.8, monthly: 0.85 }[host.periodicity] ?? 0.7, [0, 2]);
    }
    if (!extra) {
        const close = person.closeness || 0;
        if (close >= 2 || person.knowsIdentity || pen?.knownBy?.includes(person.id)) add('friend', close >= 3 ? 0.8 : 0.6, [2, 10]);
        const rep = state.reputation?.[work.pennameId] || {};
        add('buzz', clamp(0.05 + 0.05 * Math.max(0, (rep.general || 0) + (rep.literary || 0)), 0.05, 0.3), [3, 20]);
        // 追读：此前读了同一笔名的作品、决定找这位作者的东西看
        // 作者印象：只用发表日之前形成的印象（不让以后的印象倒流）
        const imp = impressionAt(state, work.pennameId, person.id, work.pubDate);
        if (imp >= 1) add('follow', clamp(0.45 + 0.15 * imp, 0, 0.9), [0, 3]);
        // 发表后才开始留意这个署名的：轮到这部作品时，按“主动去找”处理
        const since = state.followers?.[work.pennameId]?.[person.id];
        if (since && cmp(since, work.pubDate) > 0) add('seek', seekAvailability(state, work, person) * seekAffinity(state, work, person, null), [0, 10], since);
        const rec = state.recommends?.[work.id]?.[person.id];
        if (rec) add('recommend', rec.p ?? 0.4, [1, 6], rec.date);
    }

    const key = `${work.id}|${person.id}|contact${extra ? '|' + extra.ch : ''}`;
    let best = null;
    for (const c of channels) {
        const r = roll(seed, `${key}|${c.ch}`);
        const hit = r < c.p;
        why.push(`${CHANNELS[c.ch]}：概率 ${Math.round(c.p * 100)}%，${hit ? '接触到了' : '没接触到'}`);
        if (!hit) continue;
        const base = extra && c.ch === extra.ch ? extra.from : c.from || work.pubDate;
        const date = addDays(base, between(seed, `${key}|${c.ch}|lag`, c.lag));
        if (!best || cmp(date, best.date) < 0) best = { ch: c.ch, date };
    }
    return { best, why };
}

function readStage(state, s, era, work, person, contact, seed) {
    const tags = workTags(state, work);
    const interest = interestOf(person, tags);
    const why = [];
    let p = 0.2 + 0.7 * interest;
    why.push(`题材兴趣 ${Math.round(interest * 100)}%`);
    p *= READ_LENGTH[work.form] ?? 0.8;
    why.push(`篇幅/形式（${FORMS[work.form] || work.form}）×${READ_LENGTH[work.form] ?? 0.8}`);
    if (contact.ch === 'friend') { p *= 1.2; why.push('朋友相告，更愿意读 ×1.2'); }
    if (contact.ch === 'staff') { p *= 1.1; why.push('本刊稿件 ×1.1'); }
    if (contact.ch === 'seek') { p = Math.max(p * 1.5, 0.65); why.push('是自己特意找来的，多半会读'); }
    if (contact.ch === 'follow') { p *= 1.35; why.push('追读这位作者 ×1.35'); }
    if (contact.ch === 'recommend') {
        const tip = state.recommends?.[work.id]?.[person.id];
        const f = tip?.polarity === 1 ? 1.3 : tip?.polarity === -1 ? 0.85 : 1.05;
        p *= f; why.push(`${tip?.byName || '熟人'}${tip?.polarity === 1 ? '说好' : tip?.polarity === -1 ? '说不好' : '提起过'} ×${f}`);
    }
    const busy = isBusy(person, contact.date);
    if (busy) { p *= 0.35; why.push('正处于忙碌期 ×0.35'); }
    if (work.parentId) {
        const prev = (state.receptions || []).find(r => r.workId === work.parentId && r.personId === person.id && ['skimmed', 'finished'].includes(r.read));
        if (prev) { p *= 0.3; why.push('已读过另一个版本 ×0.3'); }
    }
    p = clamp(p, 0, 0.97);
    const key = `${work.id}|${person.id}|read`;
    const r = roll(seed, key);
    if (r >= p) { why.push(`阅读概率 ${Math.round(p * 100)}%：没读`); return { read: 'ignored', why, interest }; }
    const finished = roll(seed, key + '|depth') < 0.55 + 0.3 * interest;
    const delay = finished ? between(seed, key + '|delay', busy ? [8, 25] : [1, 12]) : between(seed, key + '|delay', [0, 3]);
    why.push(`阅读概率 ${Math.round(p * 100)}%：${finished ? '读完' : '只读了一部分'}`);
    return { read: finished ? 'finished' : 'skimmed', readDate: addDays(contact.date, delay), why, interest };
}

function opinionStage(state, work, person, read, seed) {
    const tags = workTags(state, work);
    const likes = matchCount(person.likes, tags, false);
    const dislikes = matchCount(person.dislikes, tags, false);
    const key = `${work.id}|${person.id}|opinion`;
    const polarity = computePolarity(state, person, work, roll(seed, key + '|pol'));
    let score = read.interest * 1.2 + 0.5 * (likes + dislikes) + (read.read === 'finished' ? 0.3 : 0) + roll(seed, key) * 0.6;
    let strength = score < 0.6 ? 'none' : score < 1.3 ? 'mild' : 'strong';
    if (read.read === 'skimmed' && strength === 'strong') strength = 'mild';
    const why = [`欣赏点重叠 ${likes}、反感点重叠 ${dislikes} → ${['偏批评', '褒贬参半', '偏肯定'][polarity + 1]}，${STRENGTH[strength]}`];
    return { polarity, strength, why };
}

/** 在窗口内找第一个：赶得上截稿、该期还有版面、本人本月还能写的出刊日 */
function findSlot(state, s, outlet, person, layer, earliest, close) {
    const deadline = Number.isInteger(outlet.deadlineDays) ? outlet.deadlineDays : DEFAULT_DEADLINE[outlet.periodicity] ?? 3;
    const cap = Number.isInteger(outlet.capacity) ? outlet.capacity : DEFAULT_CAPACITY[outlet.periodicity] ?? 1;
    let slots = columnSlots(outlet, addDays(earliest, layer === 'echo' ? 0 : deadline), close);
    if (Number.isInteger(person.columnWeekday) && (layer === 'review' || layer === 'notice')) slots = slots.filter(d => weekday(d) === person.columnWeekday);
    const reasons = [];
    for (const d of slots) {
        if (outletLoad(state, outlet, d) >= cap) { if (!reasons.includes('版面')) reasons.push('版面'); continue; }
        if (personMonthLoad(state, person.id, d) >= (person.monthlyCapacity ?? 2)) { if (!reasons.includes('本月稿约')) reasons.push('本月稿约'); continue; }
        return { date: d, deadline, cap };
    }
    return { date: null, deadline, cap, reasons };
}

function expressionStage(state, s, era, work, person, read, op, seed, via) {
    const why = [];
    const key = `${work.id}|${person.id}|express`;
    const out = { expression: 'silent', events: [], why };
    if (op.strength === 'none') { why.push('没有值得说的看法 → 沉默'); return out; }

    // —— 公开发表 ——
    const roles = person.roles || [];
    const motive = roles.length ? Math.max(...roles.map(r => ROLE_MOTIVE[r] || 0.3)) : 0;
    const close = clamp(person.closeness || 0, 0, 3);
    const candidates = [];
    const layers = new Set(roles.flatMap(r => ROLE_LAYERS[r] || []));
    for (const layer of layers) {
        const outlet = (person.outletIds || []).map(id => byId(state.outlets, id)).find(o => o && outletSections(o).includes(layer));
        if (!outlet) continue;
        const dislikes = matchCount(person.dislikes, workTags(state, work), false);
        let p = s.intensity * (s.layerMult?.[layer] ?? 1) * motive;
        p *= FORM_FACTOR[layer]?.[work.form] ?? 0.5;
        p *= op.strength === 'strong' ? 1 : 0.45;
        p *= [1, 0.9, 0.55, 0.3][close];
        if ((byId(state.pennames, work.pennameId)?.knownBy?.includes(person.id) || person.knowsIdentity) && close >= 2) p *= 0.7;
        if (layer === 'polemic') {
            const opposing = via && via.polarity !== 0 && via.polarity !== op.polarity;
            p *= opposing ? 1.4 : dislikes > 0 ? clamp(0.4 + 0.3 * dislikes, 0, 1.2) : 0.1;
        }
        p *= seasonFactor(era, read.readDate);
        p *= fameFactor(state, work.pennameId);
        p = clamp(p, 0, 0.9);
        candidates.push({ layer, outlet, p });
    }
    const pAny = 1 - candidates.reduce((acc, c) => acc * (1 - c.p), 1);
    if (candidates.length) why.push(`公开发表的意愿：${candidates.map(c => `${LAYERS[c.layer].label}${Math.round(c.p * 100)}%`).join('，')}（合计 ${Math.round(pAny * 100)}%）`);
    else why.push('没有可以发表的刊物栏目');

    let published = false;
    if (candidates.length && roll(seed, key + '|public') < pAny) {
        // 按权重选一种层级
        const total = candidates.reduce((a, c) => a + c.p, 0);
        let t = roll(seed, key + '|layer') * total;
        const pick = candidates.find(c => (t -= c.p) <= 0) || candidates[candidates.length - 1];
        const earliest = addDays(read.readDate, between(seed, key + '|write', WRITE_DAYS[pick.layer] || [1, 5]));
        // 提前读稿（编辑、朋友看校样）可以提前写好，但公开见报不能早于作品发表
        if (cmp(earliest, work.pubDate) < 0) { why.push(`${read.readDate} 提前读到稿子，可以先写，但要等 ${work.pubDate} 作品发表后才能见报`); }
        const writeReady = cmp(earliest, work.pubDate) < 0 ? work.pubDate : earliest;
        const close2 = addDays(work.pubDate, LAG_CLOSE[pick.outlet.periodicity] || 50);
        const slot = findSlot(state, s, pick.outlet, person, pick.layer, writeReady, close2);
        if (slot.date && s.publicBefore && cmp(slot.date, s.publicBefore) <= 0) {
            why.push(`想写${LAYERS[pick.layer].label}（约 ${slot.date} 见报），但这段时间的公开报道以已导入的记录为准 → 不另行推演，记为私下谈起`);
        } else if (slot.date) {
            why.push(`决定写${LAYERS[pick.layer].label}，约 ${writeReady} 可以交稿；${pick.outlet.name}截稿提前 ${slot.deadline} 天、每期至多 ${slot.cap} 篇 → 排在 ${slot.date}`);
            out.events.push({ layer: pick.layer, outletId: pick.outlet.id, date: slot.date, polarity: pick.layer === 'polemic' && op.polarity === 0 ? -1 : op.polarity, reactsTo: pick.layer === 'polemic' && via ? via.id : null });
            out.expression = 'public';
            published = true;
        } else {
            why.push(`想写${LAYERS[pick.layer].label}，但到 ${close2} 前${(slot.reasons || []).join('、') || '没有合适的出刊日'}已满 → 没能发表`);
            out.expression = 'blocked';
        }
    } else if (candidates.length) why.push('没有公开发表');

    // —— 私信 ——
    if (close >= 1) {
        const p = [0, 0.25, 0.5, 0.75][close] * (op.strength === 'strong' ? 1.2 : 0.8) * (s.layerMult?.private_letter ?? 1) * (published ? 0.5 : 1);
        if (roll(seed, key + '|letter') < p) {
            const date = addDays(read.readDate, between(seed, key + '|letterlag', WRITE_DAYS.private_letter));
            if (s.privateBefore && cmp(date, s.privateBefore) <= 0) {
                why.push(`本想写信（约 ${date}），但这段时间主角收到的信以书信簿/已导入的记录为准 → 不另行推演`);
                return finishSilent(out, why);
            }
            out.events.push({ layer: 'private_letter', outletId: null, date, polarity: op.polarity });
            why.push(`私交${['陌生', '认识', '朋友', '至交'][close]}，写信的概率 ${Math.round(p * 100)}% → 写了私信`);
            if (!published) out.expression = 'private_letter';
        } else why.push(`写信的概率 ${Math.round(p * 100)}% → 没写信`);
    }
    if (out.expression === 'silent') { out.expression = 'remark'; why.push('只在熟人圈里私下谈起'); }
    return out;
}

function finishSilent(out, why) {
    if (out.expression === 'silent') { out.expression = 'remark'; why.push('只在熟人圈里私下谈起'); }
    return out;
}

/** 一个人对一部作品走完四关。contactOverride 用于“看到评论才知道”和手动记录 */
function runPipeline(state, s, era, work, person, seed, report, opts = {}) {
    const { via, manualRead } = opts;
    let rec;
    if (manualRead) {
        rec = manualRead;
    } else {
        const extra = via ? { ch: 'review', p: 0.5, lag: [0, 3], from: via.date }
            : opts.seek ? { ch: 'seek', p: opts.seek.p, lag: [0, 1], from: opts.seek.date }
            : opts.recommend ? { ch: 'recommend', p: 0.6, lag: [0, 4], from: opts.recommend.date } : null;
        const c = contactStage(state, s, era, work, person, seed, extra);
        rec = {
            id: uid('rc'), key: `${work.id}|${person.id}${via ? '|via' : opts.seek ? '|seek' : opts.recommend ? '|rec' : ''}`, origin: 'engine', workId: work.id, personId: person.id,
            channel: c.best?.ch || null, contactDate: c.best?.date || null, read: c.best ? null : 'none',
            why: [...c.why], eventIds: [], opinion: null, viaEventId: via?.id || null,
        };
        if (c.best) {
            const r = readStage(state, s, era, work, person, c.best, seed + (via ? '|via' : opts.seek ? '|seek' : opts.recommend ? '|rec' : ''));
            rec.read = r.read; rec.readDate = r.readDate || null; rec.why.push(...r.why); rec.interest = r.interest;
        }
    }
    if (rec.read === 'skimmed' || rec.read === 'finished') {
        const read = { read: rec.read, readDate: rec.readDate, interest: rec.interest ?? interestOf(person, workTags(state, work)) };
        const op = opinionStage(state, work, person, read, seed);
        if (rec.known && rec.known.polarity != null) {
            op.polarity = rec.known.polarity;
            if (op.strength === 'none') op.strength = 'mild';
            op.why = [`已知他的态度（${rec.known.source || '记录'}）：${['偏批评', '褒贬参半', '偏肯定'][op.polarity + 1]}，${STRENGTH[op.strength]}`];
        }
        rec.polarity = op.polarity; rec.strength = op.strength; rec.why.push(...op.why);
        const ex = expressionStage(state, s, era, work, person, read, op, seed + (via ? '|via' : ''), via);
        rec.expression = ex.expression; rec.why.push(...ex.why);
        for (const e of ex.events) {
            const ev = {
                id: uid('ev'), key: `${rec.key}|${e.layer}`, origin: 'engine', date: e.date, layer: e.layer,
                personId: person.id, outletId: e.outletId, workId: work.id, pennameId: work.pennameId || null,
                polarity: e.polarity, status: 'scheduled', receptionId: rec.id, reactsTo: e.reactsTo || null,
                text: null, flags: [], repApplied: null, why: rec.why.slice(),
            };
            state.ledger.push(ev);
            rec.eventIds.push(ev.id);
            report.scheduled++;
        }
    }
    state.receptions.push(rec);
    report.receptions++;
    if (!opts.noSeek) seekStage(state, s, era, work, person, rec, seed, report);
    return rec;
}


// ———————————— 作者印象、追读与推荐 ————————————

/** 系列：手填的 series 优先；否则从书名里去掉“第一册”“（上）”“2”之类 */
export function seriesKey(work) {
    if (work.series) return work.series.trim();
    return String(work.title || '').replace(/[《》]/g, '').replace(/[\s·・]*(第[一二三四五六七八九十\d]+[册卷部集期回章篇]|[（(][^）)]*[）)]|[IVX]+|\d+|[上中下]篇?)$/g, '').trim();
}

/** 某人截至某日对某笔名的印象（-2 … 3）。每次阅读留下一条带日期的记录 */
export function impressionAt(state, pennameId, personId, date) {
    const list = state.impressions?.[pennameId]?.[personId] || [];
    let v = 0;
    for (const x of list) if (!date || cmp(x.date, date) <= 0) v += x.delta;
    return clamp(v, -2, 3);
}
export const IMPRESSION_LABEL = v => (v >= 2 ? '追读、欣赏' : v >= 1 ? '值得关注' : v >= 0.4 ? '有些好感' : v > -0.4 ? '没什么印象' : '印象不佳');

function addImpression(state, pennameId, personId, entry) {
    state.impressions = state.impressions || {};
    const pm = (state.impressions[pennameId] = state.impressions[pennameId] || {});
    (pm[personId] = pm[personId] || []).push(entry);
}

// ———————————— 人际传播 ————————————

/** 此人对外的关系：手填的关系，加上同一刊物的同事（没手填时按“每周见、一般熟”算） */
export function relationsOf(state, person) {
    const out = (person.relations || []).filter(r => r.to && r.to !== person.id).map(r => ({ ...r }));
    for (const q of state.persons || []) {
        if (q.id === person.id || out.some(r => r.to === q.id)) continue;
        if ((q.outletIds || []).some(id => (person.outletIds || []).includes(id))) out.push({ to: q.id, type: 'colleague', closeness: 1, frequency: 'weekly', trust: 0.5, implicit: true });
    }
    return out;
}
export function knowsPen(state, person, pennameId) {
    const pen = byId(state.pennames, pennameId);
    return !!(pen?.knownBy || []).includes(person.id);
}
const FREQ_P = { daily: 0.8, weekly: 0.6, monthly: 0.35, rare: 0.15 };
const FREQ_LAG = { daily: [0, 2], weekly: [1, 8], monthly: [5, 30], rare: [10, 60] };

/**
 * 读完以后会不会跟熟人谈起：看见面频率、亲疏、看法强弱。印象不深的不会特意提。
 * 谈起会让对方有机会接触作品（“熟人谈起或推荐”渠道）；肯定的推荐让人更想读，批评的反而少一点。
 * “知道”和“愿意说”是两回事：作者身份只在此人自己知道、且对这个人愿意透露时才可能说出去，
 * 而且不直接改数据，只记为“可能的知情扩散”，由你确认。
 */
function talkStage(state, s, era, work, person, rec, seed, report) {
    if (!['skimmed', 'finished'].includes(rec.read) || rec.strength === 'none' || !rec.readDate) return;
    const told = [];
    for (const rel of relationsOf(state, person)) {
        if (rel.discloseOpinions === false) continue;
        if ((rel.since && cmp(rec.readDate, rel.since) < 0) || (rel.until && cmp(rec.readDate, rel.until) > 0)) continue; // 那时还没认识 / 已经断了往来
        const q = byId(state.persons, rel.to);
        if (!q || q.active === false) continue;
        const freq = rel.frequency || 'monthly';
        const p = clamp((FREQ_P[freq] ?? 0.3) * (0.5 + 0.2 * (Number(rel.closeness) || 0)) * (rec.strength === 'strong' ? 1.3 : 0.8), 0, 0.9);
        const key = `${work.id}|${person.id}|talk|${q.id}`;
        if (roll(seed, key) >= p) continue;
        const date = addDays(rec.readDate, between(seed, key + '|lag', FREQ_LAG[freq] || [3, 20]));
        told.push(`${q.name}（${REL_TYPES[rel.type] || '熟人'}，约 ${date}）`);
        const had = (state.receptions || []).some(r => r.workId === work.id && r.personId === q.id && ['skimmed', 'finished'].includes(r.read));
        if (!had) {
            state.recommends = state.recommends || {};
            const box = (state.recommends[work.id] = state.recommends[work.id] || {});
            if (!box[q.id] || cmp(date, box[q.id].date) < 0) {
                box[q.id] = { date, by: person.id, byName: person.name, polarity: rec.polarity, p: rec.polarity === 1 ? 0.55 : rec.polarity === -1 ? 0.3 : 0.4 };
                const rk = `${work.id}|${q.id}|recommend`;
                if (state.rolls?.[`${work.id}|${q.id}`] && !state.rolls[rk]) {
                    state.rolls[rk] = { at: date };
                    const prev = (state.receptions || []).filter(r => r.workId === work.id && r.personId === q.id && r.origin !== 'manual');
                    const nr = runPipeline(state, s, era, work, q, seed, report, { recommend: { date, by: person } });
                    if (['skimmed', 'finished'].includes(nr.read)) for (const r of prev) r.superseded = nr.id;
                }
            }
        }
        // 身份
        if (work.pennameId && rel.discloseIdentity && knowsPen(state, person, work.pennameId) && !knowsPen(state, q, work.pennameId)) {
            const pl = 0.25 * (rel.trust ?? 0.5);
            if (roll(seed, key + '|identity') < pl) {
                state.identityLeaks = state.identityLeaks || [];
                if (!state.identityLeaks.some(x => x.pennameId === work.pennameId && x.to === q.id && x.status === 'pending')) {
                    state.identityLeaks.push({ id: uid('lk'), pennameId: work.pennameId, from: person.id, to: q.id, date, workId: work.id, status: 'pending' });
                    told.push(`（可能向${q.name}透露了作者身份，待确认）`);
                }
            }
        }
    }
    if (told.length) { rec.why.push(`和熟人谈起：${told.join('、')}`); rec.told = told.length; }
    else if (rec.expression === 'remark') { rec.expression = 'silent'; rec.why.push('没碰上合适的人谈起 → 放在心里'); }
}

/** 旧作还找不找得到：成书、小册子好买；旧报纸要去翻合订本 */
function seekAvailability(state, work, person) {
    const host = byId(state.outlets, work.outletId);
    if (host && (person.outletIds || []).includes(host.id)) return 0.9;
    if (['book', 'pamphlet', 'translation_book'].includes(work.form)) return 0.8;
    return { daily: 0.4, weekly: 0.55, biweekly: 0.65, monthly: 0.65 }[host?.periodicity] ?? 0.5;
}

/** 想不想读这一部：同系列最想；题材对得上此人兴趣、或与刚读的那部相近，次之；同署名但不相干的，兴趣有限 */
function seekAffinity(state, work, person, trigger) {
    if (trigger && seriesKey(trigger) && seriesKey(trigger) === seriesKey(work)) return 1;
    if (trigger && (work.parentId === trigger.id || trigger.parentId === work.id)) return 0.2; // 同一作品的另一版本，读过就不必再找
    const tags = workTags(state, work);
    const mine = matchCount([...(person.interests || []), ...(person.likes || [])], tags, true);
    const near = trigger ? matchCount(workTags(state, trigger), tags, true) : 0;
    return clamp(0.3 + 0.2 * Math.min(2, mine) + 0.15 * Math.min(2, near), 0, 0.95);
}

/**
 * 读完一部作品之后：
 *  ① 更新对这个笔名的“作者印象”（带日期，之后的推演只看当时为止的印象）；
 *  ② 印象够好时，可能去找这位作者的旧作——同系列最想找，旧报纸不一定找得到；没找到的记下来，以后再被勾起兴趣时会重试；
 *  ③ 看法强烈又肯定的，可能推荐给同一刊物的同事。
 * 每一步都只在当时的时间点上判断，可以中断，也可以在下一次阅读后重新开始。
 */
function seekStage(state, s, era, work, person, rec, seed, report) {
    if (!['skimmed', 'finished'].includes(rec.read) || !work.pennameId || !rec.readDate) return;
    const pen = byId(state.pennames, work.pennameId);
    const strong = rec.strength === 'strong' ? 1 : rec.strength === 'mild' ? 0.5 : 0;
    let delta = rec.polarity === 1 ? 0.6 + 0.4 * strong : rec.polarity === 0 ? 0.15 + 0.1 * strong : -0.5 - 0.3 * strong;
    if (rec.read === 'skimmed') delta *= 0.5;
    const before = impressionAt(state, work.pennameId, person.id, rec.readDate);
    addImpression(state, work.pennameId, person.id, { date: rec.readDate, delta: +delta.toFixed(2), workId: work.id });
    const after = impressionAt(state, work.pennameId, person.id, rec.readDate);
    rec.why.push(`对“${pen?.name || ''}”的印象：${IMPRESSION_LABEL(before)} → ${IMPRESSION_LABEL(after)}（${delta >= 0 ? '+' : ''}${delta.toFixed(2)}）`);

    talkStage(state, s, era, work, person, rec, seed, report);

    // 追读
    if (after < 0.5) return;
    const others = (state.works || []).filter(w => w.id !== work.id && w.pennameId === work.pennameId && w.pubDate && cmp(w.pubDate, rec.readDate) <= 0);
    state.followers = state.followers || {};
    const pf = (state.followers[work.pennameId] = state.followers[work.pennameId] || {});
    const key = `${work.pennameId}|${person.id}|seek|${work.id}`;
    const p = clamp(0.1 + 0.3 * (after - 0.5) + 0.1 * strong + 0.03 * (person.closeness || 0), 0, 0.8) * (isBusy(person, rec.readDate) ? 0.6 : 1);
    if (roll(seed, key) >= p) { rec.why.push(`想不想找这位作者的其他作品：概率 ${Math.round(p * 100)}% → 这次没有特意去找`); return; }
    const since = addDays(rec.readDate, between(seed, key + '|lag', [2, 15]));
    if (!pf[person.id] || cmp(since, pf[person.id]) < 0) pf[person.id] = since;
    rec.seek = since;
    const tried = [];
    for (const w of others) {
        const had = (state.receptions || []).some(r => r.workId === w.id && r.personId === person.id && ['skimmed', 'finished'].includes(r.read));
        if (had) continue;
        if (!state.rolls?.[`${w.id}|${person.id}`]) continue; // 还没轮到的，轮到时 contactStage 会按“主动去找”处理
        const rk = `${w.id}|${person.id}|seek|${work.id}`; // 每次被勾起兴趣都可以重试
        if (state.rolls[rk]) continue;
        state.rolls[rk] = { at: since };
        const want = seekAffinity(state, w, person, work);
        const avail = seekAvailability(state, w, person);
        if (roll(seed, rk + '|want') >= want) { tried.push(`《${w.title}》不太想看（${Math.round(want * 100)}%）`); continue; }
        if (roll(seed, rk + '|find') >= avail) { tried.push(`《${w.title}》想看但没找到（能找到的概率 ${Math.round(avail * 100)}%），以后可能再找`); continue; }
        tried.push(`《${w.title}》找到了`);
        const prev = (state.receptions || []).filter(r => r.workId === w.id && r.personId === person.id && r.origin !== 'manual');
        const nr = runPipeline(state, s, era, w, person, seed, report, { seek: { p: 1, date: addDays(since, between(seed, rk + '|lag', [0, 10])) } });
        if (['skimmed', 'finished'].includes(nr.read)) for (const r of prev) r.superseded = nr.id;
    }
    rec.why.push(`想不想找这位作者的其他作品：概率 ${Math.round(p * 100)}% → 约 ${since} 起开始留意这个署名${tried.length ? '；' + tried.join('；') : ''}`);
}

// ———————————— 推进 ————————————

export function advanceTo(state, newDate, settings, era) {
    useConcepts(state.concepts);
    const report = { newCandidates: [], autoApproved: [], revealed: [], scheduled: 0, receptions: 0, from: state.currentDate, to: newDate };
    if (!newDate) return report;
    if (!state.currentDate) state.currentDate = newDate;
    if (cmp(newDate, state.currentDate) < 0) return report;
    const s = { ...DEFAULT_ENGINE_SETTINGS, ...(settings || {}) };
    s.layerMult = { ...DEFAULT_ENGINE_SETTINGS.layerMult, ...(s.layerMult || {}) };
    const seed = state.seed || 'press-echo';
    const oldDate = state.currentDate;
    state.rolls = state.rolls || {};
    state.receptions = state.receptions || [];

    // ① 新发表的作品：每个人走一遍四关（整条链的日期一次算好，未到的标为排期）
    for (const work of state.works || []) {
        if (!work.pubDate || cmp(work.pubDate, newDate) > 0) continue;
        for (const person of state.persons || []) {
            if (person.active === false) continue;
            const key = `${work.id}|${person.id}`;
            if (state.rolls[key]) continue;
            // 已有手动记录或已确认事件：不重复推演
            const exist = state.ledger.some(e => e.workId === work.id && e.personId === person.id && e.origin === 'manual' && e.status !== 'rejected')
                || state.receptions.some(r => r.workId === work.id && r.personId === person.id && r.origin === 'manual');
            if (exist) { state.rolls[key] = { preexisting: true, at: newDate }; continue; }
            state.rolls[key] = { at: newDate };
            runPipeline(state, s, era, work, person, seed, report);
        }
    }

    // ② 回响：已批准的公开评论，让常读那份刊物、原本没接触到作品的人“因评论而知道原作”
    for (const ev of state.ledger) {
        if (ev.status !== 'approved' || !LAYERS[ev.layer]?.public || !ev.outletId || !ev.workId) continue;
        if (cmp(ev.date, newDate) > 0) continue;
        const work = byId(state.works, ev.workId);
        if (!work) continue;
        for (const person of state.persons || []) {
            if (person.active === false || person.id === ev.personId) continue;
            const key = `${work.id}|${person.id}|via|${ev.id}`;
            if (state.rolls[key]) continue;
            const had = state.receptions.some(r => r.workId === work.id && r.personId === person.id && ['skimmed', 'finished', 'ignored'].includes(r.read));
            if (had || !readsOutlets(state, person).has(ev.outletId)) continue;
            state.rolls[key] = { at: newDate };
            runPipeline(state, s, era, work, person, seed, report, { via: ev });
        }
    }

    // ③ 汇总类：读者来信、各报转载提及
    for (const work of state.works || []) {
        if (!work.pubDate || cmp(work.pubDate, newDate) > 0) continue;
        const host = byId(state.outlets, work.outletId);
        const ref = work.endDate && cmp(work.endDate, newDate) <= 0 ? work.endDate : work.pubDate;
        if (host && outletSections(host).includes('reader_letters')) {
            const key = `${work.id}|readers`;
            const due = addDays(ref, 2);
            if (!state.rolls[key] && cmp(due, newDate) <= 0 && skipAggregate(state, s, key, 'reader_letters', work, due, newDate)) { /* 已有记录 */ }
            else if (!state.rolls[key] && cmp(due, newDate) <= 0) {
                const tierBase = { 1: 3, 2: 8, 3: 20, 4: 45, 5: 90 }[host.tier || 3];
                const formF = { serial: 1, translation_serial: 0.8, article: 0.6, book: 0.3, translation_book: 0.3, pamphlet: 0.2 }[work.form] ?? 0.5;
                const r = roll(seed, key);
                const count = Math.round(tierBase * formF * fameFactor(state, work.pennameId) * (0.5 + r) * seasonFactor(era, due));
                state.rolls[key] = { count, at: newDate };
                if (count >= 1) pushAggregate(state, report, { key, layer: 'reader_letters', date: due, outletId: host.id, work, count, why: [`《${host.name}》影响力 ${host.tier || 3} 级 × ${FORMS[work.form]} × 名气 × 季节 → 约 ${count} 封`] });
            }
        }
        const mkey = `${work.id}|mentions`;
        const mdue = addDays(ref, 7);
        if (!state.rolls[mkey] && cmp(mdue, newDate) <= 0 && skipAggregate(state, s, mkey, 'mentions', work, mdue, newDate)) { /* 已有记录 */ }
        else if (!state.rolls[mkey] && cmp(mdue, newDate) <= 0) {
            const base = { serial: 3, translation_serial: 3, article: 2, book: 4, translation_book: 4, pamphlet: 2 }[work.form] ?? 2;
            const tierF = { 1: 0.5, 2: 0.7, 3: 1, 4: 1.3, 5: 1.6 }[host?.tier || 3];
            const r = roll(seed, mkey);
            const count = Math.round(base * tierF * fameFactor(state, work.pennameId) * (0.4 + 1.2 * r) * seasonFactor(era, mdue));
            state.rolls[mkey] = { count, at: newDate };
            if (count >= 1) pushAggregate(state, report, { key: mkey, layer: 'mentions', date: mdue, outletId: null, work, count, why: [`${FORMS[work.form]} × 发表刊物影响力 × 名气 × 季节 → 约 ${count} 条转载/提及（不计为独立评论）`] });
        }
    }

    // ④ 到期的排期事件揭晓，并按等级自动通过
    for (const ev of state.ledger) {
        if (ev.status === 'scheduled' && cmp(ev.date, newDate) <= 0) {
            ev.status = 'candidate';
            report.revealed.push(ev);
            report.newCandidates.push(ev);
        }
    }
    report.reapplied = reapplyDecisions(state, report.newCandidates);
    if (s.autoApprove === 'minor') {
        for (const ev of report.newCandidates) {
            if (ev.status === 'candidate' && !isMajor(state, ev)) { ev.status = 'approved'; ev.auto = true; report.autoApproved.push(ev); }
        }
    }
    recomputeReputation(state);
    updateRumors(state, oldDate, newDate, s);
    state.currentDate = newDate;
    state.ledger.sort((a, b) => cmp(a.date, b.date));
    return report;
}

/** 汇总类已有手动/导入记录，或落在“以记录为准”的时期内：不再推演，记下原因 */
function skipAggregate(state, s, key, layer, work, due, newDate) {
    const manual = state.ledger.some(e => e.origin === 'manual' && e.layer === layer && e.workId === work.id && e.status !== 'rejected');
    const before = s.publicBefore && cmp(due, s.publicBefore) <= 0;
    if (!manual && !before) return false;
    state.rolls[key] = { skipped: manual ? 'manual' : 'before', at: newDate };
    return true;
}

function pushAggregate(state, report, { key, layer, date, outletId, work, count, why }) {
    const ev = {
        id: uid('ev'), key, origin: 'engine', date, layer, personId: null, outletId, workId: work.id,
        pennameId: work.pennameId || null, polarity: 0, count, status: 'candidate', text: null, flags: [], repApplied: null, why,
    };
    state.ledger.push(ev);
    report.newCandidates.push(ev);
}

/** 根据书信等线索手动记录“某人某日读过某作品”，并从这里继续推演看法与表达 */
export function recordManualReading(state, settings, era, { workId, personId, date, read = 'finished', note = '', known = null }) {
    useConcepts(state.concepts);
    const work = byId(state.works, workId);
    const person = byId(state.persons, personId);
    if (!work || !person || !normalizeISO(date)) throw new Error('作品、人物或日期无效');
    // 撤掉引擎为这对组合生成、尚未批准的内容
    const oldRecs = state.receptions.filter(r => r.workId === workId && r.personId === personId && r.origin !== 'manual');
    const oldIds = new Set(oldRecs.flatMap(r => r.eventIds || []));
    state.ledger = state.ledger.filter(e => !(oldIds.has(e.id) && e.status !== 'approved'));
    state.receptions = state.receptions.filter(r => !oldRecs.includes(r));
    const s = { ...DEFAULT_ENGINE_SETTINGS, ...(settings || {}) };
    const rec = {
        id: uid('rc'), key: `${workId}|${personId}|manual`, origin: 'manual', workId, personId, channel: 'manual',
        contactDate: normalizeISO(date), read, readDate: normalizeISO(date), why: [`手动记录：${note || '来自书信或剧情'}`], eventIds: [], opinion: null,
        interest: interestOf(person, workTags(state, work)),
        known: known || null, // 已知他的态度（例如他写过的书评）：看法按这个定，不再随机
    };
    const report = { scheduled: 0, receptions: 0 };
    state.rolls[`${workId}|${personId}`] = { manual: true };
    runPipeline(state, s, era, work, person, state.seed, report, { manualRead: rec });
    // 已经过去的日期：立即揭晓
    for (const id of rec.eventIds) {
        const ev = state.ledger.find(e => e.id === id);
        if (ev && state.currentDate && cmp(ev.date, state.currentDate) <= 0) ev.status = 'candidate';
    }
    recomputeReputation(state);
    return rec;
}

// ———————————— 传闻 ————————————

export function updateRumors(state, oldDate, newDate, s) {
    state.rumors = state.rumors || [];
    const days = Math.max(0, diffDays(newDate, oldDate || newDate));
    const half = s.rumorHalfLife || 21;
    for (const r of state.rumors) {
        if (r.pinned) continue;
        r.strength = +(r.strength * Math.pow(0.5, days / half)).toFixed(3);
        r.lastDate = newDate;
    }
    for (const pen of state.pennames || []) {
        if (pen.publicIdentityKnown) continue;
        const works = (state.works || []).filter(w => w.pennameId === pen.id && w.pubDate && cmp(w.pubDate, newDate) <= 0);
        const circles = new Set(works.map(w => byId(state.outlets, w.outletId)?.circle || w.outletId).filter(Boolean));
        let rumor = state.rumors.find(r => r.kind === 'identity' && r.pennameId === pen.id);
        if (!rumor && circles.size >= 2) {
            rumor = {
                id: uid('rm'), kind: 'identity', pennameId: pen.id, strength: 0.5, lastDate: newDate, pinned: false,
                text: `坊间开始猜测：分别刊在不同圈子的几篇署名“${pen.name}”的作品，是否出自同一人；作者真实身份众说纷纭。`,
            };
            state.rumors.push(rumor);
        }
        if (rumor) {
            const fresh = works.filter(w => oldDate && cmp(w.pubDate, oldDate) > 0).length;
            if (fresh) rumor.strength = +Math.min(1, rumor.strength + 0.2 * fresh).toFixed(3);
        }
    }
    state.rumors = state.rumors.filter(r => r.pinned || r.strength >= 0.05);
}

// ———————————— 其他 ————————————

/** 作品资料改了以后，撤掉这部作品尚未批准的推演，下次推进时重算 */
export function rerollWork(state, workId) {
    for (const k of Object.keys(state.rolls || {})) if (k.startsWith(workId + '|')) delete state.rolls[k];
    const keepRec = r => r.workId !== workId || r.origin === 'manual';
    const dropEv = new Set((state.receptions || []).filter(r => !keepRec(r)).flatMap(r => r.eventIds || []));
    state.ledger = state.ledger.filter(e => !(e.workId === workId && e.origin === 'engine' && e.status !== 'approved' && (dropEv.has(e.id) || !e.receptionId)));
    state.receptions = (state.receptions || []).filter(keepRec);
    recomputeReputation(state);
}

export function knownToUser(state, ev) {
    if (ev.status !== 'approved') return false;
    if (state.currentDate && cmp(ev.date, state.currentDate) > 0) return false;
    return true;
}

export { LAG_CLOSE, DEFAULT_CAPACITY, DEFAULT_DEADLINE };

// ———————————— 回溯推演 ————————————

/**
 * 从最早的作品发表日起，把之前没推演过的经过补上，一直推到当前故事日期。
 * mode = 'hidden'：已导入/已确认的记录视为当时的全部公开报道和来信，只补“看不见的部分”
 *                 （谁读了、私下怎么看、圈子里怎么谈），以及落在当前日期之后、对旧作的后续反响；
 * mode = 'all'   ：公开报道和私信也补，全部作为“回溯”候选，逐条审核，不自动入账。
 * 会清掉之前推演出的、尚未入账的内容；手动/导入的记录和你已入账的都保留。
 */
export function backfill(state, settings, era, { mode = 'hidden' } = {}) {
    useConcepts(state.concepts);
    const target = state.currentDate;
    const pubs = (state.works || []).map(w => w.pubDate).filter(Boolean).sort();
    if (!target || !pubs.length) throw new Error('需要先有故事日期和至少一部有发表日期的作品');
    const first = pubs[0];
    if (cmp(first, target) > 0) throw new Error('作品都还没发表，不需要回溯');
    const removed = state.ledger.filter(e => e.origin === 'engine' && e.status !== 'approved').length;
    state.ledger = state.ledger.filter(e => e.origin !== 'engine' || e.status === 'approved');
    const keepRecIds = new Set(state.ledger.flatMap(e => (e.receptionId ? [e.receptionId] : [])));
    const manualRecs = (state.receptions || []).filter(r => r.origin === 'manual');
    state.receptions = (state.receptions || []).filter(r => r.origin !== 'manual' && keepRecIds.has(r.id));
    state.rolls = Object.fromEntries(Object.entries(state.rolls || {}).filter(([, v]) => v?.manual));
    state.followers = {};
    state.impressions = {};
    state.recommends = {};
    state.identityLeaks = (state.identityLeaks || []).filter(x => x.status !== 'pending');
    const savedRumors = JSON.parse(JSON.stringify(state.rumors || []));
    const before = new Set(state.ledger.map(e => e.id));
    const s = { ...settings, autoApprove: 'none' };
    if (mode === 'hidden') { s.publicBefore = target; s.privateBefore = target; }
    state.currentDate = addDays(first, -1);
    // 手动/导入的阅读记录：保留“读过”这一事实，看法和表达按回溯规则重算
    const seed = state.seed || 'press-echo';
    const rep0 = { scheduled: 0, receptions: 0 };
    for (const rec of manualRecs) {
        const work = byId(state.works, rec.workId), person = byId(state.persons, rec.personId);
        if (!work || !person) { state.receptions.push(rec); continue; }
        rec.why = rec.why.filter(w => w.startsWith('手动记录'));
        rec.eventIds = (rec.eventIds || []).filter(id => state.ledger.some(e => e.id === id));
        state.rolls[`${work.id}|${person.id}`] = { manual: true };
        runPipeline(state, s, era, work, person, seed, rep0, { manualRead: rec });
    }
    // 按周推进，让名气、回响随时间累积，而不是一下子用九月的名气去推四月的事
    let d = state.currentDate;
    while (cmp(d, target) < 0) {
        d = addDays(d, 7);
        if (cmp(d, target) > 0) d = target;
        advanceTo(state, d, s, era);
    }
    const added = state.ledger.filter(e => !before.has(e.id));
    for (const e of added) e.backfill = true;
    state.rumors = savedRumors;
    state.snapshots = [];
    const recs = state.receptions.filter(r => r.origin !== 'manual');
    const cnt = k => recs.filter(r => r.read === k).length;
    return {
        mode, from: first, to: target, removed,
        candidates: added.filter(e => e.status === 'candidate').length,
        scheduled: added.filter(e => e.status === 'scheduled').length,
        receptions: recs.length, finished: cnt('finished'), skimmed: cnt('skimmed'), ignored: cnt('ignored'),
        remarks: recs.filter(r => r.expression === 'remark').length,
    };
}

// ———————————— 预演（不改动数据） ————————————

/**
 * 在数据副本上反复推演，估计概率。不会改动 state。
 * opts.workId：推演这部作品（可改 outletId / pubDate 做“假如投给某刊”）
 * opts.personId：只看这个人
 * opts.readDate：配合 workId + personId，“假如此人在这天读到这部作品”
 */
export function simulate(state, settings, era, { workId, personId = null, outletId = null, pubDate = null, readDate = null, runs = 40, until = null } = {}) {
    useConcepts(state.concepts);
    const s = { ...DEFAULT_ENGINE_SETTINGS, ...(settings || {}), autoApprove: 'none' };
    s.layerMult = { ...DEFAULT_ENGINE_SETTINGS.layerMult, ...(s.layerMult || {}) };
    const base = deepClone(state);
    const work = byId(base.works, workId);
    if (!work) throw new Error('找不到作品');
    if (outletId !== null) work.outletId = outletId;
    if (pubDate) work.pubDate = pubDate;
    if (!work.pubDate) throw new Error('请给出发表日期');
    // 清掉这部作品原有的推演，只保留手动/导入的
    base.ledger = base.ledger.filter(e => !(e.workId === work.id && e.origin === 'engine' && e.status !== 'approved'));
    base.receptions = (base.receptions || []).filter(r => !(r.workId === work.id && r.origin !== 'manual'));
    for (const k of Object.keys(base.rolls || {})) if (k.startsWith(work.id + '|')) delete base.rolls[k];
    const persons = (base.persons || []).filter(p => p.active !== false && (!personId || p.id === personId));
    const agg = {};
    const sample = {};
    for (const p of persons) agg[p.id] = { contact: 0, read: 0, finished: 0, pos: 0, mid: 0, neg: 0, strong: 0, public: 0, letter: 0, seek: 0, layers: {}, outlets: {}, firstDates: [], alsoRead: {} };
    const outletCount = {};
    let totalPublic = 0, totalLetters = 0;
    for (let i = 0; i < runs; i++) {
        const st = deepClone(base);
        const seed = (state.seed || 'press-echo') + (i ? `#sim${i}` : '');
        const before = new Set(st.ledger.map(e => e.id));
        const beforeRec = new Set(st.receptions.map(r => r.id));
        const rep = { scheduled: 0, receptions: 0 };
        for (const p of persons) {
            const person = byId(st.persons, p.id);
            const w = byId(st.works, work.id);
            if (st.receptions.some(r => r.workId === w.id && r.personId === person.id && r.origin === 'manual') && !readDate) continue;
            if (readDate) {
                const rec = { id: uid('rc'), key: `${w.id}|${person.id}|manual`, origin: 'manual', workId: w.id, personId: person.id, channel: 'manual',
                    contactDate: readDate, read: 'finished', readDate, why: ['假设：此人在这天读完'], eventIds: [], opinion: null, interest: interestOf(person, workTags(st, w)) };
                st.receptions = st.receptions.filter(r => !(r.workId === w.id && r.personId === person.id));
                runPipeline(st, s, era, w, person, seed, rep, { manualRead: rec });
            } else {
                st.rolls[`${w.id}|${person.id}`] = { sim: true };
                runPipeline(st, s, era, w, person, seed, rep);
            }
        }
        for (const r of st.receptions) {
            if (beforeRec.has(r.id)) continue;
            if (until && r.contactDate && cmp(r.contactDate, until) > 0) continue;
            if (until && r.readDate && cmp(r.readDate, until) > 0) { if (r.workId === work.id && agg[r.personId]) agg[r.personId].contact++; continue; }
            const a = agg[r.personId];
            if (!a) continue;
            if (r.workId === work.id) {
                if (r.read && r.read !== 'none') a.contact++;
                if (['skimmed', 'finished'].includes(r.read)) {
                    a.read++;
                    if (r.read === 'finished') a.finished++;
                    if (r.polarity === 1) a.pos++; else if (r.polarity === -1) a.neg++; else a.mid++;
                    if (r.strength === 'strong') a.strong++;
                    if (r.readDate) a.firstDates.push(r.readDate);
                }
                if (r.seek) a.seek++;
                if (i === 0) sample[r.personId] = r;
            } else if (['skimmed', 'finished'].includes(r.read)) {
                a.alsoRead[r.workId] = (a.alsoRead[r.workId] || 0) + 1;
            }
        }
        for (const e of st.ledger) {
            if (before.has(e.id) || e.workId !== work.id) continue;
            if (until && cmp(e.date, until) > 0) continue;
            const a = agg[e.personId];
            if (!a) continue;
            if (LAYERS[e.layer]?.public) {
                a.public++; totalPublic++;
                a.layers[e.layer] = (a.layers[e.layer] || 0) + 1;
                if (e.outletId) { a.outlets[e.outletId] = (a.outlets[e.outletId] || 0) + 1; outletCount[e.outletId] = (outletCount[e.outletId] || 0) + 1; }
            } else if (e.layer === 'private_letter') { a.letter++; totalLetters++; }
        }
    }
    const pct = n => n / runs;
    const rows = persons.map(p => {
        const a = agg[p.id];
        const top = (o) => Object.entries(o).sort((x, y) => y[1] - x[1])[0]?.[0] || null;
        const dates = a.firstDates.sort();
        return {
            personId: p.id, name: p.name,
            contact: pct(a.contact), read: pct(a.read), finished: pct(a.finished),
            pos: a.read ? a.pos / a.read : 0, mid: a.read ? a.mid / a.read : 0, neg: a.read ? a.neg / a.read : 0, strong: a.read ? a.strong / a.read : 0,
            public: pct(a.public), letter: pct(a.letter), seek: pct(a.seek),
            layer: top(a.layers), outletId: top(a.outlets),
            medianRead: dates.length ? dates[Math.floor(dates.length / 2)] : null,
            alsoRead: Object.entries(a.alsoRead).map(([wid, n]) => ({ workId: wid, p: pct(n) })).sort((x, y) => y.p - x.p),
            sample: sample[p.id] || null,
        };
    }).sort((x, y) => y.read - x.read || y.contact - x.contact);
    return {
        runs, until, workId: work.id, outletId: work.outletId, pubDate: work.pubDate,
        expectReaders: rows.reduce((n, r) => n + r.read, 0),
        expectContact: rows.reduce((n, r) => n + r.contact, 0),
        expectPublic: totalPublic / runs, expectLetters: totalLetters / runs,
        expectSeekers: rows.reduce((n, r) => n + r.seek, 0),
        outlets: Object.entries(outletCount).map(([id, n]) => ({ outletId: id, n: n / runs })).sort((a, b) => b.n - a.n),
        rows,
    };
}
