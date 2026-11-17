// analysis.js — 作品证据卡与人物看法。
// 证据卡：每部作品从原文提取一次，之后所有看法和评论都必须引用它。
// 看法：只在需要露面时才生成（点击“生成看法”或写稿前自动补），不为每次阅读都调用模型。

import { callLLM } from './llm.js';
import { extractJSON, truncate } from './util.js';
import { byId, workTags, READ_STATES, STRENGTH, FORMS } from './engine.js';
import { eraBrief } from './era.js';

const CARD_SCHEMA = `{
  "premise": "一句话：这是什么样的作品",
  "structure": ["按顺序列出主要部分/情节节点，每条一句"],
  "keyPoints": [{"id": "K1", "point": "作品里明确写出的情节、论点或意象", "where": "出现在哪一部分", "quote": "原文短摘（≤30字，可空）"}],
  "authorConcessions": ["作者自己在文中承认的反方意见或局限"],
  "openQuestions": ["文中本身留下的悬而未决之处（不是你认为的缺点）"],
  "facts": [{"claim": "文中引用的史实、数字、法条、日期", "where": "出处"}]
}`;

export async function buildEvidenceCard(work, settings) {
    const src = String(work.sourceText || '').trim();
    if (src.length < 200) throw new Error('请先在作品资料里粘贴原文（至少几百字）');
    const system = `你是严谨的文本编辑。从用户提供的作品原文中提取“证据卡”，供之后模拟当时读者的反应时引用。
规则：
1. 只记录原文里明确存在的内容，不评价好坏，不推测作者意图，不添加原文没有的情节或论点。
2. keyPoints 要具体到情节、论点或意象，10–25 条，每条给出位置。
3. 原文太长时，优先覆盖开头、转折、结尾和最核心的论证。
4. 只输出 JSON：
${CARD_SCHEMA}`;
    const user = `作品：《${work.title}》（${FORMS[work.form] || ''}）\n\n原文：\n${truncate(src, 24000)}`;
    const raw = await callLLM({ system, user, settings, maxTokens: 3500 });
    const card = extractJSON(raw);
    card.builtAt = new Date().toISOString();
    card.sourceLength = src.length;
    return card;
}

export function cardText(card, max = 3500) {
    if (!card) return '';
    // 模型有时把数组写成字符串、把对象写成字符串，这里一律容错
    const arr = v => (Array.isArray(v) ? v : v ? [v] : []);
    const str = v => (typeof v === 'string' ? v : v?.claim || v?.point || v?.text || JSON.stringify(v));
    const L = [];
    if (card.premise) L.push(`概要：${str(card.premise)}`);
    if (arr(card.structure).length) L.push(`结构：${arr(card.structure).map(str).join(' → ')}`);
    for (const k of arr(card.keyPoints)) {
        if (typeof k === 'string') { L.push(k); continue; }
        L.push(`[${k.id || '?'}] ${k.point || ''}${k.where ? `（${k.where}）` : ''}${k.quote ? `「${k.quote}」` : ''}`);
    }
    if (arr(card.authorConcessions).length) L.push(`作者自己承认的反方意见：${arr(card.authorConcessions).map(str).join('；')}`);
    if (arr(card.openQuestions).length) L.push(`文中留下的悬念：${arr(card.openQuestions).map(str).join('；')}`);
    if (arr(card.facts).length) L.push(`文中引用的事实：${arr(card.facts).map(str).join('；')}`);
    return truncate(L.join('\n'), max);
}

function historyOf(state, personId, exceptId) {
    return (state.receptions || [])
        .filter(r => r.personId === personId && r.id !== exceptId && r.opinion?.summary)
        .map(r => {
            const w = byId(state.works, r.workId);
            return `- 《${w?.title || '?'}》（${r.readDate || ''}）：${r.opinion.summary}`;
        }).slice(-6);
}

const OPINION_SCHEMA = `{
  "understanding": "full | partial | misread",
  "misreading": "若 partial 或 misread：具体哪里没读懂或读错了（否则空）",
  "appreciates": [{"point": "欣赏什么", "evidence": "引用证据卡编号，如 K3"}],
  "objections": [{"point": "反对或质疑什么", "evidence": "引用证据卡编号"}],
  "indifferent": false,
  "worthWriting": false,
  "changeFromBefore": "与此人以前对该作者作品的看法相比有无变化、为什么（无则空）",
  "summary": "不超过80字：此人私下对这部作品的总体看法"
}`;

export async function generateOpinion(state, rec, era, settings) {
    const work = byId(state.works, rec.workId);
    const person = byId(state.persons, rec.personId);
    if (!work || !person) throw new Error('找不到作品或人物');
    if (!['skimmed', 'finished'].includes(rec.read)) throw new Error('此人没有读这部作品，不会有看法');
    const card = work.evidence;
    const hist = historyOf(state, person.id, rec.id);
    const system = `你在模拟一位历史人物私下读完一部作品后的真实看法。时间：${rec.readDate}。
时代约束：
${eraBrief(era, 600)}
规则：
1. 看法只能来自作品本身（见证据卡）和此人已有的知识、审美、立场、经历；每一条欣赏或反对都必须引用证据卡编号。
2. 推演系统已定：此人${READ_STATES[rec.read]}，总体倾向${['偏批评', '褒贬参半', '偏肯定'][rec.polarity + 1]}，${STRENGTH[rec.strength] || ''}。不得违背。
3. 允许平淡的结果：觉得还行但没什么可说；只读懂一部分；认同论证却反对结论；认为不值得专门写文章。不要为了有趣而制造争议，也不要让人物显得格外深刻。
4. ${rec.read === 'skimmed' ? '此人只读了一部分：只能评论他读到的部分，可以有误解。' : ''}
5. 这是私下看法，不是公开文章。
6. 只输出 JSON：
${OPINION_SCHEMA}`;
    const user = `【人物】${person.name}${person.real ? '（真实历史人物）' : ''}
身份：${(person.roles || []).join('、')}；关注：${(person.interests || []).join('、')}
欣赏：${(person.likes || []).join('、') || '—'}；反感：${(person.dislikes || []).join('、') || '—'}
备注：${person.notes || '—'}
${hist.length ? '此人以前读该作者作品时的看法：\n' + hist.join('\n') : '此人以前没有读过该作者的作品（或没有记录）。'}

【作品】《${work.title}》；题材：${workTags(state, work).join('、')}
${card ? '证据卡：\n' + cardText(card) : `（尚无证据卡，只有摘要：${work.summary || '无'}。请保守，不要编造细节；evidence 字段写“摘要”）`}`;
    const raw = await callLLM({ system, user, settings, maxTokens: 1500 });
    const op = extractJSON(raw);
    if (!op || typeof op !== 'object' || !op.summary) throw new Error('模型没有按格式返回看法，请重试');
    op.generatedAt = new Date().toISOString();
    op.withCard = !!card;
    rec.opinion = op;
    return op;
}
