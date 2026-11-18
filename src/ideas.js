// ideas.js — 创作构想与灵感讨论。
// 原则：构想不是作品，不进阅读、反响、名声；只有在场的人知道讨论内容；
// 作品发表后，参与过讨论只是读者读这本书时的背景——不保证评价更好，也可能更挑剔。

import { cmp } from './date.js';
import { uid } from './util.js';

export const PROJECT_STAGES = { idea: '刚有念头', planning: '构思中', drafting: '动笔了', paused: '搁置', abandoned: '放弃', published: '已成作品' };
export const POINT_KINDS = { idea: '构想', suggestion: '建议', question: '提问', objection: '质疑', praise: '赞许', remark: '评论', joke: '调侃', info: '提供资料', promise: '答应帮忙', deed: '做了实事' };
export const ADOPT = { pending: '未定', adopted: '采纳', partial: '部分采纳', revised: '改过后采纳', rejected: '没采纳', fulfilled: '已兑现', broken: '没兑现' };
export const ME = '__me'; // 观点出自主角

const byId = (list, id) => (list || []).find(x => x.id === id) || null;

export const blankProject = () => ({ id: uid('cp'), title: '', pennameId: '', penNote: '', stage: 'idea', since: '', order: '', themes: [], premise: '', question: '', forms: '', workId: '', notes: '' });
export const blankTalk = projectId => ({ id: uid('it'), projectId: projectId || '', date: '', time: '', place: '', ref: '', present: [], points: [], mentions: [], notes: '' });
export const blankPoint = () => ({ by: ME, kind: 'idea', text: '', adopted: 'pending' });

/** 一次讨论里在场的人（含提过观点的人） */
export const talkPeople = t => [...new Set([...(t.present || []), ...(t.points || []).map(p => p.by).filter(b => b && b !== ME)])];

/**
 * 某人到某天为止知道的构想：[{ project, talks: [在场的讨论], heardOf: [只是听人顺带提起的讨论] }]
 * 在别的构想的讨论里被人提起（mentions），在场的人只知道“主角有这么个构想”，不知道具体讨论过什么。
 */
export function ideasKnownBy(st, personId, date = null) {
    const m = new Map();
    const slot = p => { if (!m.has(p.id)) m.set(p.id, { project: p, talks: [], heardOf: [] }); return m.get(p.id); };
    for (const t of st.ideaTalks || []) {
        if (date && t.date && cmp(t.date, date) > 0) continue;
        if (!talkPeople(t).includes(personId)) continue;
        const p = byId(st.projects, t.projectId);
        if (p) slot(p).talks.push(t);
        for (const id of t.mentions || []) { const q = byId(st.projects, id); if (q && q.id !== t.projectId) slot(q).heardOf.push(t); }
    }
    for (const v of m.values()) { v.talks.sort((a, b) => cmp(a.date || '', b.date || '')); v.heardOf.sort((a, b) => cmp(a.date || '', b.date || '')); }
    return [...m.values()];
}

const who = (st, by) => by === ME ? '主角' : (byId(st.persons, by)?.name || '某人');
const pointLine = (st, p, personId) => `${p.by === personId ? '【他自己】' : who(st, p.by)}${POINT_KINDS[p.kind] ? '（' + POINT_KINDS[p.kind] + '）' : ''}：${p.text}${p.by !== ME && p.adopted && p.adopted !== 'pending' ? '〔' + ADOPT[p.adopted] + '〕' : ''}`;

/** 一个构想在讨论中的摘要（给模型看），只含此人在场的那几次 */
function projectBrief(st, k, personId, maxPts = 8) {
    const p = k.project;
    if (!k.talks.length) return `构想“${p.title || '未命名'}”：他没参加过讨论，只是 ${k.heardOf.map(t => t.date).filter(Boolean).join('、') || '某次'} 听人顺带提起主角有这么个构想，具体设定和讨论内容他不知道。`;
    const L = [`构想“${p.title || '未命名'}”${p.premise ? '：' + p.premise : ''}${p.question ? '；核心问题：' + p.question : ''}`];
    for (const t of k.talks) {
        const others = talkPeople(t).filter(x => x !== personId).map(x => who(st, x));
        L.push(`  · ${t.date || '日期不详'}${t.place ? ' ' + t.place : ''}，在场还有：${others.length ? others.join('、') : '只有他和主角'}`);
        for (const pt of (t.points || []).filter(x => x.text).slice(0, maxPts)) L.push(`    - ${pointLine(st, pt, personId)}`);
    }
    return L.join('\n');
}

