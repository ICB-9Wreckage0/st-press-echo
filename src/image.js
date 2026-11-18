// image.js — 认知对照：主角怎么看自己、对外怎么说、以为别人怎么看；别人实际怎么看；各读者圈子的公众形象。
// 程序只做能确定的比对（误解、传闻、“你以为”与实际对不上）；语义上的矛盾交给“AI 对照分析”，结果标明是分析，不改任何人的认知。

import { cmp } from './date.js';
import { uid, extractJSON, truncate } from './util.js';
import { callLLM } from './llm.js';
import { byId, LAYERS, CIRCLES, repLabel, nextRollQ } from './engine.js';
import { PERC_TOPICS, PERC_KIND, FACT_VIA, factsKnownBy, overlapText, claimsVisible } from './perception.js';
import { eraBrief } from './era.js';

export const SELF_MODE = { self: '主角自认', claim: '对外说法' };
export const SPREAD = { wide: '普遍这么说', some: '有人这么说', few: '个别说法' };
/** 私人信息的类别 → 认知的类别（对照页按认知类别排） */
export const FACT_TO_PERC = { 语言与母语: '文风与语言', 国籍与出身: '身份与背景', 成长经历: '身份与背景', 知识背景: '知识背景', 创作意图: '创作动机', 身份与笔名: '身份与背景', 健康与生活: '其他', 其他: '其他' };

const upTo = (d, asOf) => !asOf || !d || cmp(d, asOf) <= 0;
const penMatch = (target, penId) => !penId || !target || target === 'pen:' || target === 'pen:' + penId || target === 'self';

/** 某人对作者的认知：按类别取截至某天的最新一条，并记下更早的几条 */
export function latestBeliefs(st, personId, { asOf = null, penId = null } = {}) {
    const out = {};
    const list = (st.perceptions || []).filter(p => p.observerId === personId && penMatch(p.target, penId) && upTo(p.formedAt, asOf))
        .sort((a, b) => cmp(a.formedAt || '', b.formedAt || ''));
    for (const p of list) (out[p.topic] = out[p.topic] || []).push(p);
    return out; // topic -> [按时间，最后一条是最新的]
}

/** 公开文章按读者圈子归类（与声誉计算一致） */
export function circleOfEvent(st, ev) {
    if (ev.layer === 'reader_letters' || ev.layer === 'mentions') return 'general';
    return byId(st.outlets, ev.outletId)?.circle || 'general';
}

/** 某个圈子截至某天看得到的、关于这个笔名的公开材料 */
export function publicPieces(st, penId, circle, asOf) {
    const evs = (st.ledger || []).filter(e => e.status === 'approved' && e.pennameId === penId && LAYERS[e.layer]?.public !== false
        && (LAYERS[e.layer]?.public || e.layer === 'reader_letters' || e.layer === 'mentions') && upTo(e.date, asOf) && (!circle || circleOfEvent(st, e) === circle))
        .sort((a, b) => cmp(a.date, b.date));
    const claims = (st.selfImage || []).filter(x => x.mode === 'claim' && (!x.pennameId || x.pennameId === penId) && upTo(x.since, asOf));
    const rumors = (st.rumors || []).filter(r => (!r.pennameId || r.pennameId === penId) && (r.strength ?? 0.3) >= 0.1 && upTo(r.date, asOf));
    return { evs, claims, rumors };
}

/** 截至某天最新的一份公众形象 */
export function latestImage(st, penId, circle, asOf) {
    return (st.publicImages || []).filter(x => x.pennameId === penId && x.circle === circle && upTo(x.asOf, asOf))
        .sort((a, b) => cmp(a.asOf, b.asOf) || (a.q || 0) - (b.q || 0)).pop() || null;
}

/** 有公开材料或已有形象的圈子 */
export function activeCircles(st, penId, asOf) {
    const set = new Set();
    for (const e of publicPieces(st, penId, null, asOf).evs) set.add(circleOfEvent(st, e));
    for (const x of st.publicImages || []) if (x.pennameId === penId && upTo(x.asOf, asOf)) set.add(x.circle);
    return Object.keys(CIRCLES).filter(c => set.has(c));
}

