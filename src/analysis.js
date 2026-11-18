// analysis.js — 作品证据卡与人物看法。
// 证据卡：每部作品从原文提取一次，之后所有看法和评论都必须引用它。
// 看法：只在需要露面时才生成（点击“生成看法”或写稿前自动补），不为每次阅读都调用模型。

import { callLLM } from './llm.js';
import { extractJSON, truncate } from './util.js';
import { byId, workTags, READ_STATES, STRENGTH, FORMS, SIDES, STANCE_STRENGTH, TOLERANCE, normSide, normStrength, stanceMatch, stanceText } from './engine.js';
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
    const raw = await callLLM({ system, user, settings, maxTokens: 3500, label: `生成《${work.title}》的证据卡` });
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

// ———— 人物的立场与文体偏好、作品的主张：给模型看的文字 ————

export function stanceLines(person) {
    return (person.stances || []).filter(x => x?.issue).map(x => `${x.issue}：${SIDES[normSide(x.side)] || x.side || '?'}（在意程度${STANCE_STRENGTH[normStrength(x.strength)]}）${x.note ? '——' + x.note : ''}`);
}
export function stylePrefLines(person) {
    return (person.stylePrefs || []).filter(x => x?.aspect).map(x => `${x.aspect}：${x.leaning || '—'}${x.tolerance ? `（容忍度：${TOLERANCE[normStrength(x.tolerance)]}）` : ''}`);
}
export function claimLines(work) {
    return (work.claims || []).filter(x => x?.issue).map(x => `${x.issue}：${SIDES[normSide(x.side)] || x.side || '?'}${x.note ? '——' + x.note : ''}`);
}

/** 文体检查清单：模型读段落时逐项看，只写有证据的项 */
export const STYLE_CHECKLIST = [
    ['词汇选择', '口语、书面语、术语、生僻词', '准确自然，或过于平淡'],
    ['句法复杂度', '从句、插入语、句长、倒装', '丰富灵活，或难以跟随'],
    ['句子节奏', '长短交替、停顿、突然收束', '有力量，或缺乏变化'],
    ['信息密度', '每句话提供多少新信息', '精练，或空泛'],
    ['解释密度', '是否反复交代已经成立的逻辑', '审慎清晰，或啰唆'],
    ['修辞密度', '比喻、象征、排比、讽刺', '有感染力，或刻意堆砌'],
    ['叙述距离', '作者是否直接解释人物心理与道德意义', '亲切明白，或干预过度'],
    ['情绪强度', '情感表达激烈还是克制', '冷静有力，或力度不足'],
    ['因果清晰度', '是否交代事件如何引发下一步', '易于理解，或过分机械'],
    ['留白程度', '多少意义留给读者推断', '含蓄深刻，或含混不清'],
    ['论证重复度', '多次出现的论点是否提供新信息', '层层递进，或原地打转'],
    ['结构连贯性', '段落和场景是否服务于主要目标', '聚焦严谨，或单调可预测'],
];