/**
 * 生成看法时的背景：此人参与过这部作品构思阶段的讨论。
 * workId 对上构想时才给；对不上的构想不给（读的是别的书）。
 */
export function ideaLines(st, person, date, { workId = null, knowsPen = true } = {}) {
    const ks = ideasKnownBy(st, person.id, date).filter(k => workId && k.project.workId === workId);
    if (!ks.length) return [];
    const L = [`此人在作品发表前听主角聊过这部作品的构想（只限他在场的几次）：\n${ks.map(k => projectBrief(st, k, person.id)).join('\n')}`];
    L.push('【构想讨论的规则】这只是背景，不是加分项：');
    L.push('  - 评价仍然只看成品本身。听过构想，不等于会喜欢成品；他可能拿成品去对照当初聊的，觉得没写出来、写偏了，反而更挑剔。');
    L.push('  - 他自己提过的建议：被采纳不代表他会满意落实的方式；没被采纳，他可能介意，也可能早忘了。不要默认任何一种。');
    L.push('  - 他当时提过的质疑，如果成品没有回应，他大概率仍然保留；如果成品回应了，要看回应得好不好。');
    L.push('  - 他答应过帮忙或真的帮过忙（记纲要、催稿、画插图），那是交情，不是对成品的担保；也可能因此期待更高。');
    if (!knowsPen) L.push('  - 他不知道这个笔名就是主角。读到时可能认出这是听主角讲过的构想，也可能认不出——看内容与当初所聊的有多独特、多相近；认出来也不必说破。');
    return L;
}

/** 世界书人物条目里的一行：此人听主角聊过哪些构想（尚未成书的写清楚“还没写出来”） */
export function ideaLoreLine(st, person, date) {
    const ks = ideasKnownBy(st, person.id, date);
    if (!ks.length) return '';
    const bits = ks.map(k => {
        const p = k.project;
        const mine = k.talks.flatMap(t => (t.points || []).filter(x => x.by === person.id && x.text)).slice(0, 3);
        const objs = k.talks.flatMap(t => (t.points || []).filter(x => x.by === person.id && x.kind === 'objection' && x.text));
        if (!k.talks.length) return `“${p.title || '未命名构想'}”（只听人顺带提起过，不知道具体内容${p.stage === 'published' ? '' : '，还没写成'}）`;
        return `“${p.title || '未命名构想'}”（${k.talks.map(t => t.date).filter(Boolean).join('、') || '日期不详'}聊过${p.stage === 'published' ? '' : '，还没写成'}${p.order ? '；' + p.order : ''}）${mine.length ? '，他提过：' + mine.map(x => x.text).join('；') : ''}${objs.length ? '；他的保留意见还在' : ''}`;
    });
    return `他听主角当面聊过的写作构想：${bits.join('；')}。这些只有当时在场的人知道，他不会把没写出来的东西当成已发表的作品，也不会随便转述给不在场的人。`;
}

/** 构想整理：把 bundle / 手填的数据洗干净 */
export function normProject(p) {
    const o = { ...blankProject(), ...p };
    if (!PROJECT_STAGES[o.stage]) o.stage = 'idea';
    o.themes = (Array.isArray(o.themes) ? o.themes : String(o.themes || '').split(/[，,、]/)).map(s => String(s).trim()).filter(Boolean);
    return o;
}
export function normTalk(t) {
    const o = { ...blankTalk(), ...t };
    o.present = [...new Set((o.present || []).filter(Boolean))];
    o.mentions = [...new Set((o.mentions || []).filter(x => x && x !== o.projectId))];
    o.points = (o.points || []).filter(x => x && String(x.text || '').trim()).map(x => ({ ...blankPoint(), ...x, kind: POINT_KINDS[x.kind] ? x.kind : 'idea', adopted: ADOPT[x.adopted] ? x.adopted : 'pending' }));
    return o;
}