/**
 * 认知对照表：每个类别一行，列出主角自认、对外说法、主角以为、私事与知情者、每个人的最新认知、各圈子的公众形象。
 * flags 是程序能确定的出入；review 是 AI 对照分析的结论（只是分析）。
 */
export function perceptionMatrix(st, { asOf = null, penId = null } = {}) {
    asOf = asOf || st.currentDate || null;
    const rows = PERC_TOPICS.map(topic => ({ topic, self: [], claims: [], facts: [], assumed: [], persons: [], images: [], review: [], flags: [] }));
    const row = t => rows.find(r => r.topic === t) || rows[rows.length - 1];
    for (const x of st.selfImage || []) {
        if (!upTo(x.since, asOf) || (penId && x.pennameId && x.pennameId !== penId)) continue;
        row(x.topic)[x.mode === 'claim' ? 'claims' : 'self'].push(x);
    }
    for (const f of st.privateFacts || []) {
        const knowers = (f.knownBy || []).filter(k => upTo(k.since, asOf));
        row(FACT_TO_PERC[f.topic] || '其他').facts.push({ fact: f, knowers, isPublic: !!(f.public && upTo(f.publicSince, asOf)) });
    }
    const latestOf = {};
    for (const p of st.persons || []) {
        const lb = latestBeliefs(st, p.id, { asOf, penId });
        latestOf[p.id] = lb;
        for (const [topic, list] of Object.entries(lb)) {
            const b = list[list.length - 1];
            const flags = [];
            if (b.kind === 'misread') flags.push({ type: 'misread', text: '他误解了' });
            if (b.kind === 'rumor') flags.push({ type: 'rumor', text: '只是听来的传闻' });
            const prev = list.slice(0, -1).filter(x => x.belief !== b.belief);
            row(topic).persons.push({ person: p, belief: b, older: prev, flags });
            if (flags.length) row(topic).flags.push(...flags.map(f => ({ ...f, who: p.name })));
        }
    }
    const circles = penId ? Object.keys(CIRCLES) : [];
    for (const c of circles) {
        const img = latestImage(st, penId, c, asOf);
        for (const it of img?.items || []) row(it.topic).images.push({ circle: c, item: it, img });
    }
    for (const a of st.assumed || []) {
        if (!upTo(a.since, asOf) || (penId && a.pennameId && a.pennameId !== penId)) continue;
        const r = row(a.topic);
        let actual = null, flag = null;
        if (a.personId) {
            const list = latestOf[a.personId]?.[a.topic] || [];
            actual = list[list.length - 1] || null;
            const name = byId(st.persons, a.personId)?.name || '?';
            if (!actual) flag = { type: 'assumed_none', text: `你以为${name}这么看，但他在这方面还没有形成看法`, who: name };
            else if (overlapText(a.belief, actual.belief) < 2) flag = { type: 'assumed_diff', text: `你以为的和${name}实际的看法对不上（字面比对，请自己判断）`, who: name };
        } else if (a.circle) {
            const img = penId ? latestImage(st, penId, a.circle, asOf) : null;
            const its = (img?.items || []).filter(i => i.topic === a.topic);
            actual = its.length ? { belief: its.map(i => i.belief).join('；'), kind: 'public' } : null;
            if (!img) flag = { type: 'assumed_noimg', text: `${CIRCLES[a.circle]}的公众形象还没生成，无法比对`, who: CIRCLES[a.circle] };
            else if (!its.length) flag = { type: 'assumed_none', text: `你以为${CIRCLES[a.circle]}这么看，但公开材料里没有这种说法`, who: CIRCLES[a.circle] };
            else if (overlapText(a.belief, actual.belief) < 2) flag = { type: 'assumed_diff', text: `你以为的和${CIRCLES[a.circle]}的公开说法对不上（字面比对）`, who: CIRCLES[a.circle] };
        }
        r.assumed.push({ a, actual, flag });
        if (flag && flag.type !== 'assumed_noimg') r.flags.push(flag);
    }
    const rv = latestReview(st, penId, asOf);
    for (const it of rv?.items || []) { row(it.topic).review.push(it); }
    for (const r of rows) r.conflict = r.flags.length > 0 || r.review.length > 0;
    return { asOf, penId, rows: rows.filter(r => r.self.length || r.claims.length || r.facts.length || r.assumed.length || r.persons.length || r.images.length || r.review.length), review: rv };
}