const OPINION_SCHEMA = `{
  "understanding": "full | partial | misread",
  "misreading": "若 partial 或 misread：具体哪里没读懂或读错了（否则空）",
  "dimensions": {
    "technique": {"score": "文学技巧 -2 很差 … 0 一般 … 2 出色；没有证据或他不在意则 null", "evidence": [{"where": "证据卡编号如 K3，或原文位置", "quote": "原文短摘（≤30字）"}], "note": "依据这些段落的判断（一句话）"},
    "ideas": {"score": "思想是否认同 -2 … 2 或 null", "evidence": [], "note": ""},
    "argument": {"score": "论证、材料是否可信 -2 … 2 或 null", "evidence": [], "note": ""},
    "emotion": {"score": "情感上是否打动他 -2 … 2 或 null", "evidence": [], "note": ""},
    "attention": {"score": "是否值得继续关注 -2 … 2 或 null（此项不需要原文证据）", "note": ""}
  },
  "styleNotes": [{"aspect": "文体清单中的一项", "verdict": "他的具体感受（欣赏或不满，为什么）", "where": "证据卡编号或原文位置", "quote": "原文短摘（必填）"}],
  "agreedPoints": [{"point": "他认可的论点或处理", "evidence": "K编号/原文位置"}],
  "disagreements": [{"point": "分歧所在", "evidence": "K编号/原文位置", "key": "是否关键分歧 true/false"}],
  "appreciates": [{"point": "其他欣赏之处", "evidence": "K编号"}],
  "objections": [{"point": "其他反对或质疑", "evidence": "K编号"}],
  "respectsAuthor": "yes | reserved | no：读完后是否仍尊重作者（思想分歧本身不等于不尊重）",
  "follow": "continue | argue | drop | undecided：之后会继续追读、想与作者争论、不再关注、还没想好",
  "indifferent": false,
  "worthWriting": false,
  "authorView": "读完这部之后，他心中这位作者是什么样的：擅长什么、毛病在哪（40字内；可以和以前一样，也可以修正）",
  "changeFromBefore": "与他以前对该作者作品的看法相比有无变化；有变化必须指出改变了以前哪一条看法、因为这部作品的哪一点（无则空）",
  "summary": "不超过100字：此人私下对这部作品的总体看法，思想判断与文学判断分开说"
}`;

/** 证据是否成立：要么引用了证据卡编号，要么有原文短摘 */
const hasEvidence = (ev, card) => {
    const ids = new Set((Array.isArray(card?.keyPoints) ? card.keyPoints : []).map(k => String(k?.id || '').toUpperCase()).filter(Boolean));
    return (Array.isArray(ev) ? ev : ev ? [ev] : []).some(x => {
        if (typeof x === 'string') return /K\d+/i.test(x) ? ids.has(x.match(/K\d+/i)[0].toUpperCase()) : x.trim().length >= 4;
        const w = String(x?.where || ''); const q = String(x?.quote || '').trim();
        return q.length >= 4 || (/K\d+/i.test(w) && ids.has(w.match(/K\d+/i)[0].toUpperCase()));
    });
};
const NEED_EVIDENCE = ['technique', 'argument', 'emotion', 'ideas'];

