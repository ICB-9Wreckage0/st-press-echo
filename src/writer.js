// writer.js — 为已批准的事件写稿，并做时代校验。
// 模型拿到的只有：这一件事的设定、作品摘要、写稿人档案、年代档案、它要回应的前文。
// 事件本身（谁、哪天、哪家、什么层级、褒贬）由引擎决定，模型不得改动。

import { callLLM } from './llm.js';
import { extractJSON, truncate } from './util.js';
import { LAYERS, FORMS, CIRCLES, PERIODICITY, byId, READ_DONE } from './engine.js';
import { weekdayZh, yearOf } from './date.js';
import { eraBrief } from './era.js';
import { factsKnownBy, perceptionsOf, claimsVisible, PERC_KIND } from './perception.js';
import { cardText, generateOpinion, stanceLines, stylePrefLines, claimLines, RESPECT, FOLLOW } from './analysis.js';

export { eraBrief };
const addDayStr = d => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + 1); return t.toISOString().slice(0, 10); };

const POL = { 1: '总体肯定', 0: '褒贬参半', '-1': '总体批评' };

const LENGTH = {
    review: '900–1500 字',
    notice: '120–300 字',
    echo: '60–200 字',
    polemic: '600–1200 字',
    private_letter: '300–700 字',
    reader_letters: '摘录 3–5 封代表性来信，每封 40–120 字，另附一句报馆按语',
    mentions: '列出 4–6 条不同报刊的转载或一两句提及，每条注明刊物名',
};


export function describeEvent(state, ev) {
    const person = byId(state.persons, ev.personId);
    const outlet = byId(state.outlets, ev.outletId);
    const work = byId(state.works, ev.workId);
    const pen = byId(state.pennames, ev.pennameId);
    return { person, outlet, work, pen };
}