export function latestReview(st, penId, asOf) {
    return (st.percReviews || []).filter(x => (x.pennameId || '') === (penId || '') && upTo(x.asOf, asOf)).sort((a, b) => cmp(a.asOf, b.asOf) || (a.q || 0) - (b.q || 0)).pop() || null;
}

// ———— 公众形象（AI，只依据公开材料） ————

const IMAGE_SCHEMA = `{
  "summary": "一两句：这个圈子大体怎么看这位作者",
  "items": [{"topic": "${PERC_TOPICS.join(' | ')}", "belief": "圈子里流行的一种看法（一句话）", "spread": "wide | some | few（普遍 / 有人这么说 / 个别）", "basis": ["依据的材料编号，如 E3、R1、C2"]}]
}`;

export function buildImagePrompt(st, { penId, circle, asOf, era }) {
    const pen = byId(st.pennames, penId);
    const { evs, claims, rumors } = publicPieces(st, penId, circle, asOf);
    const prev = latestImage(st, penId, circle, asOf);
    const rep = st.reputation?.[penId]?.[circle];
    const evLine = (e, i) => {
        const t = e.text || {};
        const body = t.body ? truncate(t.body, 300) : '';
        return `E${i + 1} ${e.date} ${byId(st.outlets, e.outletId)?.name || ''} ${LAYERS[e.layer]?.label || e.layer} ${byId(st.persons, e.personId)?.name || ''} 评《${byId(st.works, e.workId)?.title || '?'}》 ${['偏批评', '褒贬参半', '偏肯定'][(e.polarity ?? 0) + 1]}${e.count ? ` 约${e.count}份` : ''}：${t.summary || e.summary || ''}${body ? '\n   正文节选：' + body : ''}`;
    };
    const system = `你在为一部历史模拟整理“某个读者圈子对一位作者的公众印象”。时间：截至 ${asOf}。
时代约束：
${eraBrief(era, 400)}
规则：
1. 只能依据下面列出的公开材料（见报文章、读者来信与剪报、作者公开说过的话、坊间传闻）。私下的信件、作者没公开的私人情况一律不知道，不得出现。
2. 公众印象是这个圈子里流传的说法，可以片面、可以互相矛盾、可以和作者本人的自我认识不一致；不要替作者辩护，也不要比材料更激烈。
3. 每条都要在 basis 里写出依据的材料编号。材料只有一两篇时，spread 不能是 wide。材料太少就少写，0 条也可以。
4. 传闻只能算“有人这么说”或“个别说法”。
5. 只输出 JSON：
${IMAGE_SCHEMA}`;
    const user = `【作者】署名“${pen?.name || '?'}”（这个圈子${pen?.publicIdentityKnown ? '知道' : '不知道'}署名背后是谁）
【圈子】${CIRCLES[circle] || circle}${rep ? `；推演中的名声：${repLabel(rep)}` : ''}
【公开材料】
${evs.length ? evs.map(evLine).join('\n') : '（没有见报文章）'}
${claims.length ? claims.map((c, i) => `C${i + 1} ${c.since || ''} 作者公开说过：${c.text}`).join('\n') : ''}
${rumors.length ? rumors.map((r, i) => `R${i + 1} 传闻（流传度 ${Math.round((r.strength ?? 0.3) * 100)}%）：${r.text}`).join('\n') : ''}
${prev ? `【上一次整理的印象（${prev.asOf}）】\n${prev.items.map(x => `- [${x.topic}] ${x.belief}（${SPREAD[x.spread] || ''}）`).join('\n')}\n新材料没有推翻的说法可以保留，被新材料改变的要改。` : ''}`;
    return { system, user, refs: { E: evs.map(e => e.id), C: claims.map(c => c.id), R: rumors.map(r => r.id || r.text) }, count: evs.length + claims.length + rumors.length };
}