/** 把模型返回的看法规整成插件使用的形状：维度分数 + 证据；没有证据的维度一律“尚未判断” */
export function normalizeOpinion(op, card) {
    const dims = {}, dimInfo = {}, unjudged = [];
    const raw = op.dimensions && typeof op.dimensions === 'object' ? op.dimensions : {};
    for (const k of Object.keys(DIM)) {
        const d = raw[k];
        const obj = d && typeof d === 'object' && !Array.isArray(d) ? d : { score: d };
        const v = Number(obj.score);
        let score = obj.score == null || obj.score === '' || isNaN(v) ? null : Math.max(-2, Math.min(2, Math.round(v)));
        const ev = (Array.isArray(obj.evidence) ? obj.evidence : obj.evidence ? [obj.evidence] : []).filter(Boolean);
        if (score != null && NEED_EVIDENCE.includes(k) && !hasEvidence(ev, card)) { score = null; unjudged.push(k); }
        dims[k] = score;
        if (obj.note || ev.length) dimInfo[k] = { note: String(obj.note || ''), evidence: ev.map(x => (typeof x === 'string' ? { where: x } : { where: String(x.where || ''), quote: String(x.quote || '') })) };
    }
    op.dimensions = dims;
    op.dimInfo = dimInfo;
    op.unjudged = unjudged;
    op.styleNotes = (Array.isArray(op.styleNotes) ? op.styleNotes : []).filter(x => x && x.aspect && String(x.quote || '').trim().length >= 4);
    const list = v => (Array.isArray(v) ? v : v ? [v] : []).map(x => (typeof x === 'string' ? { point: x } : x)).filter(x => x?.point);
    op.agreedPoints = list(op.agreedPoints);
    op.disagreements = list(op.disagreements).map(x => ({ ...x, key: x.key === true || x.key === 'true' }));
    op.appreciates = list(op.appreciates);
    op.objections = list(op.objections);
    op.respectsAuthor = ['yes', 'reserved', 'no'].includes(op.respectsAuthor) ? op.respectsAuthor : '';
    op.follow = ['continue', 'argue', 'drop', 'undecided'].includes(op.follow) ? op.follow : '';
    return op;
}
export const RESPECT = { yes: '仍尊重作者', reserved: '有所保留', no: '不再看重作者' };
export const FOLLOW = { continue: '会继续追读', argue: '想与作者争论', drop: '不再关注', undecided: '还没想好' };

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
1. 看法只能来自作品本身（见证据卡与原文段落）和此人已有的知识、审美、立场、经历；每一条欣赏或反对都必须引用证据卡编号或原文短摘。
1b. 【证据规则】每个维度的分数都要附 evidence（证据卡编号或原文短摘）。拿不到能说明问题的段落、或他根本不在意这一项，就填 null（尚未判断）。宁可 null，也不要凭印象打分。
1c. 思想判断与文学判断分开：思想上的赞同或反对，不能推出文笔好坏；反之亦然。可以高度赞同思想却嫌文字拖沓，也可以欣赏技巧却反对结论。
1d. 人物档案里的文体偏好只是倾向，不是规则：只有在原文里真的找到对应现象时才触发（例如“不喜欢重复解释”，必须先找到一段重复且没有增加新信息的文字）。同一种写法在这篇里有效、在那篇里拖沓，都是可能的。
1e. 重复不等于冗余：三次谈同一问题、但分别讨论不同方面，是递进；只是换句话说同一件事，才是冗余。必须看段落本身判断，不能数关键词。
1f. 不要用此人自己的文风反推他喜欢什么（体裁和目标不同，标准也会不同）。
2. 推演系统已定：此人${READ_STATES[rec.read]}，总体倾向${['偏批评', '褒贬参半', '偏肯定'][rec.polarity + 1]}，${STRENGTH[rec.strength] || ''}。不得违背。
3. 允许平淡的结果：觉得还行但没什么可说；只读懂一部分；认同论证却反对结论；认为不值得专门写文章。不要为了有趣而制造争议，也不要让人物显得格外深刻。
4. ${rec.read === 'skimmed' ? '此人只读了一部分：只能评论他读到的部分，可以有误解。' : ''}
5. 这是私下看法，不是公开文章。
5b. 各个维度独立判断，不必一致：完全可以“文笔出色、论证粗糙、结论不认同，但觉得作者值得关注”。
5d. 若下面给出了“思想对照”，那是推演按他的议题立场与作品主张对出来的结果：agreedPoints / disagreements 要与之相符，并具体到作品里的论点；关键分歧标 key=true。思想分歧本身不等于不尊重作者。
5e. styleNotes：读原文段落时，按下面的文体清单逐项看一遍，只写他确实会注意到、并且能引出原文短摘的项（通常 0–4 项）；没有把握的项不写。
文体清单：
${STYLE_CHECKLIST.map(([a, b, c]) => `- ${a}：${b}（${c}）`).join('\n')}
5c. 如果他以前读过这位作者的作品，必须对照下面列出的旧看法：保留仍然成立的判断（包括矛盾的判断），只在这部作品确实提供了理由时才修正，并在 changeFromBefore 里写明修正了哪一条。不要编造“作者越来越成熟”之类没有依据的成长线，也不要让他变得无条件欣赏作者。
6. 只输出 JSON：
${OPINION_SCHEMA}`;
    const sl = stanceLines(person), pl = stylePrefLines(person), cl = claimLines(work);
    const cmpText = stanceText(stanceMatch(state, person, work));
    const src = String(work.sourceText || '').trim();
    const passage = src.length >= 200 ? (rec.read === 'skimmed' ? src.slice(0, 2500) : sampleText(src, 6000)) : '';
    const user = `【人物】${person.name}${person.real ? '（真实历史人物）' : ''}
