// suggest.js — 让模型推荐“可能读到作品的真实历史人物”。只进待确认，你同意才加进人物表。

import { callLLM } from './llm.js';
import { extractJSON, uid } from './util.js';
import { byId, FORMS, PERIODICITY, CIRCLES, ROLES, normSide, normStrength } from './engine.js';
import { cmp, diffDays } from './date.js';
import { blankPerson, blankOutlet, findByName } from './data.js';
import { claimLines } from './analysis.js';
import { clog } from './console.js';

const sameName = (a, b) => { const n = s => String(s || '').replace(/[\s·・.\-]/g, '').toLowerCase(); return n(a) && n(a) === n(b); };
export function personExists(st, name) {
    return (st.persons || []).some(p => sameName(p.name, name) || (p.aliases || []).some(a => sameName(a, name)));
}

/** 这次补完要不要顺带推荐：有新作品，或距上次推荐满 30 天，且待确认的不多 */
export function shouldSuggest(st, to) {
    const pending = (st.personSuggestions || []).filter(x => x.status === 'pending').length;
    if (pending >= 6) return false;
    const works = (st.works || []).filter(w => w.pubDate && cmp(w.pubDate, to) <= 0).length;
    if (!works) return false;
    const last = st.suggestRun;
    return !last || works > (last.works || 0) || diffDays(to, last.to) >= 30;
}

const SCHEMA = `{"persons": [{
  "name": "中文常用译名", "originalName": "原文全名", "lifespan": "生卒年",
  "roles": ["critic | journalist | writer | editor | scholar"],
  "outlets": ["此时为之供稿的刊物（尽量用下面已有刊物的名字）"], "reads": ["很可能常读的刊物"],
  "interests": ["关注的题材"], "likes": ["欣赏"], "dislikes": ["反感"],
  "stances": [{"issue": "议题（尽量用下面作品主张里的词）", "side": "pro | con | mixed", "strength": 1, "note": "具体立场"}],
  "whichWorks": ["他最可能读到的作品名"], "how": "他会怎样接触到这部作品（经常读哪份报、属于哪个圈子、和谁相熟）",
  "why": "推荐理由（他为什么会在意这部作品）", "confidence": "high | medium | low：此人此时确实在此地活跃、且立场描述准确的把握"
}]}`;