export function normalizeImage(obj, refs) {
    const items = [];
    for (const it of Array.isArray(obj?.items) ? obj.items : []) {
        if (!it?.belief) continue;
        const basis = (Array.isArray(it.basis) ? it.basis : [it.basis]).map(x => String(x || '').trim().toUpperCase()).filter(x => /^[ECR]\d+$/.test(x))
            .map(x => ({ ref: x, id: refs[x[0]]?.[Number(x.slice(1)) - 1] })).filter(x => x.id);
        if (!basis.length) continue; // 没有依据的不收
        let spread = SPREAD[it.spread] ? it.spread : 'some';
        const evN = basis.filter(b => b.ref[0] === 'E').length;
        if (spread === 'wide' && evN < 3) spread = 'some';
        if (basis.every(b => b.ref[0] === 'R') && spread !== 'few') spread = 'few';
        items.push({ topic: PERC_TOPICS.includes(it.topic) ? it.topic : '其他', belief: String(it.belief).slice(0, 200), spread, basis: basis.map(b => b.id) });
    }
    return { summary: String(obj?.summary || '').slice(0, 300), items };
}

export async function generatePublicImage(st, { penId, circle, asOf, era, settings }) {
    asOf = asOf || st.currentDate;
    const pr = buildImagePrompt(st, { penId, circle, asOf, era });
    if (!pr.count) throw new Error(`${CIRCLES[circle] || circle}截至 ${asOf} 没有关于这个署名的公开材料`);
    const raw = await callLLM({ system: pr.system, user: pr.user, settings, maxTokens: 1600, label: `${CIRCLES[circle] || circle}眼中的“${byId(st.pennames, penId)?.name || ''}”` });
    const obj = extractJSON(raw);
    if (!obj || typeof obj !== 'object') throw new Error('模型没有按格式返回公众形象，请重试');
    const n = normalizeImage(obj, pr.refs);
    const img = { id: uid('pi'), pennameId: penId, circle, asOf, pieces: pr.count, generatedAt: new Date().toISOString(), q: nextRollQ(st), ...n };
    st.publicImages = (st.publicImages || []).filter(x => !(x.pennameId === penId && x.circle === circle && x.asOf === asOf));
    st.publicImages.push(img);
    return img;
}

// ———— AI 对照分析：找出各方认知之间的出入 ————

const REVIEW_SCHEMA = `{
  "items": [{"topic": "${PERC_TOPICS.join(' | ')}", "type": "misjudged | unaware | reverse | public_private | split", "who": ["涉及的人或圈子"], "text": "一句话：谁和谁在哪一点上对不上", "severity": "1 | 2 | 3"}]
}`;
export const REVIEW_TYPE = { misjudged: '外界误判', unaware: '主角不知道', reverse: '主角以为错了', public_private: '公开与私下不一', split: '各方分歧' };

