// relsuggest.js — 让模型按它记得的史料，找出人物表里这些人彼此之间的真实关系，以及可能起中转作用、还不在表里的人。
// 模型不联网：它给的“依据”可能记错，所以一律只进待确认，标明“AI 提供，未核实”；你采纳才写进人物关系。

import { callLLM } from './llm.js';
import { extractJSON, uid } from './util.js';
import { byId, REL_TYPES, REL_FREQ, ROLES, PERIODICITY, CIRCLES } from './engine.js';
import { cmp, normalizeISO } from './date.js';
import { clog } from './console.js';
import { personExists } from './suggest.js';

const norm = s => String(s || '').replace(/[\s·・.\-'’]/g, '').toLowerCase();
export function findPersonLoose(st, name) {
    const n = norm(name);
    if (!n) return null;
    return (st.persons || []).find(p => norm(p.name) === n || (p.aliases || []).some(a => norm(a) === n))
        || (st.persons || []).find(p => n.length >= 3 && (norm(p.name).endsWith(n) || n.endsWith(norm(p.name)) || (p.aliases || []).some(a => norm(a).endsWith(n))));
}
export const CERTAINTY = { documented: '有明确史料', likely: '很可能（间接证据）', speculative: '推测' };

const SCHEMA = `{
  "relations": [{
    "from": "人物表里的名字", "to": "人物表里的名字",
    "type": "${Object.keys(REL_TYPES).join(' | ')}",
    "closeness": "0–3（0 只见过、1 认识、2 朋友、3 至交）", "frequency": "${Object.keys(REL_FREQ).join(' | ')}",
    "mutual": "true=双方都算这层关系；false=只有 from 一方（如单方面崇拜、单方面通信）",
    "since": "关系从何时开始，YYYY-MM-DD；只知道年份写 YYYY；不知道留空", "until": "断交/去世等，没有就留空",
    "evidence": "依据：发生了什么（如 1884 年因文章冲突决斗，1888 年公开和解；1890-05 在《某报》撰文称赞对方某书）",
    "source": "能说出的出处（书信集、回忆录、日记、某报某日文章）；说不出就留空，不要编",
    "certainty": "documented=有明确史料 | likely=很可能 | speculative=推测"
  }],
  "intermediaries": [{
    "name": "中文译名", "originalName": "原文名", "lifespan": "生卒年", "roles": ["critic | journalist | writer | editor | scholar"],
    "connects": ["他和人物表里哪些人有往来"], "why": "他为什么是重要的中转人（和谁多熟、常在哪里见面）",
    "certainty": "documented | likely | speculative"
  }]
}`;

export function buildRelPrompt(st, { to, era, focusIds = null, withMiddle = true, max = 20 }) {
    const persons = (st.persons || []).filter(p => p.active !== false);
    const pl = persons.map(p => {
        const outs = (p.outletIds || []).map(id => byId(st.outlets, id)?.name).filter(Boolean);
        return `- ${p.name}${(p.aliases || []).length ? `（${p.aliases.join(' / ')}）` : ''}：${(p.roles || []).map(r => ROLES[r] || r).join('/')}${outs.length ? '；供稿 ' + outs.join('、') : ''}${p.real === false ? '；虚构人物' : ''}${p.notes ? '；' + String(p.notes).slice(0, 60) : ''}`;
    });
    const nm = id => byId(st.persons, id)?.name || '?';
    const have = [];
    for (const p of persons) for (const r of p.relations || []) if (byId(st.persons, r.to)) have.push(`${p.name} → ${nm(r.to)}：${REL_TYPES[r.type] || r.type}`);
    const refused = (st.relSuggestions || []).filter(x => x.status === 'rejected').map(x => `${nm(x.fromId)} → ${nm(x.toId)}`);
    const pending = (st.relSuggestions || []).filter(x => x.status === 'pending').map(x => `${nm(x.fromId)} → ${nm(x.toId)}`);
    const focus = focusIds?.length ? focusIds.map(nm) : null;
    const system = `你熟悉${era?.place || st.era?.place || '该地'}在 ${to} 前后文学界、新闻界、艺术界的人际往来。任务：找出下面“人物表”里这些人彼此之间，截至 ${to} 真实存在的关系。
硬性规则：
1. 关系的两端都必须是人物表里的人（用表里的名字）。虚构人物之间、虚构人物与真实人物之间，你没有史料，不要写。
2. 只写截至 ${to} 已经存在的关系；之后才发生的不要写。关系有变化的（决斗后和解、绝交），按 ${to} 当时的状态选 type，经过写进 evidence。
3. 区分史料与推测：同属一个流派、同在巴黎、同为某刊供稿，都不能推出私人交情；这种最多写成 colleague/salon 且 certainty=speculative。读过对方作品不等于认识。
4. source 只写你确实记得的出处；记不清就留空并把 certainty 降为 likely 或 speculative。不要编造书名、日期、引文。
5. 有方向：from 对 to。双方都算就 mutual=true。
6. 下面“已有关系”里的不要重复；“已拒绝”的不要再提。
7. ${focus ? `重点找与 ${focus.join('、')} 有关的关系。` : `最多 ${max} 条，优先写对信息传播最重要的（经常见面、通信频繁、互相推荐作品的）。`}
${withMiddle ? `8. intermediaries：另外最多推荐 3 位“不在人物表里、但截至 ${to} 和表里多人都有往来、可能把消息从一个圈子带到另一个圈子”的真实人物。没有把握就不推荐。` : '8. intermediaries 留空数组。'}
只输出 JSON：
${SCHEMA}`;
    const user = `【人物表】
${pl.join('\n')}

【已有关系（不要重复）】
${have.join('\n') || '无'}
${pending.length ? `\n【已在待确认里】\n${pending.join('\n')}` : ''}${refused.length ? `\n【用户拒绝过】\n${refused.join('\n')}` : ''}`;
    return { system, user };
}

const dateOrYear = v => { const s = String(v || '').trim(); if (/^\d{4}$/.test(s)) return s + '-01-01'; return normalizeISO(s) || ''; };

export function normalizeRelSuggestions(st, obj, { to }) {
    const out = [], skipped = [];
    const nm = id => byId(st.persons, id)?.name || '?';
    for (const r of Array.isArray(obj?.relations) ? obj.relations : []) {
        const a = findPersonLoose(st, r?.from), b = findPersonLoose(st, r?.to);
        if (!a || !b || a.id === b.id) { skipped.push(`${r?.from || '?'} → ${r?.to || '?'}（不在人物表里）`); continue; }
        if (a.real === false || b.real === false) { skipped.push(`${a.name} → ${b.name}（虚构人物，没有史料）`); continue; }
        if ((a.relations || []).some(x => x.to === b.id)) { skipped.push(`${a.name} → ${b.name}（已有）`); continue; }
        if ((st.relSuggestions || []).some(x => x.fromId === a.id && x.toId === b.id && x.status !== 'accepted')) continue;
        if (out.some(x => x.fromId === a.id && x.toId === b.id)) continue;
        const since = dateOrYear(r.since);
        if (since && to && cmp(since, to) > 0) { skipped.push(`${a.name} → ${b.name}（${since} 之后才开始）`); continue; }
        const certainty = CERTAINTY[r.certainty] ? r.certainty : 'speculative';
        const type = REL_TYPES[r.type] ? r.type : 'friend';
        out.push({
            id: uid('rs'), status: 'pending', at: to, fromId: a.id, toId: b.id, certainty, source: String(r.source || '').slice(0, 160),
            rel: {
                to: b.id, type, closeness: Math.max(0, Math.min(3, Number(r.closeness) || (type === 'met' ? 0 : 1))), frequency: REL_FREQ[r.frequency] ? r.frequency : 'monthly',
                trust: 0.6, discloseOpinions: true, discloseIdentity: false, mutual: r.mutual === true || r.mutual === 'true',
                since, until: dateOrYear(r.until), basis: certainty === 'documented' ? 'history' : 'guess',
                evidence: `AI 提供，未联网核实：${String(r.evidence || '').slice(0, 200)}${r.source ? `（出处：${String(r.source).slice(0, 100)}）` : ''}`,
            },
        });
    }
    const mids = [];
    for (const m of Array.isArray(obj?.intermediaries) ? obj.intermediaries : []) {
        if (!m?.name || personExists(st, m.name) || (m.originalName && personExists(st, m.originalName))) continue;
        if ((st.personSuggestions || []).some(x => norm(x.name) === norm(m.name))) continue;
        const conf = { documented: 'high', likely: 'medium' }[m.certainty] || 'low';
        mids.push({
            id: uid('sg'), status: 'pending', at: to, name: String(m.name), originalName: String(m.originalName || ''), lifespan: String(m.lifespan || ''),
            roles: (Array.isArray(m.roles) ? m.roles : []).filter(x => ROLES[x]), outlets: [], reads: [], interests: [], likes: [], dislikes: [], stances: [], whichWorks: [],
            how: `关系中转：和 ${(Array.isArray(m.connects) ? m.connects : []).map(String).join('、')} 有往来`, why: String(m.why || ''), confidence: conf, kind: 'intermediary',
        });
    }
    return { out, mids, skipped, nm };
}

export async function suggestRelations(st, { to, era, settings, focusIds = null, withMiddle = true }) {
    const { system, user } = buildRelPrompt(st, { to, era, focusIds, withMiddle });
    const raw = await callLLM({ system, user, settings, maxTokens: 3500, label: focusIds?.length ? `查 ${focusIds.map(id => byId(st.persons, id)?.name).join('、')} 的人物关系` : '查人物之间的关系' });
    const obj = extractJSON(raw);
    if (!obj || typeof obj !== 'object') throw new Error('模型没有按格式返回，请重试');
    const { out, mids, skipped } = normalizeRelSuggestions(st, obj, { to });
    st.relSuggestions = [...(st.relSuggestions || []), ...out];
    st.personSuggestions = [...(st.personSuggestions || []), ...mids];
    clog('info', `AI 查到 ${out.length} 条关系待确认${mids.length ? `，推荐中转人物 ${mids.length} 位` : ''}${skipped.length ? `；跳过 ${skipped.length} 条` : ''}`, skipped.join('\n') || null);
    return { out, mids, skipped };
}

/** 采纳：写进 from 的关系（同一对已有就覆盖） */
export function acceptRelSuggestion(st, rs, { asGuess = false } = {}) {
    const a = byId(st.persons, rs.fromId);
    if (!a || !byId(st.persons, rs.toId)) return null;
    const rel = { ...rs.rel, ...(asGuess ? { basis: 'guess' } : {}) };
    a.relations = [...(a.relations || []).filter(r => r.to !== rs.toId), rel];
    rs.status = 'accepted';
    return rel;
}

// ———— AI 核对刊物资料：出刊周期、出刊日、圈子、倾向、影响力 ————
const OUT_FIELDS = { originalName: '原文刊名', periodicity: '出刊周期', weekday: '周刊出刊日', monthDays: '月刊/半月刊出刊日', circle: '所属圈子', politics: '倾向', tier: '影响力', deadlineDays: '截稿提前天数' };
const WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
export function fmtOutletVal(k, v) {
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) return '（空）';
    if (k === 'periodicity') return PERIODICITY[v] || v;
    if (k === 'circle') return CIRCLES[v] || v;
    if (k === 'weekday') return WD[v] ?? v;
    if (Array.isArray(v)) return v.join('、');
    return String(v);
}
export { OUT_FIELDS };

export function buildOutletPrompt(st, { to, era }) {
    const ol = (st.outlets || []).filter(o => o.real !== false).map(o => `- ${o.name}${o.originalName ? `（${o.originalName}）` : ''}：周期 ${PERIODICITY[o.periodicity] || '?'}${o.periodicity === 'weekly' && Number.isInteger(o.weekday) ? '·' + WD[o.weekday] : ''}${o.monthDays?.length ? '·每月 ' + o.monthDays.join('、') + ' 日' : ''}；圈子 ${CIRCLES[o.circle] || '?'}；倾向 ${(o.politics || []).join('、') || '—'}；影响力 ${o.tier ?? '?'}${Number.isInteger(o.deadlineDays) ? '；截稿提前 ' + o.deadlineDays + ' 天' : ''}`);
    const system = `你熟悉${era?.place || st.era?.place || '该地'}在 ${to} 前后的报刊。任务：核对下面这些刊物的资料是否与 ${to} 时的实际情况相符，只指出确有出入的地方。
规则：
1. 只核对“真实存在”的刊物。按 ${to} 当时的状态：刊物改过周期、改过名的，以当时为准。
2. 每条改动写清依据（如“1879 年后为月刊”），并给 certainty：documented 有明确史料 / likely 很可能 / speculative 推测。记不清就不要改。
3. 能确定出刊日（周几、每月几号）的才填 weekday（0=周日…6=周六）或 monthDays；不确定就别填——插件会把日期标为约略。
4. periodicity 只能取：${Object.entries(PERIODICITY).map(([k, v]) => k + '=' + v).join('、')}；circle 只能取：${Object.entries(CIRCLES).map(([k, v]) => k + '=' + v).join('、')}；tier 1–5（5 为全国性大报）。
5. 没有出入的刊物不要列。只输出 JSON：
{"outlets": [{"name": "刊物名（照抄上面的）", "changes": {"periodicity": "monthly", "monthDays": [1], "weekday": null, "circle": "...", "politics": ["..."], "tier": 2, "originalName": "..."}, "why": "依据", "certainty": "documented | likely | speculative"}]}`;
    return { system, user: `【刊物】\n${ol.join('\n') || '无'}` };
}

export async function checkOutlets(st, { to, era, settings }) {
    const { system, user } = buildOutletPrompt(st, { to, era });
    const raw = await callLLM({ system, user, settings, maxTokens: 2500, label: '核对刊物资料' });
    const obj = extractJSON(raw);
    if (!obj || typeof obj !== 'object') throw new Error('模型没有按格式返回，请重试');
    const out = [];
    for (const x of Array.isArray(obj.outlets) ? obj.outlets : []) {
        const o = (st.outlets || []).find(y => norm(y.name) === norm(x?.name) || norm(y.originalName) === norm(x?.name));
        if (!o || !x.changes || typeof x.changes !== 'object') continue;
        const ch = {};
        for (const [k, v] of Object.entries(x.changes)) {
            if (!OUT_FIELDS[k] || v == null || v === '') continue;
            let val = v;
            if (k === 'periodicity' && !PERIODICITY[v]) continue;
            if (k === 'circle' && !CIRCLES[v]) continue;
            if (k === 'weekday') { val = Number(v); if (!(val >= 0 && val <= 6)) continue; }
            if (k === 'tier' || k === 'deadlineDays') { val = Math.round(Number(v)); if (!Number.isFinite(val)) continue; if (k === 'tier') val = Math.max(1, Math.min(5, val)); }
            if (k === 'monthDays') { val = (Array.isArray(v) ? v : [v]).map(Number).filter(n => n >= 1 && n <= 31); if (!val.length) continue; }
            if (k === 'politics') { val = (Array.isArray(v) ? v : [v]).map(String).filter(Boolean); if (!val.length) continue; }
            if (JSON.stringify(o[k] ?? null) === JSON.stringify(val)) continue;
            ch[k] = val;
        }
        if (!Object.keys(ch).length) continue;
        out.push({ id: uid('oc'), status: 'pending', at: to, outletId: o.id, changes: ch, before: Object.fromEntries(Object.keys(ch).map(k => [k, o[k] ?? null])), why: String(x.why || '').slice(0, 240), certainty: CERTAINTY[x.certainty] ? x.certainty : 'speculative' });
    }
    st.outletChecks = [...(st.outletChecks || []).filter(x => x.status !== 'pending' || !out.some(y => y.outletId === x.outletId)), ...out];
    clog('info', `核对刊物资料：${out.length} 家有出入，待你确认`, out.map(x => `${byId(st.outlets, x.outletId)?.name}：${Object.entries(x.changes).map(([k, v]) => `${OUT_FIELDS[k]} ${fmtOutletVal(k, x.before[k])} → ${fmtOutletVal(k, v)}`).join('；')}（${CERTAINTY[x.certainty]}）${x.why}`).join('\n') || null);
    return out;
}
export function acceptOutletCheck(st, oc) {
    const o = byId(st.outlets, oc.outletId);
    if (!o) return null;
    Object.assign(o, oc.changes);
    if (oc.changes.periodicity && oc.changes.periodicity !== 'weekly' && !('weekday' in oc.changes)) o.weekday = null;
    if (oc.changes.periodicity && !['monthly', 'biweekly'].includes(oc.changes.periodicity) && !('monthDays' in oc.changes)) o.monthDays = [];
    if (oc.changes.periodicity && !('deadlineDays' in oc.changes)) o.deadlineDays = null; // 改了周期，截稿天数回到该周期的默认值
    oc.status = 'accepted';
    return o;
}
