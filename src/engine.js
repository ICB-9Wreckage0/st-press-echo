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
import { matchCount, useConcepts, tagSim } from './concepts.js';
import { factLeakCandidates } from './perception.js';

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

export const READ_STATES = { none: '未接触', ignored: '接触但没读', skimmed: '浏览/读了一部分', finished: '读完', unknown: '读过，程度不详' };
/** 算“读过”的阅读程度 */
export const READ_DONE = ['skimmed', 'finished', 'unknown'];
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
    if (!rec || !READ_DONE.includes(rec.read)) return 'unread';
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
    browse: '偶尔翻到这份大报（没登记常读刊物，按可能接触算）',
    shelf: '书店、图书馆或沙龙里碰到（成书长期流通）',
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
    if (id == null || id === '') return null; // 没有 id 的不匹配任何东西，免得都算到第一条头上
    return (list || []).find(x => x.id === id) || null;
}

export function outletSections(o) {
    if (o && Array.isArray(o.sections) && o.sections.length) return o.sections;
    return DEFAULT_SECTIONS[o?.periodicity] || DEFAULT_SECTIONS.irregular;
}

export function workTags(state, work) {
    const host = byId(state.outlets, work.outletId);
    return [...(work.themes || []), ...(work.claims || []).map(c => c?.issue).filter(Boolean), ...(host?.politics || [])];
}

// ———————————— 议题立场：人物的立场 × 作品的主张 ————————————

export const SIDES = { pro: '支持', con: '反对', mixed: '有保留' };
export const STANCE_STRENGTH = { 1: '低', 2: '中', 3: '高' };
export const TOLERANCE = { 1: '难以容忍', 2: '视情况', 3: '宽容' };
const sideKey = v => { const t = String(v ?? '').trim().toLowerCase(); return ['pro', 'con', 'mixed'].includes(t) ? t : /反对|against|contre|con/.test(t) ? 'con' : /保留|折中|部分|mixed|partial|nuanc/.test(t) ? 'mixed' : /支持|赞成|for|pour|pro/.test(t) ? 'pro' : ''; };
export const normSide = sideKey;
export const normStrength = v => { const n = Number(v); if ([1, 2, 3].includes(n)) return n; const t = String(v ?? ''); return /高|强|high|strong/i.test(t) ? 3 : /低|弱|low|weak/i.test(t) ? 1 : 2; };

/**
 * 对照人物立场与作品主张。只比同一议题（或语义归为一组的议题）。
 * 同向 +0.4×强度；相反 −0.45×强度；一方“有保留”= 部分赞同、有分歧（立场越强越不满意折中）。
 */
export function stanceMatch(state, person, work) {
    useConcepts(state.concepts);
    const out = { score: 0, agree: [], disagree: [], partial: [], weight: 0 };
    for (const c of work.claims || []) {
        const cs = sideKey(c?.side);
        if (!c?.issue || !cs) continue;
        let best = null, sim = 0;
        for (const st of person.stances || []) {
            const v = tagSim(st?.issue, c.issue, false);
            if (v > sim) { sim = v; best = st; }
        }
        if (!best || sim < 0.75) continue;
        const ps = sideKey(best.side); if (!ps) continue;
        const w = normStrength(best.strength);
        const label = `${c.issue}${c.note ? `（作品：${c.note}）` : ''}`;
        let d;
        if (ps === cs) { d = 0.4 * w; out.agree.push(label); }
        else if (ps === 'mixed' || cs === 'mixed') { d = (2 - w) * 0.25; out.partial.push(label); }
        else { d = -0.45 * w; out.disagree.push(label); }
        out.score += d * sim;
        out.weight = Math.max(out.weight, w);
    }
    return out;
}

/** 一句话描述思想上的对照结果（写进“为什么”和提示词） */
export function stanceText(m) {
    if (!m || (!m.agree.length && !m.disagree.length && !m.partial.length)) return '';
    const parts = [];
    if (m.agree.length) parts.push(`赞同：${m.agree.join('；')}`);
    if (m.partial.length) parts.push(`部分赞同、有分歧：${m.partial.join('；')}`);
    if (m.disagree.length) parts.push(`反对：${m.disagree.join('；')}`);
    return parts.join('。');
}

