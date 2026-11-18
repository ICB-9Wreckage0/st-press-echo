// offscreen.js — 幕后补完：推演定下“谁、何时、读没读、态度如何”之后，
// 让模型补写聊天正文里没写到、主角不知道的事：沙龙里的议论、编辑部的盘算、书店里的情形、熟人间的转述……
// 规则：不得违背推演结果；不得凭空制造新的公开书评（公开文章只来自推演和账本）；每条都标明主角能否知道。

import { callLLM } from './llm.js';
import { extractJSON, truncate, uid } from './util.js';
import { byId, LAYERS, READ_STATES, STRENGTH, EXPRESSION, CHANNELS } from './engine.js';
import { cmp } from './date.js';
import { factsKnownBy } from './perception.js';
import { eraBrief } from './era.js';
import { clog } from './console.js';

export const OFF_KINDS = { salon: '沙龙/聚会', talk: '私下交谈', editorial: '编辑部', bookshop: '书店/图书馆', letter: '他人之间的书信', rumor: '传闻', press: '报界动向', other: '其他' };

const name = (st, id) => byId(st.persons, id)?.name || '?';
const title = (st, id) => byId(st.works, id)?.title || '?';

/** 这段时间里推演出的事实，整理成给模型看的清单 */
export function periodFacts(st, from, to, freshRecIds = null) {
    const inRange = d => d && (!from || cmp(d, from) > 0) && cmp(d, to) <= 0;
    const recs = (st.receptions || []).filter(r => (freshRecIds ? freshRecIds.has(r.id) : inRange(r.readDate || r.contactDate)) && r.read && r.read !== 'none'
        && (!r.contactDate || cmp(r.contactDate, to) <= 0));
    const lines = [];
    for (const r of recs.slice(0, 80)) {
        const future = r.readDate && cmp(r.readDate, to) > 0;
        lines.push(`- ${name(st, r.personId)}：${CHANNELS[r.channel] || r.channel || ''} ${r.contactDate || ''} 接触《${title(st, r.workId)}》→ ${future ? '尚未读到' : READ_STATES[r.read] || r.read}${r.readDate && !future ? ' ' + r.readDate : ''}${!future && r.strength ? `，${['偏批评', '褒贬参半', '偏肯定'][r.polarity + 1]}，${STRENGTH[r.strength]}` : ''}${!future && r.expression ? `，${EXPRESSION[r.expression] || r.expression}` : ''}${r.ideas ? `；思想上：${[r.ideas.agree?.length ? '赞同' + r.ideas.agree.join('、') : '', r.ideas.partial?.length ? '部分赞同' + r.ideas.partial.join('、') : '', r.ideas.disagree?.length ? '反对' + r.ideas.disagree.join('、') : ''].filter(Boolean).join('；')}` : ''}${r.opinion?.summary ? `；私下看法：${truncate(r.opinion.summary, 90)}` : ''}`);
    }
    const talks = [];
    for (const [wid, box] of Object.entries(st.recommends || {})) for (const [pid, x] of Object.entries(box || {})) {
        if (inRange(x.date)) talks.push(`- ${x.date} ${x.byName || name(st, x.by)} 向 ${name(st, pid)} 谈起《${title(st, wid)}》（${x.polarity === 1 ? '说好' : x.polarity === -1 ? '说不好' : '只是提起'}）`);
    }
    const evs = (st.ledger || []).filter(e => inRange(e.date) && e.status !== 'rejected').slice(-40).map(e => `- ${e.date} ${e.status === 'approved' ? '已见报/已寄出' : e.status === 'scheduled' ? '已排期' : '候选'}：${byId(st.outlets, e.outletId) ? '《' + byId(st.outlets, e.outletId).name + '》' : ''}${byId(st.persons, e.personId)?.name || e.personName || ''} ${LAYERS[e.layer]?.label || e.layer}${e.workId ? '，关于《' + title(st, e.workId) + '》' : ''}${e.count ? `（约 ${e.count}）` : ''}${e.text?.summary ? '：' + truncate(e.text.summary, 80) : ''}`);
    const leaks = (st.identityLeaks || []).filter(x => inRange(x.date)).map(x => `- ${x.date} ${name(st, x.from)} 可能向 ${name(st, x.to)} 透露了“${byId(st.pennames, x.pennameId)?.name || ''}”的真实身份（${x.status === 'pending' ? '未确认' : x.status}）`);
    talks.splice(0, Math.max(0, talks.length - 40));
    return { recs, lines, talks, evs, leaks, empty: !lines.length && !talks.length && !evs.length && !leaks.length };
}