export function buildWriterPrompt(state, ev, era, settings) {
    const { person, outlet, work, pen } = describeEvent(state, ev);
    const info = LAYERS[ev.layer];
    const real = person?.real !== false && !!person;
    const stanceOnly = real && settings.realPersonPolicy !== 'full' && ev.layer !== 'reader_letters' && ev.layer !== 'mentions';
    const reactsTo = ev.reactsTo ? state.ledger.find(e => e.id === ev.reactsTo) : null;
    const earlier = state.ledger
        // 写稿人只看得到见报的文章，以及他自己写的；别人的私信他不知道
        .filter(e => e.workId === ev.workId && e.status === 'approved' && e.id !== ev.id && e.date <= ev.date && e.text?.summary && (LAYERS[e.layer]?.public || (ev.personId && e.personId === ev.personId)))
        .slice(-5);

    const system = `你在为一部以 ${state.currentDate || ''} 为当前日期的历史故事，撰写一份当时报刊或信件中的文字。
你必须严格遵守下面给定的事件设定：日期、刊物、署名者、文章层级、褒贬方向都已由推演系统决定，不得更改。
时代约束：
${eraBrief(era)}
写作规则：
1. 用${settings.outputLanguage || '中文'}写；可以保留当时的称谓（某某先生）、刊物原名和法语等外文专名。
2. 文中出现的任何事物、事件、出版物都不得晚于 ${ev.date}；不得提到此日期之后才发生的事。
3. 只评论下面“作品资料”和“证据卡”里写明的内容，不要编造作品里不存在的情节或引文；具体的褒贬要落在证据卡的条目上。
3c. 思想上的赞同或反对与文字好坏分开：文中对文笔、节奏、冗长等的评语，只能来自“文字上的感受”里有原文依据的条目；标为“尚未判断”的方面不要下结论。
3d. 场合决定语气和重点，不改变立场：私信可以直言，公开书评要顾及读者和刊物，论战聚焦分歧，沙龙交谈挑最可争论的部分。
3b. 文章必须与“写稿人私下的看法”一致（若提供）。允许平淡：短评可以只说值得一读、或只交代出版消息；书评可以认同论证而反对结论；不要为了热闹制造争议，也不要让每个人都写得格外深刻。
4. ${stanceOnly ? `写稿人“${person.name}”是真实历史人物：不要替他写成第一人称全文，也不要编造他的原话；改为以第三人称写一段“立场摘要”，说明这篇文章大概会从什么角度、提出什么看法。` : '写稿人若为虚构人物，可直接写全文；文章应符合该刊物的风格与政治立场。'}
5. 篇幅：${LENGTH[ev.layer] || '300–800 字'}。${ev.unsigned ? `
5b. 这篇以《${outlet?.name || '本刊'}》的名义刊出，不署名：byline 留空（或只写“本刊”），正文不要透露执笔者是谁，用刊物的口吻（“本刊”“我们”）写。执笔者的看法照样作数。` : ''}
6. 只输出 JSON：{"title":"标题","byline":"署名（笔名或真名，当时常见用笔名）","section":"栏目名","body":"正文","summary":"不超过80字的内容概要，供以后回顾用"}`;

    const lines = [];
    lines.push(`【事件设定】`);
    lines.push(`日期：${ev.date}（${weekdayZh(ev.date)}）`);
    lines.push(`层级：${info?.label || ev.layer}`);
    if (ev.layer === 'mentions') lines.push(`各报转载与零星提及：约 ${ev.count || '若干'} 条（从当时真实存在的报刊中选取，与作品发表刊物立场相符或相反均可）`);
    if (ev.layer === 'reader_letters') lines.push(`来信数量：约 ${ev.count || '若干'} 封（寄往《${outlet?.name || ''}》）`);
    if (outlet) lines.push(`刊物：${outlet.name}（${PERIODICITY[outlet.periodicity] || ''}；倾向：${(outlet.politics || []).join('、') || '未注明'}；圈子：${CIRCLES[outlet.circle] || ''}）${outlet.note ? '；' + outlet.note : ''}`);
    if (person) {
        lines.push(`写稿人：${person.name}${real ? '（真实历史人物）' : '（虚构人物）'}`);
        if (person.interests?.length) lines.push(`  关注：${person.interests.join('、')}`);
        if (person.likes?.length) lines.push(`  欣赏：${person.likes.join('、')}`);
        if (person.dislikes?.length) lines.push(`  反感：${person.dislikes.join('、')}`);
        if (stanceLines(person).length) lines.push(`  议题立场：${stanceLines(person).join('；')}`);
        if (stylePrefLines(person).length) lines.push(`  文体偏好（倾向，不是规则）：${stylePrefLines(person).join('；')}`);
        if (person.notes) lines.push(`  备注：${person.notes}`);
        const kf = factsKnownBy(state, person.id, ev.date);
        if (kf.length) lines.push(`  他私下知道的主角情况（${ev.layer === 'private_letter' ? '私信里可以按交情提到' : '这是公开文章：绝不能写出来，也不能暗示'}）：${kf.map(x => x.fact.text).join('；')}`);
        else lines.push('  他不知道主角的任何私人情况（身世、国籍、母语等），文中不得涉及。');
        const pb = perceptionsOf(state, person.id, { before: addDayStr(ev.date) }).slice(-5);
        if (pb.length) lines.push(`  他对作者的认知：${pb.map(b => `${b.belief}（${PERC_KIND[b.kind]}）`).join('；')}`);
        lines.push(`  与主角私交：${['陌生', '认识', '朋友', '至交'][person.closeness || 0]}；${pen?.knownBy?.includes(person.id) || person.knowsIdentity ? '知道笔名背后是谁' : '不知道笔名背后是谁'}`);
    } else if (ev.personName) lines.push(`写稿人：${ev.personName}`);
    lines.push(`褒贬方向：${POL[ev.polarity] || '褒贬参半'}`);
    if (ev.layer === 'private_letter') lines.push('这是一封写给主角本人的私信，语气应与私交程度相符。');
    lines.push('');
    lines.push('【作品资料】');
    if (work) {
        lines.push(`《${work.title}》，署名 ${pen?.name || '不详'}，${FORMS[work.form] || ''}，${work.pubDate}${work.endDate ? '–' + work.endDate : ''} 发表于《${byId(state.outlets, work.outletId)?.name || '不详'}》`);
        if (work.themes?.length) lines.push(`题材：${work.themes.join('、')}`);
        if (work.summary) lines.push(`内容：${work.summary}`);
        const cv = claimsVisible(state, pen?.id, ev.date).slice(-5);
        if (cv.length) lines.push(`作者以这个署名公开说过（可以引用、反驳或不理会）：${cv.map(c => c.text).join('；')}`);
        if (claimLines(work).length) lines.push(`作品的主张：${claimLines(work).join('；')}`);
        if (work.evidence) { lines.push('证据卡：'); lines.push(cardText(work.evidence, 3000)); }
    }
    const rec = ev.receptionId ? (state.receptions || []).find(r => r.id === ev.receptionId) : null;
    if (rec) {
        lines.push('');
        lines.push(`【写稿人的阅读情况】${rec.readDate || ''} ${({ skimmed: '只读了一部分', finished: '读完' })[rec.read] || ''}${rec.channel ? '；经由：' + rec.channel : ''}`);
        if (rec.opinion) {
            const o = rec.opinion;
            lines.push(`【写稿人私下的看法】${o.summary || ''}`);
            if (o.appreciates?.length) lines.push(`  欣赏：${o.appreciates.map(x => `${x.point}（${x.evidence || ''}）`).join('；')}`);
            if (o.objections?.length) lines.push(`  质疑：${o.objections.map(x => `${x.point}（${x.evidence || ''}）`).join('；')}`);
            if (o.agreedPoints?.length) lines.push(`  认可：${o.agreedPoints.map(x => `${x.point}（${x.evidence || ''}）`).join('；')}`);
            if (o.disagreements?.length) lines.push(`  分歧：${o.disagreements.map(x => `${x.key ? '【关键】' : ''}${x.point}（${x.evidence || ''}）`).join('；')}`);
            if (o.styleNotes?.length) lines.push(`  文字上的感受：${o.styleNotes.map(x => `${x.aspect}——${x.verdict}「${x.quote}」`).join('；')}`);
            if (o.unjudged?.length) lines.push(`  尚未判断（缺少原文证据，文中不要对这些方面下结论）：${o.unjudged.map(k => ({ technique: '技巧', ideas: '思想', argument: '论证', emotion: '情感' })[k]).join('、')}`);
            if (o.respectsAuthor) lines.push(`  对作者：${RESPECT[o.respectsAuthor]}${o.follow ? '；' + FOLLOW[o.follow] : ''}`);
            if (o.understanding && o.understanding !== 'full') lines.push(`  理解程度：${o.understanding === 'partial' ? '只理解了一部分' : '有误读'}${o.misreading ? '——' + o.misreading : ''}`);
        }
    }
    if (pen && !pen.publicIdentityKnown) lines.push(`注意：公众不知道署名“${pen.name}”背后的真实身份，文中只能猜测，不能写破。`);
    if (earlier.length) {
        lines.push('');
        lines.push('【此前已见报/已发生的相关反响（可以引述或回应）】');
        for (const e of earlier) {
            const d = describeEvent(state, e);
            lines.push(`- ${e.date} ${d.outlet ? '《' + d.outlet.name + '》' : ''}${d.person ? d.person.name : e.personName || ''}（${LAYERS[e.layer]?.label}）：${e.text.summary}`);
        }
    }
    if (reactsTo?.text?.summary) {
        lines.push('');
        lines.push(`【本文专门回应】${reactsTo.date}：${reactsTo.text.summary}`);
    }
    if (ev.note) lines.push(`\n【用户补充要求】${ev.note}`);
    return { system, user: lines.join('\n'), stanceOnly };
}