身份：${(person.roles || []).join('、')}；关注：${(person.interests || []).join('、')}
欣赏：${(person.likes || []).join('、') || '—'}；反感：${(person.dislikes || []).join('、') || '—'}
${sl.length ? '议题立场：\n' + sl.map(x => '  - ' + x).join('\n') : '议题立场：未登记'}
${pl.length ? '文体偏好（倾向，需原文触发）：\n' + pl.map(x => '  - ' + x).join('\n') : '文体偏好：未登记'}
备注：${person.notes || '—'}
${hist.length ? '此人以前读这个署名的作品时的看法（按时间先后）：\n' + hist.join('\n') : '此人以前没有读过这个署名的作品（或没有生成过看法）。'}

【作品】《${work.title}》；题材：${workTags(state, work).join('、')}
${cl.length ? '作品的主张：\n' + cl.map(x => '  - ' + x).join('\n') : ''}
${cmpText ? '思想对照（推演结果）：' + cmpText : ''}
${card ? '证据卡：\n' + cardText(card) : `（尚无证据卡，只有摘要：${work.summary || '无'}。没有原文时，技巧、论证、情感一律填 null，styleNotes 留空）`}
${passage ? `\n【他读到的原文段落${rec.read === 'skimmed' ? '（只读了开头一部分）' : '（节选：开头、中段、结尾）'}】\n${passage}` : ''}`;
    const raw = await callLLM({ system, user, settings, maxTokens: 2600, label: `${person.name} 对《${work.title}》的私下看法` });
    const op = extractJSON(raw);
    if (!op || typeof op !== 'object' || !op.summary) throw new Error('模型没有按格式返回看法，请重试');
    normalizeOpinion(op, card);
    op.generatedAt = new Date().toISOString();
    op.withCard = !!card;
    rec.opinion = op;
    return op;
}

// ———— 让模型起草：人物的议题立场与文体偏好、作品的主张 ————

const issuePool = (state, field) => [...new Set((field === 'claims'
    ? (state.works || []).flatMap(w => (w.claims || []).map(c => c?.issue))
    : (state.persons || []).flatMap(p => (p.stances || []).map(c => c?.issue))).filter(Boolean))];

const PROFILE_SCHEMA = `{
  "stances": [{"issue": "议题（短名词，如“死刑”“教会对教育的控制”）", "side": "pro | con | mixed（支持/反对/有保留）", "strength": "1 | 2 | 3（在意程度低/中/高）", "note": "具体立场一句话", "source": "依据：史实/已有书信/推测"}],
  "stylePrefs": [{"aspect": "文体项目（如 解释密度、句子节奏、修辞密度、叙述距离、情绪强度……）", "leaning": "他的倾向，一句话", "tolerance": "1 | 2 | 3（对不合口味的写法：难以容忍/视情况/宽容）", "source": "依据"}]
}`;

export async function draftPersonProfile(state, person, era, settings) {
    const recs = (state.receptions || []).filter(r => r.personId === person.id && r.opinion?.summary)
        .map(r => `- 读《${byId(state.works, r.workId)?.title || '?'}》：${r.opinion.summary}`).slice(-8);
    const evs = (state.ledger || []).filter(e => e.personId === person.id && e.status === 'approved' && (e.text?.summary || e.text?.body))
        .map(e => `- ${e.date} ${e.text?.title ? '「' + e.text.title + '」' : ''}${e.text?.summary || truncate(e.text?.body || '', 200)}`).slice(-10);
    const claimIssues = issuePool(state, 'claims');
    const system = `你在为一个文学反响模拟器整理一位${person.real ? '真实历史人物' : '虚构人物'}的“思想立场”和“文体偏好”档案。
