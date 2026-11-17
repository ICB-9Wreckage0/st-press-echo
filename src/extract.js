// extract.js — 从书信簿 / 世界书 / 粘贴文本里抽取人物、刊物、作品、笔名。
// 借鉴 Story World v2 的做法：每条结果必须附带原文依据；没有依据的字段留空；
// 结果先进“待合并”列表，由用户勾选后才写进正式数据。

import { callLLM } from './llm.js';
import { extractJSON } from './util.js';

export function chunkText(text, size = 6000, overlap = 300) {
    const s = String(text || '');
    const out = [];
    let i = 0;
    while (i < s.length) {
        out.push(s.slice(i, i + size));
        if (i + size >= s.length) break;
        i += size - overlap;
    }
    return out;
}

export async function loadWorldbookText(name) {
    const c = globalThis.SillyTavern?.getContext?.();
    if (!c || typeof c.loadWorldInfo !== 'function') throw new Error('当前酒馆版本不支持脚本读取世界书，请改用粘贴文本');
    const data = await c.loadWorldInfo(name);
    if (!data?.entries) throw new Error(`找不到世界书“${name}”`);
    return Object.values(data.entries)
        .filter(e => !e.disable)
        .map(e => `【${e.comment || (e.key || []).join('/') || '条目'}】\n${e.content || ''}`)
        .join('\n\n');
}

const SCHEMA = `{
  "pennames": [{"name": "笔名", "owner": "真实作者（若原文写明）", "evidence": "原文摘录≤40字"}],
  "outlets": [{"name": "刊物名", "periodicity": "daily|weekly|biweekly|monthly|irregular", "politics": ["倾向"], "circle": "critics|literary|general|radical|religious|professional|political", "tier": 3, "weekday": null, "evidence": "原文摘录≤40字"}],
  "persons": [{"name": "姓名", "roles": ["critic|journalist|editor|writer|scholar"], "outletNames": ["供稿刊物"], "interests": ["关注题材"], "likes": ["欣赏的东西"], "dislikes": ["反感的东西"], "closeness": 0, "knowsIdentity": false, "real": true, "notes": "与主角的关系", "evidence": "原文摘录≤40字"}],
  "works": [{"title": "作品名", "penname": "署名", "form": "serial|article|book|pamphlet|translation_serial|translation_book", "outletName": "发表刊物", "pubDate": "YYYY-MM-DD", "endDate": "YYYY-MM-DD 或空", "themes": ["题材标签"], "summary": "50字内", "evidence": "原文摘录≤40字"}],
  "confirmedReactions": [{"date": "YYYY-MM-DD", "person": "谁", "outletName": "在哪（私信则空）", "layer": "review|notice|echo|polemic|private_letter|reader_letters", "work": "针对哪部作品", "polarity": 1, "summary": "内容概要", "evidence": "原文摘录≤40字"}]
}`;

export async function extractFromText(text, settings, onProgress) {
    const chunks = chunkText(text);
    const merged = { pennames: [], outlets: [], persons: [], works: [], confirmedReactions: [] };
    const system = `你是档案整理员。从用户提供的书信簿/设定文本里抽取结构化信息。
规则：
1. 只抽取原文明确写出的内容；没有依据的字段留空或省略，不要用常识补全。
2. closeness 表示与主角的私交：0 陌生，1 认识，2 朋友，3 至交。原文看不出就填 0。
3. knowsIdentity 表示此人是否知道主角就是某个笔名的作者。
4. confirmedReactions 只收录原文明确记载“已经发生”的评论、书评、私信、读者来信。
5. 每条都要给出 evidence（原文摘录，不超过40字）。
6. 只输出 JSON，结构如下：
${SCHEMA}`;
    for (let i = 0; i < chunks.length; i++) {
        onProgress?.(`抽取第 ${i + 1}/${chunks.length} 段…`);
        const raw = await callLLM({ system, user: chunks[i], settings, maxTokens: 3000 });
        let obj;
        try { obj = extractJSON(raw); } catch (e) { onProgress?.(`第 ${i + 1} 段解析失败：${e.message}`); continue; }
        for (const k of Object.keys(merged)) {
            for (const item of obj[k] || []) {
                const nameKey = item.name || item.title || `${item.date}|${item.person}|${item.work}`;
                const exist = merged[k].find(x => (x.name || x.title || `${x.date}|${x.person}|${x.work}`) === nameKey);
                if (exist) Object.assign(exist, Object.fromEntries(Object.entries(item).filter(([, v]) => v !== '' && v != null && !(Array.isArray(v) && !v.length))));
                else merged[k].push(item);
            }
        }
    }
    const proposals = [];
    const kindMap = { pennames: 'penname', outlets: 'outlet', persons: 'person', works: 'work', confirmedReactions: 'reaction' };
    for (const [k, kind] of Object.entries(kindMap)) {
        for (const item of merged[k]) {
            const { evidence, ...data } = item;
            proposals.push({ kind, source: '书信簿抽取', evidence: evidence || '', data });
        }
    }
    return proposals;
}