/** 确定常读的刊物：手填的“常读”加上自己供稿的 */
export function readsOutlets(state, person) {
    return new Set([...(person.reads || []), ...(person.outletIds || [])]);
}
/** 可能翻到的大报：没填“常读”的人，影响力 4 级以上的大报有时会翻到（概率比常读低得多） */
export function mayBrowse(state, person) {
    if (person.reads?.length) return new Set();
    const mine = readsOutlets(state, person);
    return new Set((state.outlets || []).filter(o => (o.tier || 3) >= 4 && !mine.has(o.id)).map(o => o.id));
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
        if (per === 'irregular' && outlet.issueDates?.length) { if (outlet.issueDates.includes(d)) out.push(d); }
        else if (per === 'daily' || per === 'irregular') out.push(d);
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
    const pool = [...(person.interests || []), ...(person.likes || []), ...(person.dislikes || []), ...(person.stances || []).map(x => x?.issue).filter(Boolean)];
    return clamp((matchCount(pool, tags, true) / Math.max(1, tags.length)) * 2, 0, 1);
}

/** 立场：欣赏/反感标签对作品标签（含发表刊物的倾向）的重叠 */
export function computePolarity(state, person, work, r, layer) {
    useConcepts(state.concepts);
    const tags = workTags(state, work);
    const likes = matchCount(person.likes, tags, false);
    const dislikes = matchCount(person.dislikes, tags, false);
    const ideas = stanceMatch(state, person, work).score;
    if (layer === 'polemic' && (dislikes > likes || ideas < -0.5)) return -1;
    // 标签重叠与议题立场是主因；私交深的人下笔更宽厚；剩下交给运气（没有任何重叠时，约八分之一偏好、八分之一偏坏）
    const score = likes - dislikes + ideas + 0.15 * (Number(person.closeness) || 0) + (r - 0.5) * 1.6;
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

/** 每次掷骰编一个递增序号：回滚时只需记下“当时编到第几号”，不用复制整张表 */
export function nextRollQ(state) { state.rollSeq = (state.rollSeq || 0) + 1; return state.rollSeq; }

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
    } else if (host && mayBrowse(state, person).has(host.id)) {
        add('browse', (host.tier || 3) >= 5 ? 0.3 : 0.2, [0, 4]);
    }
    if (!extra) {
        const close = person.closeness || 0;
        if (close >= 2 || knowsPen(state, person, work.pennameId)) add('friend', close >= 3 ? 0.8 : 0.6, [2, 10]);
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
        const prev = (state.receptions || []).find(r => r.workId === work.parentId && r.personId === person.id && READ_DONE.includes(r.read));
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
    const sm = stanceMatch(state, person, work);
    // 碰到他在意的议题（无论赞成反对），想法都会更强烈
    const stake = sm.agree.length + sm.disagree.length + sm.partial.length ? 0.25 * sm.weight : 0;
    let score = read.interest * 1.2 + 0.5 * (likes + dislikes) + stake + (read.read === 'finished' ? 0.3 : 0) + roll(seed, key) * 0.6;
    let strength = score < 0.6 ? 'none' : score < 1.3 ? 'mild' : 'strong';
    if (read.read === 'skimmed' && strength === 'strong') strength = 'mild';
    const why = [`欣赏点重叠 ${likes}、反感点重叠 ${dislikes}${sm.score ? `、议题立场 ${sm.score > 0 ? '+' : ''}${Math.round(sm.score * 100) / 100}` : ''} → ${['偏批评', '褒贬参半', '偏肯定'][polarity + 1]}，${STRENGTH[strength]}`];
    const st = stanceText(sm);
    if (st) why.push('思想对照：' + st);
    const ideas = sm.agree.length || sm.disagree.length || sm.partial.length ? { agree: sm.agree, disagree: sm.disagree, partial: sm.partial } : null;
    return { polarity, strength, why, ideas };
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
        if (knowsPen(state, person, work.pennameId) && close >= 2) p *= 0.7;
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
            out.events.push({ layer: pick.layer, outletId: pick.outlet.id, date: slot.date, polarity: pick.layer === 'polemic' && op.polarity === 0 ? -1 : op.polarity, reactsTo: pick.layer === 'polemic' && via ? via.id : null, irregular: pick.outlet.periodicity === 'irregular' && !pick.outlet.issueDates?.length });
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
// ———————————— 长尾：成书在发表后持续流通 ————————————

const SHELF_BASE = { book: 0.05, translation_book: 0.05, pamphlet: 0.035 };
/** 这部作品是否长期流通：作品里手动指定的优先，否则成书、译本单行本、小册子算 */
export function onShelf(work) {
    if (work.shelf === 'no') return false;
    if (work.shelf === 'yes') return true;
    return work.form in SHELF_BASE;
}
const monthStarts = (from, to) => {
    const out = []; let y = +from.slice(0, 4), m = +from.slice(5, 7);
    for (;;) { m++; if (m > 12) { m = 1; y++; } const d = `${y}-${String(m).padStart(2, '0')}-01`; if (cmp(d, to) > 0) break; out.push(d); }
    return out;
};
/** 话题带动：某月之前 60 天内，这个署名有多少篇已见报的评论、论战、转载（不论评哪部作品） */
function penBuzz(state, pennameId, date) {
    const from = addDays(date, -60);
    const evs = (state.ledger || []).filter(e => e.status === 'approved' && e.pennameId === pennameId && LAYERS[e.layer]?.public
        && cmp(e.date, from) >= 0 && cmp(e.date, date) < 0);
    let n = 0; const byWork = {};
    for (const e of evs) { const w = e.layer === 'mentions' ? Math.min(2, (e.count || 0) / 10) : e.layer === 'polemic' ? 1.5 : 1; n += w; byWork[e.workId] = (byWork[e.workId] || 0) + w; }
    const top = Object.entries(byWork).sort((a, b) => b[1] - a[1])[0];
    return { n, topWorkId: top?.[0] || null };
}

function shelfStage(state, s, era, seed, newDate, report) {
    for (const work of state.works || []) {
        if (!work.pubDate || cmp(work.pubDate, newDate) > 0 || !onShelf(work)) continue;
        const until = work.shelfUntil && cmp(work.shelfUntil, newDate) < 0 ? work.shelfUntil : newDate;
        const months = monthStarts(work.pubDate, until);
        if (!months.length) continue;
        const versions = new Set([work.id, work.parentId, ...(state.works || []).filter(w => w.parentId === work.id).map(w => w.id)].filter(Boolean));
        const rep = state.reputation?.[work.pennameId] || {};
        const repF = clamp(1 + 0.5 * Math.max(0, (rep.general || 0) + (rep.literary || 0)), 1, 2.5);
        const base = SHELF_BASE[work.form] ?? 0.05;
        for (const person of state.persons || []) {
            if (person.active === false) continue;
            const recs = state.receptions.filter(r => r.personId === person.id && versions.has(r.workId));
            if (recs.some(r => r.read && r.read !== 'none')) continue; // 已经接触过（任一版本）
            if (!state.rolls[`${work.id}|${person.id}`]) continue; // 首次推演还没轮到
            const interest = interestOf(person, workTags(state, work));
            for (let i = 0; i < months.length; i++) {
                const key = `${work.id}|${person.id}|shelf|${months[i].slice(0, 7)}`;
                if (state.rolls[key]) continue;
                state.rolls[key] = { q: nextRollQ(state), at: newDate };
                const bz = penBuzz(state, work.pennameId, months[i]);
                const buzzF = clamp(1 + 0.3 * bz.n, 1, 3);
                const p = clamp(base * Math.pow(0.88, i) * repF * buzzF * (0.4 + interest), 0, 0.5);
                if (roll(seed, key) >= p) continue;
                const hot = buzzF > 1.2 ? `；这个署名近两个月见报 ${Math.round(bz.n * 10) / 10} 次${bz.topWorkId && bz.topWorkId !== work.id ? `，多半因《${byId(state.works, bz.topWorkId)?.title || '?'}》引起的话题去找来读` : ''}（话题 ×${buzzF.toFixed(1)}）` : '';
                // 碰到了：按这次重新走一遍（之前“没接触到”的记录留着，回滚时用得上；显示时会被这条盖过）
                runPipeline(state, s, era, work, person, seed, report, { shelf: { date: months[i], p: 1, why: `${months[i].slice(0, 7)}：成书仍在流通，第 ${i + 1} 个月，碰到的概率 ${Math.round(p * 100)}%（名气 ×${repF.toFixed(1)}，题材兴趣 ${Math.round(interest * 100)}%${hot}）` } });
                report.shelf = (report.shelf || 0) + 1;
                break;
            }
        }
    }
}

// ———————————— 日期精度：首发日期不确定时，按可能的日子推算 ————————————
const daysInMonth = d => { const [y, m] = d.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };
/** 只知道旬、月份或“不晚于”的作品：在可能范围内取一个确定的日子（同一份存档每次一样） */
export function effectivePubDate(state, work) {
    const d = work.pubDate;
    const prec = work.datePrecision;
    if (!d || !prec || prec === 'day') return d;
    const r = roll(state.seed || 'press-echo', `${work.id}|pubdate`);
    if (prec === 'xun') { const day = Number(d.slice(8)); const span = day >= 21 ? daysInMonth(d) - day + 1 : 10; return addDays(d, Math.floor(r * span)); }
    if (prec === 'month') return addDays(d.slice(0, 8) + '01', Math.floor(r * daysInMonth(d)));
    if (prec === 'noLaterThan') return addDays(d, -Math.floor(r * 21));
    return d;
}
const PREC_TXT = { xun: '只知道旬', month: '只知道月份', noLaterThan: '只知道不晚于这天' };
function timedWork(state, work) {
    const eff = effectivePubDate(state, work);
    if (!eff || eff === work.pubDate) return work;
    return { ...work, pubDate: eff, _pubNote: `首发日期不确定（${PREC_TXT[work.datePrecision] || ''} ${work.pubDate}），按 ${eff} 推算` };
}

function runPipeline(state, s, era, work, person, seed, report, opts = {}) {
    work = timedWork(state, work);
    const { via, manualRead } = opts;
    let rec;
    if (manualRead) {
        rec = manualRead;
    } else {
        const extra = via ? { ch: 'review', p: opts.viaP ?? 0.5, lag: [0, 3], from: via.date }
            : opts.seek ? { ch: 'seek', p: opts.seek.p, lag: [0, 1], from: opts.seek.date }
            : opts.recommend ? { ch: 'recommend', p: 0.6, lag: [0, 4], from: opts.recommend.date }
            : opts.shelf ? { ch: 'shelf', p: 1, lag: [0, 25], from: opts.shelf.date } : null;
        const c = contactStage(state, s, era, work, person, seed, extra);
        rec = {
            id: uid('rc'), q: nextRollQ(state), key: `${work.id}|${person.id}${via ? '|via' : opts.seek ? '|seek' : opts.recommend ? '|rec' : opts.shelf ? '|shelf' : ''}`, origin: 'engine', workId: work.id, personId: person.id,
            channel: c.best?.ch || null, contactDate: c.best?.date || null, read: c.best ? null : 'none',
            why: [...(work._pubNote ? [work._pubNote] : []), ...(opts.shelf ? [opts.shelf.why] : []), ...c.why], eventIds: [], opinion: null, viaEventId: via?.id || null,
        };
        if (c.best) {
            const r = readStage(state, s, era, work, person, c.best, seed + (via ? '|via' : opts.seek ? '|seek' : opts.recommend ? '|rec' : opts.shelf ? '|shelf' + opts.shelf.date : ''));
            rec.read = r.read; rec.readDate = r.readDate || null; rec.why.push(...r.why); rec.interest = r.interest;
        }
    }
    if (READ_DONE.includes(rec.read)) {
        const read = { read: rec.read, readDate: rec.readDate, interest: rec.interest ?? interestOf(person, workTags(state, work)) };
        const op = opinionStage(state, work, person, read, seed);
        if (rec.known && rec.known.polarity != null) {
            op.polarity = rec.known.polarity;
            if (op.strength === 'none') op.strength = 'mild';
            op.why = [`已知他的态度（${rec.known.source || '记录'}）：${['偏批评', '褒贬参半', '偏肯定'][op.polarity + 1]}，${STRENGTH[op.strength]}`];
        }
        rec.polarity = op.polarity; rec.strength = op.strength; rec.ideas = op.ideas || null; rec.why.push(...op.why);
        const ex = expressionStage(state, s, era, work, person, read, op, seed + (via ? '|via' : ''), via);
        rec.expression = ex.expression; rec.why.push(...ex.why);
        for (const e of ex.events) {
            const ev = {
                id: uid('ev'), q: nextRollQ(state), key: `${rec.key}|${e.layer}`, origin: 'engine', date: e.date, layer: e.layer,
                personId: person.id, outletId: e.outletId, workId: work.id, pennameId: work.pennameId || null,
                polarity: e.polarity, status: 'scheduled', receptionId: rec.id, reactsTo: e.reactsTo || null,
                to: e.layer === 'private_letter' ? 'protagonist' : null, knownAt: e.date,
                text: null, flags: e.irregular ? ['不定期刊物：这期哪天出、是否真的出了，并不确定，请核对'] : [], repApplied: null, why: rec.why.slice(),
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
/** 此人是否知道这个笔名背后是谁：以笔名的“知道身份的人”名单为准；名单空着时才看人物自己的“知道主角的笔名身份” */
export function knowsPen(state, person, pennameId) {
    const pen = byId(state.pennames, pennameId);
    if (pen?.knownBy?.length) return pen.knownBy.includes(person.id);
    return !!person.knowsIdentity;
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
    if (!READ_DONE.includes(rec.read) || rec.strength === 'none' || !rec.readDate) return;
    const told = [];
    for (const rel of relationsOf(state, person)) {
        if (rel.discloseOpinions === false) continue;
        const q = byId(state.persons, rel.to);
        if (!q || q.active === false) continue;
        const freq = rel.frequency || 'monthly';
        const p = clamp((FREQ_P[freq] ?? 0.3) * (0.5 + 0.2 * (Number(rel.closeness) || 0)) * (rec.strength === 'strong' ? 1.3 : 0.8), 0, 0.9);
        const key = `${work.id}|${person.id}|talk|${q.id}`;
        if (roll(seed, key) >= p) continue;
        // 先定下实际交谈的日子，再看那天两人的关系是否有效
        let date = addDays(rec.readDate, between(seed, key + '|lag', FREQ_LAG[freq] || [3, 20]));
        if (rel.since && cmp(date, rel.since) < 0) {
            // 读完时还不认识：若一个月内结识，记忆犹新，可能在结识后谈起；否则不谈
            if (diffDays(rel.since, rec.readDate) > 30) continue;
            date = addDays(rel.since, between(seed, key + '|lag2', [0, 4]));
        }
        if (rel.until && cmp(date, rel.until) > 0) continue; // 到交谈那天已经断了往来
        told.push(`${q.name}（${REL_TYPES[rel.type] || '熟人'}，约 ${date}）`);
        const had = (state.receptions || []).some(r => r.workId === work.id && r.personId === q.id && READ_DONE.includes(r.read));
        if (!had) {
            state.recommends = state.recommends || {};
            const box = (state.recommends[work.id] = state.recommends[work.id] || {});
            if (!box[q.id] || cmp(date, box[q.id].date) < 0) {
                box[q.id] = { q: nextRollQ(state), date, by: person.id, byName: person.name, polarity: rec.polarity, p: rec.polarity === 1 ? 0.55 : rec.polarity === -1 ? 0.3 : 0.4 };
                const rk = `${work.id}|${q.id}|recommend`;
                if (state.rolls?.[`${work.id}|${q.id}`] && !state.rolls[rk]) {
                    state.rolls[rk] = { q: nextRollQ(state), at: date };
                    const prev = (state.receptions || []).filter(r => r.workId === work.id && r.personId === q.id && r.origin !== 'manual');
                    const nr = runPipeline(state, s, era, work, q, seed, report, { recommend: { date, by: person } });
                    if (READ_DONE.includes(nr.read)) for (const r of prev) r.superseded = nr.id;
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
        // 主角的私人信息（语言、出身、创作意图……）：知情者谈起时可能说出去，只出候选
        const fl = factLeakCandidates(state, { person, q, rel, date, roll: k => roll(seed, `${key}|fact|${k}`) });
        if (fl.length) told.push(`（可能向${q.name}说起了主角的私事 ${fl.length} 条，待确认）`);
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
    if (!READ_DONE.includes(rec.read) || !work.pennameId || !rec.readDate) return;
    const pen = byId(state.pennames, work.pennameId);
    const strong = rec.strength === 'strong' ? 1 : rec.strength === 'mild' ? 0.5 : 0;
    let delta = rec.polarity === 1 ? 0.6 + 0.4 * strong : rec.polarity === 0 ? 0.15 + 0.1 * strong : -0.5 - 0.3 * strong;
    if (rec.read !== 'finished') delta *= 0.5;
    const before = impressionAt(state, work.pennameId, person.id, rec.readDate);
    addImpression(state, work.pennameId, person.id, { date: rec.readDate, delta: +delta.toFixed(2), workId: work.id, recId: rec.id });
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
        const had = (state.receptions || []).some(r => r.workId === w.id && r.personId === person.id && READ_DONE.includes(r.read));
        if (had) continue;
        if (!state.rolls?.[`${w.id}|${person.id}`]) continue; // 还没轮到的，轮到时 contactStage 会按“主动去找”处理
        const rk = `${w.id}|${person.id}|seek|${work.id}`; // 每次被勾起兴趣都可以重试
        if (state.rolls[rk]) continue;
        state.rolls[rk] = { q: nextRollQ(state), at: since };
        const want = seekAffinity(state, w, person, work);
        const avail = seekAvailability(state, w, person);
        if (roll(seed, rk + '|want') >= want) { tried.push(`《${w.title}》不太想看（${Math.round(want * 100)}%）`); continue; }
        if (roll(seed, rk + '|find') >= avail) { tried.push(`《${w.title}》想看但没找到（能找到的概率 ${Math.round(avail * 100)}%），以后可能再找`); continue; }
        tried.push(`《${w.title}》找到了`);
        const prev = (state.receptions || []).filter(r => r.workId === w.id && r.personId === person.id && r.origin !== 'manual');
        const nr = runPipeline(state, s, era, w, person, seed, report, { seek: { p: 1, date: addDays(since, between(seed, rk + '|lag', [0, 10])) } });
        if (READ_DONE.includes(nr.read)) for (const r of prev) r.superseded = nr.id;
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
    report.diag = { pairs: 0, run: 0, preexisting: 0, inactive: 0 };
    for (const work of state.works || []) {
        if (!work.pubDate || cmp(work.pubDate, newDate) > 0) continue;
        for (const person of state.persons || []) {
            if (person.active === false) { report.diag.inactive++; continue; }
            const key = `${work.id}|${person.id}`;
            if (state.rolls[key]) continue;
            report.diag.pairs++;
            // 已有手动记录或已确认事件：不重复推演
            const exist = state.ledger.some(e => e.workId === work.id && e.personId === person.id && e.origin === 'manual' && e.status !== 'rejected')
                || state.receptions.some(r => r.workId === work.id && r.personId === person.id && r.origin === 'manual');
            if (exist) { state.rolls[key] = { q: nextRollQ(state), preexisting: true, at: newDate }; report.diag.preexisting++; continue; }
            state.rolls[key] = { q: nextRollQ(state), at: newDate };
            report.diag.run++;
            runPipeline(state, s, era, work, person, seed, report);
        }
    }

    // ①b 长尾：成书、小册子发表后还会在书店、图书馆、沙龙里流通，每个月给还没碰过它的人一次机会
    shelfStage(state, s, era, seed, newDate, report);

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
            const had = state.receptions.some(r => r.workId === work.id && r.personId === person.id && [...READ_DONE, 'ignored'].includes(r.read));
            const regular = readsOutlets(state, person).has(ev.outletId);
            if (had || (!regular && !mayBrowse(state, person).has(ev.outletId))) continue;
            state.rolls[key] = { q: nextRollQ(state), at: newDate };
            runPipeline(state, s, era, work, person, seed, report, { via: ev, viaP: regular ? 0.5 : 0.15 });
        }
    }

    // ③ 汇总类：读者来信、各报转载提及
    for (const work of state.works || []) {
        if (!work.pubDate || cmp(work.pubDate, newDate) > 0) continue;
        const host = byId(state.outlets, work.outletId);
        const ref = work.endDate && cmp(work.endDate, newDate) <= 0 ? work.endDate : effectivePubDate(state, work);
        if (host && outletSections(host).includes('reader_letters')) {
            const key = `${work.id}|readers`;
            const due = addDays(ref, 2);
            if (!state.rolls[key] && cmp(due, newDate) <= 0 && skipAggregate(state, s, key, 'reader_letters', work, due, newDate)) { /* 已有记录 */ }
            else if (!state.rolls[key] && cmp(due, newDate) <= 0) {
                const tierBase = { 1: 3, 2: 8, 3: 20, 4: 45, 5: 90 }[host.tier || 3];
                const formF = { serial: 1, translation_serial: 0.8, article: 0.6, book: 0.3, translation_book: 0.3, pamphlet: 0.2 }[work.form] ?? 0.5;
                const r = roll(seed, key);
                const count = Math.round(tierBase * formF * fameFactor(state, work.pennameId) * (0.5 + r) * seasonFactor(era, due));
                state.rolls[key] = { q: nextRollQ(state), count, at: newDate };
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
            state.rolls[mkey] = { q: nextRollQ(state), count, at: newDate };
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
            if (ev.status === 'candidate' && !isMajor(state, ev) && !(ev.flags || []).some(f => f.startsWith('不定期刊物'))) { ev.status = 'approved'; ev.auto = true; report.autoApproved.push(ev); }
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
    state.rolls[key] = { q: nextRollQ(state), skipped: manual ? 'manual' : 'before', at: newDate };
    return true;
}

function pushAggregate(state, report, { key, layer, date, outletId, work, count, why }) {
    const ev = {
        id: uid('ev'), q: nextRollQ(state), key, origin: 'engine', date, layer, personId: null, outletId, workId: work.id,
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
    state.rolls[`${workId}|${personId}`] = { q: nextRollQ(state), manual: true };
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

/** 人物资料改了之后：撤掉此人推演出的、还没入账的阅读和反响，下次推演按新资料重来 */
export function rerollPerson(state, personId) {
    for (const k of Object.keys(state.rolls || {})) if (k.split('|')[1] === personId) delete state.rolls[k];
    const keepRec = r => r.personId !== personId || r.origin === 'manual';
    const dropEv = new Set((state.receptions || []).filter(r => !keepRec(r)).flatMap(r => r.eventIds || []));
    const before = state.receptions.length;
    state.ledger = state.ledger.filter(e => !(e.personId === personId && e.origin === 'engine' && e.status !== 'approved' && (dropEv.has(e.id) || !e.receptionId)));
    state.receptions = (state.receptions || []).filter(keepRec);
    // 此人推演出的印象、“追读”“熟人推荐”也一并撤掉
    const keptIds = new Set(state.receptions.filter(r => r.personId === personId).map(r => r.id));
    for (const pm of Object.values(state.impressions || {})) if (pm?.[personId]) pm[personId] = pm[personId].filter(x => !x.recId || keptIds.has(x.recId));
    for (const box of Object.values(state.followers || {})) if (box) delete box[personId];
    for (const box of Object.values(state.recommends || {})) {
        if (!box) continue;
        delete box[personId];
        for (const [k, v] of Object.entries(box)) if (v?.by === personId) delete box[k];
    }
    recomputeReputation(state);
    return before - state.receptions.length;
}

/**
 * 主角此刻是否知道这条反响：
 * - 公开见报的（书评、短讯、论战、转载、读者来信刊出）：见报那天起知道；
 * - 寄给主角的私信：收到那天起知道（没写收信人的私信按寄给主角算）；
 * - 别人之间的私信、私下的事：只有标了“主角得知”的日子之后才知道。
 */
export function knownToUser(state, ev) {
    if (ev.status !== 'approved') return false;
    const today = state.currentDate;
    if (today && cmp(ev.date, today) > 0) return false;
    if (LAYERS[ev.layer]?.public) return true;
    if (isToProtagonist(ev)) return !ev.knownAt || !today || cmp(ev.knownAt, today) <= 0;
    return !!(ev.knownAt && (!today || cmp(ev.knownAt, today) <= 0));
}
export const isToProtagonist = ev => !ev.to || ev.to === 'protagonist';

export { LAG_CLOSE, DEFAULT_CAPACITY, DEFAULT_DEADLINE };

// ———————————— 回溯推演 ————————————

/**
 * 从最早的作品发表日起，把之前没推演过的经过补上，一直推到当前故事日期。
 * mode = 'hidden'：已导入/已确认的记录视为当时的全部公开报道和来信，只补“看不见的部分”
 *                 （谁读了、私下怎么看、圈子里怎么谈），以及落在当前日期之后、对旧作的后续反响；
 * mode = 'all'   ：公开报道和私信也补，全部作为“回溯”候选，逐条审核，不自动入账。
 * 会清掉之前推演出的、尚未入账的内容；手动/导入的记录和你已入账的都保留。
 */
/**
 * 回溯分三步，可以分段进行：
 *   backfillBegin  清掉之前推演出、尚未入账的内容，把时间拨回最早作品发表前一天；
 *   backfillStep   推进到某一天（可以反复调用，一段一段推）；
 *   backfillEnd    推到原来的日期后收尾。
 * backfill() 是一口气做完的版本。
 */
export function backfillBegin(state, settings, era, { mode = 'hidden' } = {}) {
    useConcepts(state.concepts);
    const target = state.backfillRun?.target || state.currentDate;
    const pubs = (state.works || []).map(w => w.pubDate).filter(Boolean).sort();
    if (!target) throw new Error('需要先有故事日期');
    if (!pubs.length) throw new Error('没有带发表日期的作品，无从回溯');
    if (!(state.persons || []).length) throw new Error('人物列表是空的：回溯推演的是“人物”读到作品的经过，请先导入或添加人物');
    const first = pubs[0];
    if (cmp(first, target) > 0) throw new Error('作品都还没发表，不需要回溯');
    if (state.backfillRun?.savedRumors) state.rumors = state.backfillRun.savedRumors; // 重新开始时先还原
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
    state.backfillRun = {
        mode, target, from: first, startedAt: new Date().toISOString(),
        savedRumors: JSON.parse(JSON.stringify(state.rumors || [])),
        beforeIds: state.ledger.map(e => e.id),
        manualRecIds: manualRecs.map(r => r.id), manualDone: [],
        stepped: [],
    };
    state.receptions.push(...manualRecs.map(r => ({ ...r, pendingRerun: true })));
    state.currentDate = addDays(first, -1);
    return { from: first, to: target, removed, persons: state.persons.length, works: pubs.length };
}

function runSettings(state, settings) {
    const run = state.backfillRun;
    const s = { ...settings, autoApprove: 'none' };
    if (run?.mode === 'hidden') { s.publicBefore = run.target; s.privateBefore = run.target; }
    return s;
}

/** 推进到 toDate（不超过回溯目标日）。返回这一段新增了什么 */
export function backfillStep(state, settings, era, toDate) {
    const run = state.backfillRun;
    if (!run) throw new Error('还没有开始回溯');
    useConcepts(state.concepts);
    const target = cmp(toDate, run.target) > 0 ? run.target : toDate;
    const from = state.currentDate;
    if (cmp(target, from) <= 0) return { from, to: from, finished: 0, skimmed: 0, ignored: 0, events: 0, diag: null };
    const s = runSettings(state, settings);
    const seed = state.seed || 'press-echo';
    const recBefore = new Set(state.receptions.map(r => `${r.id}|${r.read}`));
    const evBefore = new Set(state.ledger.map(e => e.id));
    // 手动/导入的阅读：读到的那天落在这一段里时，按回溯规则重算看法和表达
    const rep0 = { scheduled: 0, receptions: 0 };
    for (const rec of state.receptions.filter(r => r.pendingRerun && (!r.readDate || cmp(r.readDate, target) <= 0))) {
        const work = byId(state.works, rec.workId), person = byId(state.persons, rec.personId);
        state.receptions = state.receptions.filter(r => r !== rec);
        delete rec.pendingRerun;
        if (!work || !person) { state.receptions.push(rec); continue; }
        rec.why = (rec.why || []).filter(w => w.startsWith('手动记录'));
        rec.eventIds = (rec.eventIds || []).filter(id => state.ledger.some(e => e.id === id));
        state.rolls[`${work.id}|${person.id}`] = { q: nextRollQ(state), manual: true };
        runPipeline(state, s, era, work, person, seed, rep0, { manualRead: rec });
    }
    let d = state.currentDate;
    const diag = { pairs: 0, run: 0, preexisting: 0, inactive: 0 };
    while (cmp(d, target) < 0) {
        d = addDays(d, 7);
        if (cmp(d, target) > 0) d = target;
        const r = advanceTo(state, d, s, era);
        for (const k of Object.keys(diag)) diag[k] += r.diag?.[k] || 0;
    }
    const added = state.ledger.filter(e => !evBefore.has(e.id));
    for (const e of added) e.backfill = true;
    const newRecs = state.receptions.filter(r => !recBefore.has(`${r.id}|${r.read}`) && r.origin !== 'manual');
    const cnt = k => newRecs.filter(r => r.read === k && (!r.readDate || cmp(r.readDate, target) <= 0)).length;
    const reads = newRecs.filter(r => READ_DONE.includes(r.read) && r.readDate && cmp(r.readDate, target) <= 0)
        .map(r => ({ personId: r.personId, workId: r.workId, read: r.read, readDate: r.readDate, polarity: r.polarity, strength: r.strength, channel: r.channel }));
    const out = { reads, from, to: target, finished: cnt('finished'), skimmed: cnt('skimmed'), ignored: cnt('ignored'), none: newRecs.filter(r => r.read === 'none').length, events: added.length, candidates: added.filter(e => e.status === 'candidate').length, diag };
    run.stepped.push({ to: target, ...out, at: new Date().toISOString() });
    return out;
}

export function backfillEnd(state) {
    const run = state.backfillRun;
    if (!run) return null;
    state.rumors = run.savedRumors;
    state.snapshots = [];
    for (const r of state.receptions) delete r.pendingRerun;
    const added = state.ledger.filter(e => !run.beforeIds.includes(e.id));
    const recs = state.receptions.filter(r => r.origin !== 'manual');
    const cnt = k => recs.filter(r => r.read === k).length;
    const res = {
        mode: run.mode, from: run.from, to: run.target,
        candidates: added.filter(e => e.status === 'candidate').length,
        scheduled: added.filter(e => e.status === 'scheduled').length,
        receptions: recs.length, finished: cnt('finished'), skimmed: cnt('skimmed'), ignored: cnt('ignored'),
        remarks: recs.filter(r => r.expression === 'remark').length,
    };
    state.backfillRun = null;
    state.currentDate = run.target;
    return res;
}

export function backfill(state, settings, era, { mode = 'hidden' } = {}) {
    state.backfillRun = null;
    const b = backfillBegin(state, settings, era, { mode });
    backfillStep(state, settings, era, b.to);
    return { ...backfillEnd(state), removed: b.removed };
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
                if (READ_DONE.includes(r.read)) {
                    a.read++;
                    if (r.read === 'finished') a.finished++;
                    if (r.polarity === 1) a.pos++; else if (r.polarity === -1) a.neg++; else a.mid++;
                    if (r.strength === 'strong') a.strong++;
                    if (r.readDate) a.firstDates.push(r.readDate);
                }
                if (r.seek) a.seek++;
                if (i === 0) sample[r.personId] = r;
            } else if (READ_DONE.includes(r.read)) {
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
