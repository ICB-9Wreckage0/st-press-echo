// era.js — 识别故事年代与地点，检索维基百科，生成“年代档案”。
// 年代档案用于两件事：①给写稿的模型提供时代约束（货币、报刊格局、用语、禁用的时代错置事物）；
// ②给主对话注入简短的时代提醒。档案按“年份|地点”缓存，不会每次都重新检索。

import { callLLM } from './llm.js';
import { extractJSON, truncate } from './util.js';
import { monthOf, dayOf, yearOf } from './date.js';

const PLACES = [
    { country: 'France', label: '法国', lang: 'fr', kws: ['巴黎', '法国', '法兰西', '里昂', '马赛', 'paris', 'france', 'lyon', 'marseille'] },
    { country: 'United Kingdom', label: '英国', lang: 'en', kws: ['伦敦', '英国', '英格兰', '苏格兰', 'london', 'england', 'britain'] },
    { country: 'United States', label: '美国', lang: 'en', kws: ['纽约', '美国', '波士顿', '芝加哥', 'new york', 'america', 'boston'] },
    { country: 'Japan', label: '日本', lang: 'ja', kws: ['东京', '日本', '大阪', '京都', '横滨', '江户', 'tokyo', 'japan'] },
    { country: 'China', label: '中国', lang: 'zh', kws: ['北京', '上海', '中国', '大清', '民国', '广州', '天津'] },
    { country: 'Germany', label: '德国', lang: 'de', kws: ['柏林', '德国', '慕尼黑', 'berlin', 'germany'] },
    { country: 'Russia', label: '俄国', lang: 'ru', kws: ['圣彼得堡', '莫斯科', '俄国', '俄罗斯', 'moscow', 'russia'] },
    { country: 'Italy', label: '意大利', lang: 'it', kws: ['罗马', '意大利', '米兰', '那不勒斯', 'rome', 'italy'] },
];

/** 根据文本里的地名粗略猜测地点（用户可在面板里改） */
export function guessPlace(text) {
    const t = String(text || '').toLowerCase();
    let best = null;
    for (const p of PLACES) {
        let n = 0;
        for (const k of p.kws) {
            let i = -1;
            while ((i = t.indexOf(k, i + 1)) >= 0) n++;
        }
        if (n && (!best || n > best.n)) best = { ...p, n };
    }
    return best ? { country: best.country, label: best.label, lang: best.lang } : null;
}

export function eraKey(year, place) {
    return `${year}|${place || '?'}`;
}

export function defaultWikiTitles(year, country, langs) {
    const out = [];
    const L = String(langs || 'fr,en,zh').split(/[,，\s]+/).filter(Boolean);
    const en = { France: 'France', 'United Kingdom': 'the United Kingdom', 'United States': 'the United States', Japan: 'Japan', China: 'China', Germany: 'Germany', Russia: 'Russia', Italy: 'Italy' }[country];
    for (const lang of L) {
        if (lang === 'fr') {
            if (country === 'France') out.push({ lang, title: `${year} en France` });
            out.push({ lang, title: `${year} en littérature` });
        } else if (lang === 'en') {
            if (en) out.push({ lang, title: `${year} in ${en}` });
            out.push({ lang, title: `${year} in literature` });
        } else if (lang === 'zh') {
            out.push({ lang, title: `${year}年` });
        } else if (lang === 'ja') {
            out.push({ lang, title: `${year}年` });
            out.push({ lang, title: `${year}年の文学` });
        } else if (lang === 'de') {
            out.push({ lang, title: `${year}` });
        }
    }
    return out;
}

// —— 维基百科（MediaWiki API 支持跨域：origin=*）——

