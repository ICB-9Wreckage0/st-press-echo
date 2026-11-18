// concepts.js — 标签语义匹配。
//
// 问题：人物的“关注 / 欣赏 / 反感”和作品的“题材”是不同时候、不同人（或不同 AI）填的，
// “家庭责任”“长子困境”“道德义务”意思相近却不是同一个词，按字面匹配就会全部落空，
// 推演出来的人都“读了但印象不深”。
//
// 做法：
//  1. 有标签改动时调一次模型，把所有标签归进几十个“概念组”，结果存起来；之后推演不再调用模型。
//  2. 没归类的标签，用字面规则兜底：相同或互相包含算完全匹配；只共用两个汉字的词根（如“家庭”）算弱匹配，
//     弱匹配只用于判断“有没有兴趣”，不用于判断褒贬（“资本批判”和“资本家施舍”词根相同，立场却相反）。

import { callLLM } from './llm.js';
import { extractJSON } from './util.js';

let current = null; // { map: {tag: [groupIndex]}, groups: [name] }

/** 推演入口处调用：使用这一份聊天的概念表 */
export function useConcepts(c) { current = c && c.map ? c : null; }

const norm = s => String(s || '').toLowerCase().trim();
const STOP = new Set(['主义', '文学', '作品', '文化', '精神', '意识', '问题', '生活', '现代', '形式', '思想', '艺术', '人物', '故事', '小说', '主题', '风格']);

function bigrams(s) {
    const t = norm(s).replace(/[^\p{Script=Han}]/gu, '');
    const out = new Set();
    for (let i = 0; i + 1 < t.length; i++) { const b = t.slice(i, i + 2); if (!STOP.has(b)) out.add(b); }
    return out;
}
function latinWords(s) {
    return new Set((norm(s).match(/[a-zàâäçéèêëîïôöùûüÿœæ]{4,}/g) || []));
}
function groupsOf(tag) {
    if (!current) return null;
    return current.map[norm(tag)] || null;
}

/**
 * 两个标签的相近程度：1 完全/包含，0.75 同一概念组，0.4 共用词根（weak=true 时才算）
 */
export function tagSim(x, y, weak = true) {
    const a = norm(x), b = norm(y);
    if (!a || !b) return 0;
    if (a === b || (a.length >= 2 && b.includes(a)) || (b.length >= 2 && a.includes(b))) return 1;
    const ga = groupsOf(a), gb = groupsOf(b);
    if (ga && gb && ga.some(g => gb.includes(g))) return 0.75;
    if (!weak) return 0;
    const ba = bigrams(a), bb = bigrams(b);
    for (const g of ba) if (bb.has(g)) return 0.4;
    const la = latinWords(a), lb = latinWords(b);
    for (const w of la) if (lb.has(w)) return 0.4;
    return 0;
}

/** b 里每个标签在 a 里找最相近的一个，加总（可以是小数） */
export function matchCount(a, b, weak = true) {
    const A = (a || []).filter(Boolean);
    let n = 0;
    for (const x of b || []) {
        let best = 0;
        for (const y of A) { const v = tagSim(y, x, weak); if (v > best) best = v; if (best === 1) break; }
        n += best;
    }
    return n;
}

// ———————————— 归类 ————————————

export function allTags(state) {
    const set = new Set();
    const add = arr => (arr || []).forEach(t => { const n = norm(t); if (n) set.add(n); });
    for (const w of state.works || []) add(w.themes);
    for (const o of state.outlets || []) add(o.politics);
    for (const p of state.persons || []) { add(p.interests); add(p.likes); add(p.dislikes); }
    return [...set];
}

export function unclassified(state) {
    const map = state.concepts?.map || {};
    return allTags(state).filter(t => !map[t]);
}

/** 调模型归类。已归类的保留，只补新标签（除非 full=true 全部重来） */
export async function buildConcepts(state, settings, { full = false, onProgress } = {}) {
    const tags = full ? allTags(state) : unclassified(state);
    if (!tags.length) return state.concepts;
    const groups = full ? [] : [...(state.concepts?.groups || [])];
    const map = full ? {} : { ...(state.concepts?.map || {}) };
    const batches = [];
    for (let i = 0; i < tags.length; i += 160) batches.push(tags.slice(i, i + 160));
    for (let bi = 0; bi < batches.length; bi++) {
        onProgress?.(`归类标签 ${bi + 1}/${batches.length}`);
        const system = `你在为一个文学评论推演系统整理标签。标签来自作品题材、刊物倾向、人物的关注点和好恶。
把意思相近、讨论同一类话题的标签归进同一个“概念组”。
规则：
1. 按话题归类，不按褒贬：“资本批判”和“资本家施舍”都属于“资本与财富”。
2. 一个标签最多属于 2 个组；实在归不了类的可以单独成组。
3. 组名用简短中文（2–6 字）。尽量沿用已有的组名。
4. 只输出 JSON：{"groups":[{"name":"组名","tags":["标签",...]}]}，tags 里的标签必须原样照抄。`;
        const user = `${groups.length ? `已有的组：${groups.join('、')}\n\n` : ''}要归类的标签：\n${batches[bi].join('、')}`;
        const raw = await callLLM({ system, user, settings, maxTokens: 4000, label: `归类标签 ${bi + 1}/${batches.length}` });
        const obj = extractJSON(raw);
        for (const g of obj.groups || []) {
            const name = String(g.name || '').trim();
            if (!name) continue;
            let gi = groups.indexOf(name);
            if (gi < 0) { groups.push(name); gi = groups.length - 1; }
            for (const t of g.tags || []) {
                const n = norm(t);
                if (!n) continue;
                map[n] = [...new Set([...(map[n] || []), gi])].slice(0, 2);
            }
        }
    }
    state.concepts = { map, groups, builtAt: new Date().toISOString() };
    return state.concepts;
}

/** 概念组 → 标签列表（显示用） */
export function conceptGroups(state) {
    const c = state.concepts;
    if (!c?.groups) return [];
    const out = c.groups.map(name => ({ name, tags: [] }));
    for (const [t, gs] of Object.entries(c.map || {})) for (const g of gs) out[g]?.tags.push(t);
    return out.filter(g => g.tags.length).sort((a, b) => b.tags.length - a.tags.length);
}