const SCHEMA = `{
  "items": [{
    "date": "YYYY-MM-DD（必须在本期时间范围内）",
    "kind": "salon | talk | editorial | bookshop | letter | rumor | press | other",
    "who": ["涉及的人物名，必须是上面出现过的人物，或明确标为无名者如“某书商”"],
    "work": "相关作品名（可空）",
    "text": "发生了什么（60–160 字，具体：谁在什么场合说了什么、做了什么）",
    "basis": "依据推演清单里的哪一条（照抄或概括）",
    "protagonistKnows": "no | maybe | yes：主角此刻能否知道（只有当面听到、有人写信告诉他、见了报才算 yes）",
    "howCouldLearn": "主角以后可能怎样得知（可空）"
  }],
  "rumors": [{"text": "坊间流传的说法（可空）", "strength": 0.3}],
  "summary": "一句话概括这段时间文学界围绕主角作品的暗流（60 字内）"
}`;

export async function buildOffscreen(st, { from, to, freshRecIds, era, settings, chatTail = '' }) {
    const f = periodFacts(st, from, to, freshRecIds);
    if (f.empty) return null;
    const facts = (st.privateFacts || []).filter(f => f.text);
    const factRule = facts.length ? `\n4b. 主角的私人信息只有下列知情者知道，其他人不得提到、不得猜中；知情者私下也不得把它告诉别人（是否外传由推演决定）：\n${facts.map(f => `  - ${f.text} —— 知情者：${f.public ? '公开' : (f.knownBy || []).filter(k => !k.since || cmp(k.since, to) <= 0).map(k => byId(st.persons, k.personId)?.name).filter(Boolean).join('、') || '无'}`).join('\n')}` : '';
    const pens = (st.pennames || []).map(p => `${p.name}${p.publicIdentityKnown ? '（身份已公开）' : '（公众不知道作者是谁）'}${(p.knownBy || []).length ? '；知情者：' + p.knownBy.map(id => name(st, id)).join('、') : ''}`).join('；');
    const system = `你在为一部以 ${to} 为当前日期的历史角色扮演故事，补写“幕后”：文学界在主角看不到的地方发生的事。
时代约束：
${eraBrief(era, 700)}
硬性规则：
1. 只能依据下面“推演结果”展开：谁读了什么、态度如何、跟谁谈起，都已定好，不得改变、不得新增读者，也不得让没读过的人评论作品内容。
2. 不得编造新的公开书评、报道或寄给主角的信（公开文章只来自账本）；你写的是这些事背后的场景：沙龙里的议论、编辑部的盘算、书店的情形、熟人之间的转述、他人之间的书信。
3. 真实历史人物只写符合其已知立场的言行，不编造可考证的原话；可以写“据说他在某处说过大意是……”。
4. 笔名身份：${pens || '无'}。不知情的人只能猜测，不能说破。${factRule}
5. 每条标明主角能否知道。主角不在场、没人告诉他的，一律 no。
6. 下面“聊天近况”是主角那边已经写到的情节：不要与之矛盾，也不要重复它已经写过的事。
7. 4–10 条，宁少勿滥；平淡的也可以（例如某人读完只是放在一边）。用${settings.outputLanguage || '中文'}。只输出 JSON：
${SCHEMA}`;
    const user = `【本期】${from || '（起点）'} → ${to}
【推演结果：阅读与态度】
${f.lines.join('\n') || '（无）'}
${f.talks.length ? '【熟人之间谈起】\n' + f.talks.join('\n') : ''}
${f.evs.length ? '【账本上的反响】\n' + f.evs.join('\n') : ''}
${f.leaks.length ? '【身份可能外泄】\n' + f.leaks.join('\n') : ''}
${chatTail ? '【聊天近况（主角那边）】\n' + chatTail : ''}`;
    const raw = await callLLM({ system, user, settings, maxTokens: 2600, label: `幕后补完 ${from || '起点'} → ${to}` });
    const obj = extractJSON(raw);
    const items = (Array.isArray(obj?.items) ? obj.items : []).filter(x => x?.text).map(x => ({
        id: uid('os'),
        date: /^\d{4}-\d{2}-\d{2}$/.test(String(x.date)) && cmp(x.date, to) <= 0 ? x.date : to,
        kind: OFF_KINDS[x.kind] ? x.kind : 'other',
        who: (Array.isArray(x.who) ? x.who : x.who ? [x.who] : []).map(String),
        work: String(x.work || ''),
        text: String(x.text),
        basis: String(x.basis || ''),
        knows: ['no', 'maybe', 'yes'].includes(x.protagonistKnows) ? x.protagonistKnows : 'no',
        howCouldLearn: String(x.howCouldLearn || ''),
    }));
    if (!items.length) throw new Error('模型没有按格式返回幕后内容');
    // 只认推演里出现过的人物名（或无名者）；对不上的标出来，不删
    const known = new Set((st.persons || []).flatMap(p => [p.name, ...(p.aliases || [])]));
    for (const it of items) it.unknownWho = it.who.filter(n => !known.has(n) && !/某|一位|无名|书商|店员|读者|编辑/.test(n));
    const rumors = (Array.isArray(obj?.rumors) ? obj.rumors : []).filter(r => r?.text).map(r => ({ text: String(r.text), strength: Math.max(0.1, Math.min(0.8, Number(r.strength) || 0.3)) }));
    const digest = { id: uid('dg'), from: from || null, to, at: new Date().toISOString(), summary: String(obj?.summary || ''), items, rumors };
    clog('info', `幕后补完 ${from || '起点'} → ${to}：${items.length} 条（主角不知道 ${items.filter(i => i.knows === 'no').length}）${rumors.length ? `，传闻 ${rumors.length}` : ''}`,
        items.map(i => `${i.date} [${OFF_KINDS[i.kind]}] ${i.text}${i.knows === 'no' ? '（主角不知）' : ''}${i.unknownWho.length ? `（⚠ 不在人物表：${i.unknownWho.join('、')}）` : ''}`).join('\n'));
    return digest;
}

/** 写进存档：幕后内容 + 传闻 */
export function storeOffscreen(st, digest) {
    st.offscreen = st.offscreen || [];
    st.offscreen.push(digest);
    st.rumors = st.rumors || [];
    for (const r of digest.rumors || []) if (!st.rumors.some(x => x.text === r.text)) st.rumors.push({ id: uid('r'), text: r.text, strength: r.strength, pinned: false, from: digest.id, date: digest.to });
}

/** 注入用：幕后条目。mode = known（只给主角能知道的）| all（全部，并标明主角不知道） */
export function offscreenLines(st, mode, max = 8) {
    if (!mode || mode === 'off') return [];
    const items = (st.offscreen || []).flatMap(d => d.items).filter(i => !st.currentDate || cmp(i.date, st.currentDate) <= 0)
        .filter(i => mode === 'all' || i.knows === 'yes');
    return items.slice(-max).map(i => `- ${i.date.slice(5)} [${OFF_KINDS[i.kind]}] ${truncate(i.text, 110)}${i.knows !== 'yes' ? '（主角不知道；角色不得直接引用，只能作为暗线或伏笔）' : ''}`);
}