规则：
1. stances：列出此人在政治、伦理、宗教、社会、文艺问题上的立场，4–10 条，优先列与作者作品相关的议题。真实人物以可考的史实为准；只是推测的，source 写“推测”，strength 不要给 3。
2. 议题名要短，尽量沿用下面已有的作品主张议题名，便于对照：${claimIssues.length ? claimIssues.join('、') : '（暂无）'}
3. stylePrefs：此人读文学作品时在意的写法，3–8 条。这些是倾向，不是规则。不要用他自己的文风机械反推他喜欢什么。没有依据的不写。
4. 私交好坏不影响立场。只输出 JSON：
${PROFILE_SCHEMA}`;
    const user = `【人物】${person.name}${(person.aliases || []).length ? '（又名 ' + person.aliases.join('、') + '）' : ''}
时代：${era?.year || ''} ${era?.place || ''}
身份：${(person.roles || []).join('、')}；关注：${(person.interests || []).join('、') || '—'}
欣赏：${(person.likes || []).join('、') || '—'}；反感：${(person.dislikes || []).join('、') || '—'}
备注：${person.notes || '—'}
已登记的立场：${stanceLines(person).join('；') || '无'}
已登记的文体偏好：${stylePrefLines(person).join('；') || '无'}
${recs.length ? '他读主角作品后的私下看法：\n' + recs.join('\n') : ''}
${evs.length ? '他已经写过的评论、书信：\n' + evs.join('\n') : ''}`;
    const raw = await callLLM({ system, user, settings, maxTokens: 1800, label: `起草 ${person.name} 的立场与文体偏好` });
    const out = extractJSON(raw);
    if (!out || typeof out !== 'object') throw new Error('模型没有按格式返回，请重试');
    return {
        stances: (Array.isArray(out.stances) ? out.stances : []).filter(x => x?.issue).map(x => ({ issue: String(x.issue), side: normSide(x.side) || 'mixed', strength: normStrength(x.strength), note: String(x.note || ''), source: String(x.source || '') })),
        stylePrefs: (Array.isArray(out.stylePrefs) ? out.stylePrefs : []).filter(x => x?.aspect).map(x => ({ aspect: String(x.aspect), leaning: String(x.leaning || ''), tolerance: normStrength(x.tolerance), source: String(x.source || '') })),
    };
}

export async function draftWorkClaims(state, work, settings) {
    const src = String(work.sourceText || '').trim();
    if (src.length < 200 && !work.evidence && !work.summary) throw new Error('这部作品没有原文、证据卡或摘要，无从提取主张');
    const stanceIssues = issuePool(state, 'stances');
    const system = `你在为一个文学反响模拟器提取一部作品的“主张”：作品在哪些议题上表明了什么立场。
规则：
1. 只记录作品实际论证或明显表现出的立场；小说、寓言的主张往往是隐含的，note 里说明“隐含”。不要替作者补充他没表达的观点。
2. side：pro 支持 / con 反对 / mixed 有保留（例如“大体反对死刑，但保留极端情况下的例外”就是 mixed）。
3. 议题名要短，尽量沿用下面人物立场里已有的议题名，便于对照：${stanceIssues.length ? stanceIssues.join('、') : '（暂无）'}
4. 2–8 条，where 写出处（证据卡编号或位置）。只输出 JSON：
{"claims": [{"issue": "议题", "side": "pro | con | mixed", "note": "作品具体怎么说（一句话）", "where": "出处"}]}`;
    const user = `作品：《${work.title}》（${FORMS[work.form] || ''}）；题材：${(work.themes || []).join('、')}
${work.summary ? '摘要：' + work.summary : ''}
${work.evidence ? '证据卡：\n' + cardText(work.evidence, 3000) : ''}
${src.length >= 200 ? '原文' + (src.length > 12000 ? '（节选）' : '') + '：\n' + sampleText(src, 12000) : ''}`;
    const raw = await callLLM({ system, user, settings, maxTokens: 1200, label: `提取《${work.title}》的主张` });
    const out = extractJSON(raw);
    const list = Array.isArray(out?.claims) ? out.claims : Array.isArray(out) ? out : null;
    if (!list) throw new Error('模型没有按格式返回，请重试');
    return list.filter(x => x?.issue).map(x => ({ issue: String(x.issue), side: normSide(x.side) || 'mixed', note: String(x.note || ''), where: String(x.where || '') }));
}