export async function suggestPersons(st, { to, era, settings, max = 5 }) {
    const works = (st.works || []).filter(w => w.pubDate && cmp(w.pubDate, to) <= 0)
        .sort((a, b) => cmp(b.pubDate, a.pubDate)).slice(0, 12);
    const wl = works.map(w => {
        const o = byId(st.outlets, w.outletId);
        const cl = claimLines(w);
        return `- 《${w.title}》 ${w.pubDate} ${FORMS[w.form] || ''}，${o ? `《${o.name}》（${PERIODICITY[o.periodicity] || ''}，${CIRCLES[o.circle] || ''}，倾向：${(o.politics || []).join('、') || '—'}）` : '刊物不详'}；题材：${(w.themes || []).join('、') || '—'}${cl.length ? '；主张：' + cl.join('；') : ''}${w.summary ? '；' + w.summary.slice(0, 80) : ''}`;
    });
    const have = (st.persons || []).map(p => p.name + ((p.aliases || []).length ? `（${p.aliases.join('/')}）` : '')).join('、');
    const refused = (st.personSuggestions || []).filter(x => x.status === 'rejected').map(x => x.name).join('、');
    const outlets = (st.outlets || []).map(o => o.name).join('、');
    const system = `你熟悉${era?.place || st.era?.place || '该地'}在 ${to} 前后的报刊界、文学界和思想界。为一个文学反响模拟器推荐“当时真实存在、可能读到下列作品并有所反应”的人物。
硬性规则：
1. 只推荐 ${to} 时确实在世、并在${st.era?.place || '该地'}文坛或报界活跃的真实人物。拿不准此人当时是否活跃、或在哪家刊物供稿，就不要推荐，或 confidence 填 low。
2. 不要推荐已经在人物表里的人（包括别名）${refused ? '，也不要推荐用户已经拒绝过的人' : ''}。
3. 优先推荐和作品的刊物、读者圈子、题材、主张最相关的人：例如作品登在宗教刊物上，就推荐当时活跃的宗教界评论家；作品谈死刑，就推荐当时在这个问题上发过言的人。赞成和反对的都可以推荐。
4. 立场只写此人当时可考的倾向；推测的写进 note 并注明。不要编造原话。
5. 最多 ${max} 人，宁缺毋滥。只输出 JSON：
${SCHEMA}`;
    const user = `【作品】
${wl.join('\n')}

【已有人物（不要重复）】${have || '无'}
${refused ? `【用户拒绝过的人】${refused}\n` : ''}【已有刊物】${outlets || '无'}
${era?.critics?.length ? `【年代档案里的活跃评论家（可参考）】${era.critics.map(c => typeof c === 'string' ? c : (c.nameZh || c.name)).filter(Boolean).join('、')}` : ''}`;
    const raw = await callLLM({ system, user, settings, maxTokens: 2500, label: `推荐可能读到作品的新人物（到 ${to}）` });
    const obj = extractJSON(raw);
    const list = Array.isArray(obj?.persons) ? obj.persons : Array.isArray(obj) ? obj : [];
    const out = [];
    for (const p of list) {
        if (!p?.name || personExists(st, p.name) || (p.originalName && personExists(st, p.originalName))) continue;
        if ((st.personSuggestions || []).some(x => sameName(x.name, p.name) || (p.originalName && sameName(x.originalName, p.originalName)))) continue;
        out.push({
            id: uid('sg'), status: 'pending', at: to,
            name: String(p.name), originalName: String(p.originalName || ''), lifespan: String(p.lifespan || ''),
            roles: (Array.isArray(p.roles) ? p.roles : []).filter(r => ROLES[r]),
            outlets: (Array.isArray(p.outlets) ? p.outlets : []).map(String), reads: (Array.isArray(p.reads) ? p.reads : []).map(String),
            interests: (Array.isArray(p.interests) ? p.interests : []).map(String), likes: (Array.isArray(p.likes) ? p.likes : []).map(String), dislikes: (Array.isArray(p.dislikes) ? p.dislikes : []).map(String),
            stances: (Array.isArray(p.stances) ? p.stances : []).filter(x => x?.issue).map(x => ({ issue: String(x.issue), side: normSide(x.side) || 'mixed', strength: normStrength(x.strength), note: String(x.note || ''), source: 'AI 推荐' })),
            whichWorks: (Array.isArray(p.whichWorks) ? p.whichWorks : []).map(String), how: String(p.how || ''), why: String(p.why || ''),
            confidence: ['high', 'medium', 'low'].includes(p.confidence) ? p.confidence : 'low',
        });
    }
    st.personSuggestions = [...(st.personSuggestions || []), ...out];
    st.suggestRun = { to, works: (st.works || []).filter(w => w.pubDate && cmp(w.pubDate, to) <= 0).length };
    clog('info', `推荐新人物：${out.length} 位待你确认${list.length > out.length ? `（另有 ${list.length - out.length} 位已在人物表或推荐过）` : ''}`,
        out.map(x => `${x.name}${x.originalName ? ' ' + x.originalName : ''}（把握 ${x.confidence}）：${x.why}`).join('\n') || null);
    return out;
}

/** 同意：加进人物表。刊物对不上的自动新建（出刊周期待补） */
export function acceptSuggestion(st, sg) {
    const created = [];
    const outletId = name => {
        if (!name) return '';
        let o = findByName(st.outlets, name);
        if (!o) { o = { ...blankOutlet(), name, periodicity: 'irregular' }; st.outlets.push(o); created.push(name); }
        return o.id;
    };
    const p = {
        ...blankPerson(), name: sg.name, aliases: sg.originalName ? [sg.originalName] : [], roles: sg.roles.length ? sg.roles : ['critic'],
        outletIds: sg.outlets.map(outletId).filter(Boolean), reads: sg.reads.map(outletId).filter(Boolean),
        interests: sg.interests, likes: sg.likes, dislikes: sg.dislikes, stances: sg.stances, stylePrefs: [],
        closeness: 0, real: true, active: true, knowsIdentity: false,
        notes: [sg.lifespan, sg.why ? '推荐理由：' + sg.why : '', sg.how ? '接触途径：' + sg.how : '', `（${sg.at} AI 推荐，把握 ${sg.confidence}）`].filter(Boolean).join('；'),
    };
    st.persons.push(p);
    sg.status = 'accepted'; sg.personId = p.id;
    return { person: p, createdOutlets: created };
}
