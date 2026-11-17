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

/** 长文取开头、中段、结尾，而不是只截开头 */
function sampleText(src, max) {
    if (src.length <= max) return src;
    const a = Math.floor(max * 0.45); const m = Math.floor(max * 0.2); const z = max - a - m;
    const mid = Math.floor(src.length / 2 - m / 2);
    return `${src.slice(0, a)}\n\n［……中略……］\n\n${src.slice(mid, mid + m)}\n\n［……中略……］\n\n${src.slice(src.length - z)}`;
}

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
    const user = `作品：《${work.title}》（${FORMS[work.form] || ''}）\n\n原文${src.length > 24000 ? `（全文 ${src.length} 字，这里是开头、中段和结尾的节选）` : ''}：\n${sampleText(src, 24000)}`;
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

const DIM = { technique: '技巧', ideas: '思想', argument: '论证', emotion: '情感', attention: '关注' };
export const OPINION_DIMS = DIM;
function dimText(d) {
    if (!d) return '';
    return Object.entries(DIM).filter(([k]) => d[k] != null && d[k] !== '').map(([k, v]) => `${v}${d[k] > 0 ? '+' : ''}${d[k]}`).join(' ');
}
function historyOf(state, personId, exceptId, pennameId) {
    return (state.receptions || [])
        .filter(r => r.personId === personId && r.id !== exceptId && r.opinion?.summary && (!pennameId || byId(state.works, r.workId)?.pennameId === pennameId))
        .sort((a, b) => String(a.readDate || '').localeCompare(String(b.readDate || '')))
        .map(r => {
            const w = byId(state.works, r.workId);
            const d = dimText(r.opinion.dimensions);
            return `- 《${w?.title || '?'}》（${r.readDate || ''}）：${r.opinion.summary}${d ? `〔${d}〕` : ''}${r.opinion.authorView ? `；当时对作者的看法：${r.opinion.authorView}` : ''}`;
        }).slice(-8);
}

const OPINION_SCHEMA = `{
  "understanding": "full | partial | misread",
  "misreading": "若 partial 或 misread：具体哪里没读懂或读错了（否则空）",
  "dimensions": {
    "technique": "文学技巧（文笔、结构、叙事）：-2 很差 … 0 一般 … 2 出色；不在意此项填 null",
    "ideas": "思想内容是否认同：-2 … 2 或 null",
    "argument": "论证、材料是否可信：-2 … 2 或 null",
    "emotion": "情感上是否打动他：-2 … 2 或 null",
    "attention": "是否值得继续关注：-2 … 2 或 null"
  },
  "appreciates": [{"point": "欣赏什么", "evidence": "引用证据卡编号，如 K3"}],
  "objections": [{"point": "反对或质疑什么", "evidence": "引用证据卡编号"}],
  "indifferent": false,
  "worthWriting": false,
  "authorView": "读完这部之后，他心中这位作者是什么样的：擅长什么、毛病在哪（40字内；可以和以前一样，也可以修正）",
  "changeFromBefore": "与他以前对该作者作品的看法相比有无变化；有变化必须指出改变了以前哪一条看法、因为这部作品的哪一点（无则空）",
  "summary": "不超过80字：此人私下对这部作品的总体看法"
}`;

export async function generateOpinion(state, rec, era, settings) {
    const work = byId(state.works, rec.workId);
    const person = byId(state.persons, rec.personId);
    if (!work || !person) throw new Error('找不到作品或人物');
    if (!['skimmed', 'finished'].includes(rec.read)) throw new Error('此人没有读这部作品，不会有看法');
    const card = work.evidence;
    const hist = historyOf(state, person.id, rec.id, work.pennameId);
    const system = `你在模拟一位历史人物私下读完一部作品后的真实看法。时间：${rec.readDate}。
时代约束：
${eraBrief(era, 600)}
规则：
1. 看法只能来自作品本身（见证据卡）和此人已有的知识、审美、立场、经历；每一条欣赏或反对都必须引用证据卡编号。
2. 推演系统已定：此人${READ_STATES[rec.read]}，总体倾向${['偏批评', '褒贬参半', '偏肯定'][rec.polarity + 1]}，${STRENGTH[rec.strength] || ''}。不得违背。
3. 允许平淡的结果：觉得还行但没什么可说；只读懂一部分；认同论证却反对结论；认为不值得专门写文章。不要为了有趣而制造争议，也不要让人物显得格外深刻。
4. ${rec.read === 'skimmed' ? '此人只读了一部分：只能评论他读到的部分，可以有误解。' : ''}
5. 这是私下看法，不是公开文章。
5b. 各个维度独立判断，不必一致：完全可以“文笔出色、论证粗糙、结论不认同，但觉得作者值得关注”。
5c. 如果他以前读过这位作者的作品，必须对照下面列出的旧看法：保留仍然成立的判断（包括矛盾的判断），只在这部作品确实提供了理由时才修正，并在 changeFromBefore 里写明修正了哪一条。不要编造“作者越来越成熟”之类没有依据的成长线，也不要让他变得无条件欣赏作者。
6. 只输出 JSON：
${OPINION_SCHEMA}`;
    const user = `【人物】${person.name}${person.real ? '（真实历史人物）' : ''}
身份：${(person.roles || []).join('、')}；关注：${(person.interests || []).join('、')}
欣赏：${(person.likes || []).join('、') || '—'}；反感：${(person.dislikes || []).join('、') || '—'}
备注：${person.notes || '—'}
${hist.length ? '此人以前读这个署名的作品时的看法（按时间先后）：\n' + hist.join('\n') : '此人以前没有读过这个署名的作品（或没有生成过看法）。'}

【作品】《${work.title}》；题材：${workTags(state, work).join('、')}
${card ? '证据卡：\n' + cardText(card) : `（尚无证据卡，只有摘要：${work.summary || '无'}。请保守，不要编造细节；evidence 字段写“摘要”）`}`;
    const raw = await callLLM({ system, user, settings, maxTokens: 1500 });
    const op = extractJSON(raw);
    if (!op || typeof op !== 'object' || !op.summary) throw new Error('模型没有按格式返回看法，请重试');
    if (op.dimensions && typeof op.dimensions === 'object') {
        for (const k of Object.keys(op.dimensions)) {
            const v = Number(op.dimensions[k]);
            op.dimensions[k] = op.dimensions[k] == null || op.dimensions[k] === '' || isNaN(v) ? null : Math.max(-2, Math.min(2, Math.round(v)));
        }
    }
    op.generatedAt = new Date().toISOString();
    op.withCard = !!card;
    rec.opinion = op;
    return op;
}