export async function wikiExtract(lang, title) {
    const url = `https://${lang}.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&exsectionformat=wiki&redirects=1&format=json&origin=*&titles=${encodeURIComponent(title)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`维基百科 ${lang} 返回 ${res.status}`);
    const data = await res.json();
    const pages = data?.query?.pages || {};
    const page = Object.values(pages)[0];
    if (!page || page.missing !== undefined) return null;
    return { lang, title: page.title, text: page.extract || '' };
}

export async function wikiSearch(lang, q, limit = 8) {
    const url = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srlimit=${limit}&format=json&origin=*&srsearch=${encodeURIComponent(q)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`维基百科 ${lang} 返回 ${res.status}`);
    const data = await res.json();
    return (data?.query?.search || []).map(x => ({
        lang, title: x.title, snippet: String(x.snippet || '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&'),
    }));
}

const MONTH_NAMES = {
    fr: ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'],
    en: ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'],
};

function headingMonth(h) {
    const s = h.toLowerCase().trim();
    for (const names of Object.values(MONTH_NAMES)) {
        const i = names.findIndex(n => s === n || s.startsWith(n + ' '));
        if (i >= 0) return i + 1;
    }
    const zh = /^(\d{1,2})月$/.exec(s);
    if (zh) return +zh[1];
    return null;
}

function lineDate(line) {
    const s = line.replace(/^[\s\-*•·]+/, '').toLowerCase();
    let m = /^(1er|\d{1,2})\s+(janvier|f[ée]vrier|mars|avril|mai|juin|juillet|ao[uû]t|septembre|octobre|novembre|d[ée]cembre)/.exec(s);
    if (m) {
        const mon = MONTH_NAMES.fr.findIndex(n => n.normalize('NFD').replace(/[̀-ͯ]/g, '') === m[2].normalize('NFD').replace(/[̀-ͯ]/g, '')) + 1;
        return { m: mon, d: m[1] === '1er' ? 1 : +m[1] };
    }
    m = /^(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})/.exec(s);
    if (m) return { m: MONTH_NAMES.en.indexOf(m[1]) + 1, d: +m[2] };
    m = /^(\d{1,2})月(\d{1,2})日/.exec(s);
    if (m) return { m: +m[1], d: +m[2] };
    return null;
}

/**
 * 剪掉“当前故事日期之后”才发生的内容，防止年代档案剧透未来。
 * 只对“同一年份”的页面生效：按月份小节和以日期开头的行过滤。
 */
export function trimFuture(text, currentIso) {
    if (!currentIso) return text;
    const cm = monthOf(currentIso), cd = dayOf(currentIso);
    const later = (m, d) => m > cm || (m === cm && d !== undefined && d > cd);
    const lines = String(text).split('\n');
    const out = [];
    let skipLevel = 0;
    for (const line of lines) {
        const h = /^(=+)\s*(.+?)\s*=+\s*$/.exec(line);
        if (h) {
            const level = h[1].length;
            if (skipLevel && level > skipLevel) continue;
            skipLevel = 0;
            const mon = headingMonth(h[2]);
            if (mon && later(mon)) { skipLevel = level; continue; }
            out.push(line);
            continue;
        }
        if (skipLevel) continue;
        const ld = lineDate(line);
        if (ld && later(ld.m, ld.d)) continue;
        out.push(line);
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

export async function gatherSources({ year, country, currentIso, titles, settings, onProgress }) {
    const list = titles?.length ? titles : defaultWikiTitles(year, country, settings.wikiLangs);
    const got = [];
    for (const t of list) {
        try {
            onProgress?.(`检索维基百科 ${t.lang}:${t.title}…`);
            const r = await wikiExtract(t.lang, t.title);
            if (r && r.text) {
                const sameYear = new RegExp(`\\b${year}\\b`).test(r.title);
                const text = sameYear ? trimFuture(r.text, currentIso) : r.text;
                got.push({ ...r, text: truncate(text, 7000) });
            }
        } catch (e) {
            got.push({ lang: t.lang, title: t.title, error: String(e.message || e) });
        }
    }
    return got;
}

const PROFILE_SCHEMA = `{
  "year": 1890,
  "place": "法国·巴黎",
  "summary": "120字以内：此时此地的总体时代氛围",
  "currency": "货币与常见价格量级（如：法郎/生丁；日报一份约5生丁）",
  "pressLandscape": [{"name": "刊物原名", "nameZh": "中文译名", "type": "daily|weekly|biweekly|monthly|irregular", "politics": "政治/宗教倾向", "circle": "critics|literary|general|radical|religious|professional|political", "tier": 3, "note": "当时的定位、重要栏目、出刊日"}],
  "critics": [{"name": "原名", "nameZh": "中文名", "venue": "主要供稿刊物", "stance": "趣味与立场", "note": ""}],
  "movements": ["当时活跃的文学/思想潮流"],
  "recentEvents": [{"date": "YYYY-MM", "event": "截至当前日期已经发生、报刊会谈论的事"}],
  "styleNotes": "当时报刊文章的文体特点、常见署名方式、栏目惯例",
  "vocabulary": ["时代用语、称谓、机构名"],
  "forbiddenAnachronisms": ["此时尚不存在、写进去就会穿帮的事物或说法"],
  "seasonFactors": {"1":1,"2":1,"3":1,"4":1,"5":1,"6":1,"7":0.8,"8":0.55,"9":0.85,"10":1,"11":1,"12":0.9},
  "uncertain": ["你不确定、需要用户核对的条目"]
}`;

export async function buildEraProfile({ year, currentIso, placeLabel, sources, notes, settings }) {
    const srcText = (sources || [])
        .filter(s => s.text)
        .map(s => `【维基百科 ${s.lang}：${s.title}】\n${s.text}`)
        .join('\n\n');
    const noteText = (notes || []).map(n => `- ${n.title ? n.title + '：' : ''}${n.text}`).join('\n');
    const system = `你是严谨的历史编辑，熟悉${placeLabel || '该地'}的报刊史、文学史和社会史。你要为一个以 ${currentIso || year} 为“当前日期”的历史故事编写时代档案。
硬性要求：
1. 只能写截至 ${currentIso || year} 已经存在或已经发生的事物；此日期之后的事件、出版物、人物去世等一律不得出现，也不得暗示。
2. 报刊、评论家必须是该时该地真实存在且正在活动的；拿不准的放进 "uncertain"，不要编造。
3. 优先依据下面提供的资料；资料没有覆盖的，用你的历史知识补充，但要更保守。
4. 描述用${settings.outputLanguage || '中文'}，专名保留原文并附译名。
5. 只输出一个 JSON 对象，结构如下：
${PROFILE_SCHEMA}`;
    const user = `当前故事日期：${currentIso || year}
地点：${placeLabel || '未指定'}

${srcText ? '参考资料（已剪掉当前日期之后的条目，但仍可能有遗漏，请再自行把关）：\n' + srcText : '（没有可用的检索资料，请仅凭历史知识保守编写）'}

${noteText ? '用户收集的笔记：\n' + noteText : ''}`;
    const raw = await callLLM({ system, user, settings, maxTokens: 3500 });
    const profile = extractJSON(raw);
    profile.year = profile.year || year;
    profile.asOf = currentIso;
    profile.sources = (sources || []).filter(s => s.text).map(s => `${s.lang}:${s.title}`);
    profile.generatedAt = new Date().toISOString();
    return profile;
}

/** 把年代档案里的真实报刊、评论家转为“待合并建议”，由用户勾选 */
export function profileToProposals(profile) {
    const out = [];
    for (const o of profile?.pressLandscape || []) {
        out.push({
            kind: 'outlet', source: '年代档案',
            evidence: o.note || '',
            data: {
                name: o.nameZh ? `${o.nameZh}（${o.name}）` : o.name,
                periodicity: ['daily', 'weekly', 'biweekly', 'monthly', 'irregular'].includes(o.type) ? o.type : 'irregular',
                politics: String(o.politics || '').split(/[,，、/]+/).map(s => s.trim()).filter(Boolean),
                circle: o.circle || 'general', tier: Number(o.tier) || 3, real: true, note: o.note || '',
            },
        });
    }
    for (const c of profile?.critics || []) {
        out.push({
            kind: 'person', source: '年代档案',
            evidence: c.note || '',
            data: {
                name: c.nameZh ? `${c.nameZh}（${c.name}）` : c.name,
                roles: ['critic'], outletNames: c.venue ? [c.venue] : [],
                interests: String(c.stance || '').split(/[,，、;；]+/).map(s => s.trim()).filter(Boolean).slice(0, 6),
                likes: [], dislikes: [], closeness: 0, monthlyCapacity: 2, real: true, notes: `${c.stance || ''} ${c.note || ''}`.trim(),
            },
        });
    }
    return out;
}

export function yearFromIso(iso) {
    return iso ? yearOf(iso) : null;
}

/** 年代档案的简短文字版，供写稿、看法生成使用 */
export function eraBrief(era, maxLen = 1400) {
    if (!era) return '（尚未生成年代档案：请按你对该年代的知识谨慎写作，避免时代错置。）';
    const parts = [];
    if (era.summary) parts.push(`时代概况：${era.summary}`);
    if (era.currency) parts.push(`货币与物价：${era.currency}`);
    if (era.styleNotes) parts.push(`报刊文体：${era.styleNotes}`);
    if (era.movements?.length) parts.push(`活跃潮流：${era.movements.join('；')}`);
    if (era.recentEvents?.length) parts.push(`近来大家在谈的事：${era.recentEvents.slice(-8).map(e => `${e.date} ${e.event}`).join('；')}`);
    if (era.vocabulary?.length) parts.push(`时代用语：${era.vocabulary.slice(0, 20).join('、')}`);
    if (era.forbiddenAnachronisms?.length) parts.push(`禁止出现（此时尚不存在）：${era.forbiddenAnachronisms.slice(0, 30).join('、')}`);
    return truncate(parts.join('\n'), maxLen);
}
