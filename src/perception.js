// perception.js — 认知差：主角的私人信息与知情者、每个人对作者的认知。
// 原则：模拟器知道的，不等于角色知道。私人信息只给知情者；人物对作者的判断要标明来源（事实/本人陈述/推测/传闻/误解）。

import { cmp } from './date.js';
import { uid } from './util.js';

export const FACT_TOPICS = ['语言与母语', '国籍与出身', '成长经历', '知识背景', '创作意图', '身份与笔名', '健康与生活', '其他'];
export const FACT_VIA = { told: '亲口告诉', letter: '书信里说', heard: '听人转述', saw: '亲眼所见', inferred: '自己推断' };
export const PERC_TOPICS = ['文风与语言', '思想倾向', '论证方式', '知识背景', '创作动机', '公开回应与论战', '身份与背景', '名气与影响', '能力与潜力', '其他'];
export const PERC_KIND = { fact: '确知', self_report: '本人说的', inference: '推测', rumor: '传闻', misread: '误解' };

const byId = (list, id) => (list || []).find(x => x.id === id) || null;

/** 某人在某天之前知道的主角私人信息：[{ fact, via, since, believes }] */
export function factsKnownBy(st, personId, date = null) {
    const out = [];
    for (const f of st.privateFacts || []) {
        if (f.public && (!f.publicSince || !date || cmp(f.publicSince, date) <= 0)) { out.push({ fact: f, via: 'public', since: f.publicSince || '', believes: true }); continue; }
        const k = (f.knownBy || []).find(x => x.personId === personId && (!x.since || !date || cmp(x.since, date) <= 0));
        if (k) out.push({ fact: f, via: k.via || 'told', since: k.since || '', believes: k.believes !== false });
    }
    return out;
}
export const knowsFact = (st, fact, personId, date = null) => factsKnownBy(st, personId, date).some(x => x.fact.id === fact.id);

/**
 * 给模型看的“此人对作者本人知道些什么”。knowsPen：此人是否知道这个笔名就是主角——
 * 不知道的话，他对“主角本人”的了解不会联系到这个笔名的作品上。
 */
export function factLines(st, person, date, { knowsPen = true, workId = null, ownerName = '主角' } = {}) {
    const known = factsKnownBy(st, person.id, date);
    const L = [];
    if (!known.length) {
        L.push(`此人不知道${ownerName}的任何私人情况（身世、国籍、母语、成长经历、创作意图等）。不得替他推测这些，只能从作品本身判断文风和思想。`);
        return L;
    }
    const tag = x => `${FACT_VIA[x.via] || (x.via === 'public' ? '公开信息' : '')}${x.since ? '，' + x.since + ' 起' : ''}${x.believes ? '' : '，但他不太相信'}`;
    const about = known.filter(x => !x.fact.workId);
    const intents = known.filter(x => x.fact.workId);
    if (about.length) L.push(`此人知道的关于${ownerName}本人的私人情况：\n${about.map(x => `  - [${x.fact.topic || '其他'}] ${x.fact.text}（${tag(x)}）`).join('\n')}`);
    const myIntent = intents.filter(x => !workId || x.fact.workId === workId);
    if (myIntent.length) L.push(`此人知道作者对作品的意图：\n${myIntent.map(x => `  - ${x.fact.text}（${tag(x)}）`).join('\n')}`);
    if (!knowsPen) L.push(`注意：此人不知道这个笔名就是${ownerName}，所以上面这些私人情况不会被他联系到这部作品上。`);
    L.push('除上面列出的以外，他对作者的私人情况一无所知；知道作者的意图，也不等于认可作者的做法。');
    return L;
}

/** 此人在某天之前形成的、对作者的认知（按时间） */
export function perceptionsOf(st, observerId, { before = null, target = null } = {}) {
    return (st.perceptions || []).filter(p => p.observerId === observerId && (!target || p.target === target) && (!before || !p.formedAt || cmp(p.formedAt, before) < 0))
        .sort((a, b) => cmp(a.formedAt || '', b.formedAt || ''));
}

const bigrams = t => { const s = String(t || '').replace(/[\s，。、；：“”‘’（）()《》,.;:!?！？]/g, ''); const out = new Set(); for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2)); return out; };
const overlap = (a, b) => { const A = bigrams(a), B = bigrams(b); let n = 0; for (const x of A) if (B.has(x)) n++; return n; };
export const overlapText = overlap;

/** 作者以这个署名公开说过、到某天为止人人能看到的话（selfImage 里 mode=claim 的） */
export function claimsVisible(st, penId, date) {
    return (st.selfImage || []).filter(x => x.mode === 'claim' && x.text && (!penId || !x.pennameId || x.pennameId === penId) && (!x.since || !date || cmp(x.since, date) <= 0));
}

/**
 * 把模型给出的“对作者的认知”规整后存下。程序检查来源：
 * 标成“确知 / 本人说的”的，必须对得上此人真正知道的私人信息，否则降为“推测”。
 */
export function storePerceptions(st, { rec, person, target, beliefs, date }) {
    const known = factsKnownBy(st, person.id, date);
    const claims = claimsVisible(st, String(target || '').replace(/^pen:/, ''), date);
    st.perceptions = (st.perceptions || []).filter(p => p.recId !== rec.id);
    const out = [];
    for (const b of Array.isArray(beliefs) ? beliefs : []) {
        if (!b?.belief) continue;
        let kind = PERC_KIND[b.kind] ? b.kind : 'inference';
        const support = known.find(x => overlap(x.fact.text, b.belief) >= 3);
        const claim = !support && claims.find(c => overlap(c.text, b.belief) >= 3);
        if ((kind === 'fact' || kind === 'self_report') && !support) kind = claim ? 'self_report' : 'inference';
        const p = {
            id: uid('pc'), observerId: person.id, target, recId: rec.id, workId: rec.workId,
            topic: PERC_TOPICS.includes(b.topic) ? b.topic : '其他', belief: String(b.belief).slice(0, 200), kind,
            confidence: Math.max(0, Math.min(1, Number(b.confidence) || 0.5)),
            formedAt: date, evidence: String(b.evidence || '').slice(0, 120), factId: support?.fact.id || null,
            revises: String(b.revises || '').slice(0, 120),
        };
        out.push(p);
    }
    st.perceptions.push(...out);
    return out;
}

/** 熟人谈话中私人信息可能外传：只出候选，由你确认 */
export function factLeakCandidates(st, { person, q, rel, date, roll }) {
    const out = [];
    if (!rel.discloseIdentity) return out;
    for (const x of factsKnownBy(st, person.id, date)) {
        if (x.via === 'public' || x.fact.secret === 'strict' || knowsFact(st, x.fact, q.id, date)) continue;
        const p = 0.15 * (rel.trust ?? 0.5) * (x.fact.workId ? 1.3 : 1);
        if (roll(`${x.fact.id}|${person.id}|${q.id}`) >= p) continue;
        st.factLeaks = st.factLeaks || [];
        if (st.factLeaks.some(l => l.factId === x.fact.id && l.to === q.id && l.status === 'pending')) continue;
        const l = { id: uid('fl'), factId: x.fact.id, from: person.id, to: q.id, date, status: 'pending' };
        st.factLeaks.push(l); out.push(l);
    }
    return out;
}

export function blankFact() { return { id: uid('pf'), topic: '其他', text: '', workId: '', public: false, publicSince: '', secret: '', knownBy: [] }; }