/** 时代校验：禁用词命中、出现晚于当前年份的年份 */
export function checkAnachronism(text, era, ev, state) {
    const flags = [];
    const body = `${text.title || ''}\n${text.body || ''}`;
    for (const w of era?.forbiddenAnachronisms || []) {
        const k = String(w).split(/[（(]/)[0].trim();
        if (k.length >= 2 && body.includes(k)) flags.push(`疑似时代错置：出现“${k}”`);
    }
    const y = yearOf(ev.date);
    const years = [...body.matchAll(/(?<!\d)(1[0-9]{3}|20[0-9]{2})(?!\d)/g)].map(m => +m[1]);
    const work = byId(state.works, ev.workId);
    const workYears = new Set([...(`${work?.summary || ''} ${work?.title || ''}`).matchAll(/(1[0-9]{3}|20[0-9]{2})/g)].map(m => +m[1]));
    for (const yr of new Set(years)) {
        if (yr > y && !workYears.has(yr)) flags.push(`出现晚于当前年份的年份：${yr}（若是作品本身设定的未来年份可忽略）`);
    }
    return flags;
}

export async function writeEvent(state, ev, era, settings) {
    // 先补上私下看法，保证公开文章与私下看法一致
    const rec = ev.receptionId ? (state.receptions || []).find(r => r.id === ev.receptionId) : null;
    if (rec && !rec.opinion && READ_DONE.includes(rec.read)) {
        try { await generateOpinion(state, rec, era, settings); } catch (e) { console.warn('[报刊回声] 生成看法失败，继续写稿', e); }
    }
    const { system, user, stanceOnly } = buildWriterPrompt(state, ev, era, settings);
    const raw = await callLLM({ system, user, settings, label: `写稿：${ev.date} ${LAYERS[ev.layer]?.label || ev.layer}` });
    const obj = extractJSON(raw);
    if (!obj.body || String(obj.body).trim().length < 20) throw new Error('模型返回的正文过短或为空');
    const text = {
        title: String(obj.title || ''),
        byline: ev.unsigned ? '' : String(obj.byline || ''),
        section: String(obj.section || ''),
        body: String(obj.body || ''),
        summary: truncate(String(obj.summary || obj.body).replace(/\s+/g, ' '), 120),
        stanceOnly,
        writtenAt: new Date().toISOString(),
    };
    ev.text = text;
    ev.flags = [...(ev.flags || []).filter(f => !/时代错置|晚于当前年份/.test(f)), ...checkAnachronism(text, era, ev, state)];
    return ev;
}

// ———————————— 法语原文：报纸版面以法语为主 ————————————

const latinName = t => /[A-Za-zÀ-ÿ]/.test(t || '') && !/[一-鿿]/.test(t || '');
/** 中文名 → 法文原名的对照表（人物别名、刊物原名、作品别名、笔名） */
function nameMap(state) {
    const L = [];
    for (const p of state.persons || []) { const f = (p.aliases || []).find(latinName); if (f) L.push(`${p.name} = ${f}`); }
    for (const o of state.outlets || []) if (o.originalName) L.push(`《${o.name}》 = ${o.originalName}`);
    for (const w of state.works || []) { const f = (w.aliases || []).find(latinName); if (f) L.push(`《${w.title}》 = « ${f} »`); }
    for (const p of state.pennames || []) if (latinName(p.name)) L.push(`署名 ${p.name}`);
    return L;
}

/**
 * 把一版报纸上的文章还原成当时的法语（一次调用处理一批）。结果写进 e.text.fr。
 * 只是语言还原：不增删内容、不改褒贬、不改署名。
 */
export async function translatePaperFr(state, events, era, settings) {
    const list = events.filter(e => e.text && (e.text.body || e.text.summary || e.text.title));
    if (!list.length) return 0;
    const map = nameMap(state);
    let done = 0;
    // 每批不超过约 7000 字
    const batches = []; let cur = [], len = 0;
    for (const e of list) { const n = (e.text.body || e.text.summary || '').length + 80; if (cur.length && len + n > 7000) { batches.push(cur); cur = []; len = 0; } cur.push(e); len += n; }
    if (cur.length) batches.push(cur);
    for (const b of batches) {
        const system = `你是 ${yearOf(b[0].date) || ''} 年巴黎报馆的老编辑。下面是几篇以中文写成的稿子，内容都已定稿；请把它们还原成当时巴黎报刊会刊出的法语原文。
规则：
1. 只换语言、不改内容：不增加论点和细节，不删要点，不改变褒贬和语气的强弱。
2. 用当时报刊的法语文体与惯例（称呼、引号 « »、栏目用语、署名习惯），不用现代说法；不得出现 ${b[0].date} 之后才有的事物。
3. 人名、刊名、作品名一律用下面对照表里的法文原名；对照表里没有的作品名，按中文意思译成合乎当时习惯的法文标题。
4. 标题、栏目名也译成法文（栏目名用当时常见的说法，如 Critique littéraire、Échos、Livres nouveaux、Courrier des lecteurs）。署名照原样保留（笔名本来就是西文的不要改）。
5. 原稿是“立场摘要”（第三人称概述）的，也照样译成第三人称概述，不要改写成第一人称文章。
6. 只输出 JSON：{"items":[{"id":"原样照抄","title":"","section":"","byline":"","body":"法语正文，段落之间空一行"}]}`;
        const user = `${map.length ? '【名称对照】\n' + map.join('\n') + '\n\n' : ''}${b.map(e => `【id: ${e.id}】${e.text.stanceOnly ? '（立场摘要）' : ''}
栏目：${e.text.section || LAYERS[e.layer]?.label || ''}
标题：${e.text.title || ''}
署名：${e.text.byline || ''}
正文：
${e.text.body || e.text.summary || ''}`).join('\n\n———\n\n')}`;
        const raw = await callLLM({ system, user, settings, maxTokens: Math.min(8000, 800 + b.reduce((n, e) => n + (e.text.body || e.text.summary || '').length * 3, 0)), label: `法语原文（${b.length} 篇）` });
        const out = extractJSON(raw);
        const items = Array.isArray(out?.items) ? out.items : Array.isArray(out) ? out : [];
        for (const it of items) {
            const e = b.find(x => x.id === String(it.id || '').trim());
            if (!e || !it.body) continue;
            e.text.fr = { title: String(it.title || ''), section: String(it.section || ''), byline: String(it.byline || e.text.byline || ''), body: String(it.body), at: new Date().toISOString() };
            done++;
        }
    }
    return done;
}
