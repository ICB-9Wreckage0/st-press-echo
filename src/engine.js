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
import { overlapCount, clamp, uid } from './util.js';

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
export const STRENGTH = { none: '没什么看法', mild: '有些看法', strong: '看法强烈' };
export const EXPRESSION = {
    silent: '沉默',
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
    return clamp((overlapCount(pool, tags) / Math.max(1, tags.length)) * 2, 0, 1);
}

/** 立场：欣赏/反感标签对作品标签（含发表刊物的倾向）的重叠 */
export function computePolarity(state, person, work, r, layer) {
    const tags = workTags(state, work);
    const likes = overlapCount(person.likes, tags);
    const dislikes = overlapCount(person.dislikes, tags);
    if (layer === 'polemic' && dislikes > likes) return -1;
    const score = likes - dislikes + (r - 0.5);
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
    const add = (ch, p, lag) => channels.push({ ch, p, lag });
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
    }

    const key = `${work.id}|${person.id}|contact${extra ? '|' + extra.ch : ''}`;
    let best = null;
    for (const c of channels) {
        const r = roll(seed, `${key}|${c.ch}`);
        const hit = r < c.p;
        why.push(`${CHANNELS[c.ch]}：概率 ${Math.round(c.p * 100)}%，${hit ? '接触到了' : '没接触到'}`);
        if (!hit) continue;
        const base = extra && c.ch === extra.ch ? extra.from : work.pubDate;
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
    const likes = overlapCount(person.likes, tags);
    const dislikes = overlapCount(person.dislikes, tags);
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
        const dislikes = overlapCount(person.dislikes, workTags(state, work));
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
        const close2 = addDays(work.pubDate, LAG_CLOSE[pick.outlet.periodicity] || 50);
        const slot = findSlot(state, s, pick.outlet, person, pick.layer, earliest, close2);
        if (slot.date) {
            why.push(`决定写${LAYERS[pick.layer].label}，约 ${earliest} 写完；${pick.outlet.name}截稿提前 ${slot.deadline} 天、每期至多 ${slot.cap} 篇 → 排在 ${slot.date}`);
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
            out.events.push({ layer: 'private_letter', outletId: null, date, polarity: op.polarity });
            why.push(`私交${['陌生', '认识', '朋友', '至交'][close]}，写信的概率 ${Math.round(p * 100)}% → 写了私信`);
            if (!published) out.expression = 'private_letter';
        } else why.push(`写信的概率 ${Math.round(p * 100)}% → 没写信`);
    }
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
        const extra = via ? { ch: 'review', p: 0.5, lag: [0, 3], from: via.date } : null;
        const c = contactStage(state, s, era, work, person, seed, extra);
        rec = {
            id: uid('rc'), key: `${work.id}|${person.id}${via ? '|via' : ''}`, origin: 'engine', workId: work.id, personId: person.id,
            channel: c.best?.ch || null, contactDate: c.best?.date || null, read: c.best ? null : 'none',
            why: [...c.why], eventIds: [], opinion: null, viaEventId: via?.id || null,
        };
        if (c.best) {
            const r = readStage(state, s, era, work, person, c.best, seed + (via ? '|via' : ''));
            rec.read = r.read; rec.readDate = r.readDate || null; rec.why.push(...r.why); rec.interest = r.interest;
        }
    }
    if (rec.read === 'skimmed' || rec.read === 'finished') {
        const read = { read: rec.read, readDate: rec.readDate, interest: rec.interest ?? interestOf(person, workTags(state, work)) };
        const op = opinionStage(state, work, person, read, seed);
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
    return rec;
}

// ———————————— 推进 ————————————

export function advanceTo(state, newDate, settings, era) {
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
            if (!state.rolls[key] && cmp(due, newDate) <= 0) {
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
        if (!state.rolls[mkey] && cmp(mdue, newDate) <= 0) {
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

function pushAggregate(state, report, { key, layer, date, outletId, work, count, why }) {
    const ev = {
        id: uid('ev'), key, origin: 'engine', date, layer, personId: null, outletId, workId: work.id,
        pennameId: work.pennameId || null, polarity: 0, count, status: 'candidate', text: null, flags: [], repApplied: null, why,
    };
    state.ledger.push(ev);
    report.newCandidates.push(ev);
}

/** 根据书信等线索手动记录“某人某日读过某作品”，并从这里继续推演看法与表达 */
export function recordManualReading(state, settings, era, { workId, personId, date, read = 'finished', note = '' }) {
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