export function buildReviewPrompt(st, m) {
    const pen = byId(st.pennames, m.penId);
    const L = [];
    for (const r of m.rows) {
        const part = [];
        for (const x of r.self) part.push(`  主角自认：${x.text}`);
        for (const x of r.claims) part.push(`  主角公开说过（${x.since || ''}）：${x.text}`);
        for (const f of r.facts) part.push(`  主角的私事：${f.fact.text}（${f.isPublic ? '已公开' : f.knowers.length ? '知情：' + f.knowers.map(k => byId(st.persons, k.personId)?.name || '?').join('、') : '无人知道'}）`);
        for (const x of r.assumed) part.push(`  主角以为${x.a.personId ? byId(st.persons, x.a.personId)?.name : CIRCLES[x.a.circle] || '?'}对他的看法：${x.a.belief}`);
        for (const x of r.persons) part.push(`  ${x.person.name}私下认为（${PERC_KIND[x.belief.kind] || ''}，${x.belief.formedAt || ''}）：${x.belief.belief}`);
        for (const x of r.images) part.push(`  ${CIRCLES[x.circle]}的公开说法（${SPREAD[x.item.spread] || ''}）：${x.item.belief}`);
        if (part.length) L.push(`【${r.topic}】\n${part.join('\n')}`);
    }
    const system = `你在帮一部历史模拟的作者核对“认知差”：同一件事，作者本人、作者公开的说法、作者以为的别人看法、别人私下的看法、各圈子的公开说法之间，哪里对不上。
规则：
1. 只比对下面列出的内容，不补充、不推测新的看法，也不评判谁对谁错。
2. 只写确有出入的地方，措辞要具体（谁、哪一点）；只是说法不同但意思一致的不算。
3. type：misjudged=外界对作者的判断与作者实际情况不符；unaware=别人有某种看法而作者没意识到（作者以为的里没有）；reverse=作者以为别人这样看，实际不是；public_private=某人私下与公开场合（或圈子公开说法）不一致；split=不同的人或圈子之间分歧明显。
4. severity：3=会影响剧情（关系、名声、误会），1=细节。
5. 只输出 JSON：
${REVIEW_SCHEMA}`;
    const user = `作者署名“${pen?.name || '（全部署名）'}”，截至 ${m.asOf}。\n\n${L.join('\n\n') || '（没有内容）'}`;
    return { system, user, empty: !L.length };
}

export async function reviewPerceptions(st, { penId, asOf, settings }) {
    const m = perceptionMatrix(st, { asOf, penId });
    const pr = buildReviewPrompt(st, m);
    if (pr.empty) throw new Error('还没有可以对照的内容');
    const raw = await callLLM({ system: pr.system, user: pr.user, settings, maxTokens: 1800, label: '认知对照分析' });
    const obj = extractJSON(raw);
    if (!obj || typeof obj !== 'object') throw new Error('模型没有按格式返回，请重试');
    const items = (Array.isArray(obj.items) ? obj.items : []).filter(x => x?.text).map(x => ({
        topic: PERC_TOPICS.includes(x.topic) ? x.topic : '其他', type: REVIEW_TYPE[x.type] ? x.type : 'split',
        who: (Array.isArray(x.who) ? x.who : [x.who]).filter(Boolean).map(String).slice(0, 6), text: String(x.text).slice(0, 240),
        severity: Math.max(1, Math.min(3, Number(x.severity) || 1)),
    }));
    const rv = { id: uid('pr'), pennameId: penId || '', asOf: m.asOf, items, generatedAt: new Date().toISOString(), q: nextRollQ(st) };
    st.percReviews = (st.percReviews || []).filter(x => !((x.pennameId || '') === (penId || '') && x.asOf === m.asOf));
    st.percReviews.push(rv);
    return rv;
}

// ———— 主角自认 / 主角以为 / 手记的认知 ————

export function blankSelf(mode = 'self') { return { id: uid('si'), mode, topic: PERC_TOPICS[0], text: '', since: '', pennameId: '' }; }
export function blankAssumed() { return { id: uid('as'), personId: '', circle: '', topic: PERC_TOPICS[0], belief: '', since: '', pennameId: '' }; }
export function manualPerception(st, { personId, topic, belief, kind, date, pennameId, factCheck = true }) {
    let k = PERC_KIND[kind] ? kind : 'inference';
    let factId = null;
    if (factCheck && (k === 'fact' || k === 'self_report')) {
        const known = factsKnownBy(st, personId, date);
        const sup = known.find(x => overlapText(x.fact.text, belief) >= 3);
        const claim = claimsVisible(st, pennameId, date).find(c => overlapText(c.text, belief) >= 3);
        if (sup) factId = sup.fact.id;
        else if (claim) k = 'self_report';
        else k = 'inference';
    }
    const p = { id: uid('pc'), observerId: personId, target: 'pen:' + (pennameId || ''), recId: null, workId: null, topic: PERC_TOPICS.includes(topic) ? topic : '其他', belief: String(belief).slice(0, 200), kind: k, confidence: 0.6, formedAt: date || st.currentDate || '', evidence: '', factId, revises: '', origin: 'manual' };
    st.perceptions = [...(st.perceptions || []), p];
    return p;
}

export { FACT_VIA, claimsVisible };
