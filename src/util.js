// util.js — 通用小工具（无宿主依赖，可在 node 中测试）

export function uid(prefix = 'id') {
    return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}

export function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** 把 “宗教, 法律、死刑，政治” 这类输入拆成标签数组 */
export function parseTags(v) {
    if (Array.isArray(v)) return v.map(s => String(s).trim()).filter(Boolean);
    return String(v ?? '')
        .split(/[,，、;；\n]+/)
        .map(s => s.trim())
        .filter(Boolean);
}

export function tagsToText(arr) {
    return (arr || []).join('，');
}

/** 标签重叠数（大小写不敏感，允许互相包含：“死刑” 匹配 “死刑制度”） */
export function overlapCount(a, b) {
    const A = (a || []).map(s => s.toLowerCase());
    const B = (b || []).map(s => s.toLowerCase());
    let n = 0;
    for (const x of B) {
        if (A.some(y => y === x || (y.length >= 2 && x.includes(y)) || (x.length >= 2 && y.includes(x)))) n++;
    }
    return n;
}

export function deepClone(o) {
    return JSON.parse(JSON.stringify(o));
}

/** 从模型输出里尽量取出 JSON（容忍代码块、前后杂字） */
export function extractJSON(text) {
    if (!text) throw new Error('模型返回为空');
    let t = String(text).trim();
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) t = fence[1].trim();
    const firstObj = t.indexOf('{');
    const firstArr = t.indexOf('[');
    let start = -1;
    let endCh = '}';
    if (firstObj >= 0 && (firstArr < 0 || firstObj < firstArr)) { start = firstObj; endCh = '}'; }
    else if (firstArr >= 0) { start = firstArr; endCh = ']'; }
    if (start < 0) throw new Error('模型返回中找不到 JSON');
    const end = t.lastIndexOf(endCh);
    if (end <= start) throw new Error('模型返回的 JSON 不完整（可能被截断）');
    const body = t.slice(start, end + 1);
    try {
        return JSON.parse(body);
    } catch (e) {
        // 常见问题：尾逗号
        let fixed = body.replace(/,\s*([}\]])/g, '$1');
        try { return JSON.parse(fixed); } catch { /* 继续修 */ }
        // 从网页复制时常见：Markdown 把 _ * [ ] 转义成 \_ 等；Python 风格的 None/True/False；中文引号当结构引号
        fixed = fixed
            .replace(/\\([_*\[\]#~`>|-])/g, '$1')
            .replace(/([:\[,]\s*)None(?=\s*[,}\]])/g, '$1null')
            .replace(/([:\[,]\s*)True(?=\s*[,}\]])/g, '$1true')
            .replace(/([:\[,]\s*)False(?=\s*[,}\]])/g, '$1false');
        return JSON.parse(fixed);
    }
}

export function truncate(s, n) {
    s = String(s ?? '');
    return s.length > n ? s.slice(0, n) + '…' : s;
}

/**
 * 是不是剧情楼层。酒馆“隐藏楼层”只是把 is_system 设为 true，内容还是剧情；
 * 真正的系统提示（帮助、欢迎语、斜杠命令结果）会带 extra.type，且名字通常是 SillyTavern System。
 * includeHidden=false 时，隐藏的楼层也不算。
 */
export function isStoryMessage(m, includeHidden = true) {
    if (!m || typeof m.mes !== 'string' || !m.mes.trim()) return false;
    if (!m.is_system) return true;
    if (!includeHidden) return false;
    const type = m.extra?.type;
    if (type && type !== 'narrator') return false;
    if (/^SillyTavern System$/i.test(m.name || '')) return false;
    return true;
}

/**
 * 从一楼正文里取出摘要块（如 <Narrative_Matrix>…</Narrative_Matrix>）。tags 为标签名，逗号分隔。
 * 没有就返回空串。外面包的 <details><summary> 不要。
 */
export function extractSummary(text, tags = 'Narrative_Matrix') {
    const t = String(text || '');
    const out = [];
    for (const tag of String(tags || '').split(/[,，\s]+/).map(x => x.trim()).filter(Boolean)) {
        const esc = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`<${esc}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${esc}>`, 'gi');
        for (const m of t.matchAll(re)) if (m[1].trim()) out.push(m[1].trim());
    }
    return out.join('\n');
}

/** 去掉混在正文里的思维链：<think>…</think>、<thinking>、<reasoning>（含没闭合、写到开头的情况）。酒馆单独存的 extra.reasoning 本来就不读 */
export function stripThinking(text) {
    let t = String(text || '');
    t = t.replace(/<(think|thinking|reasoning|thought)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi, '');
    t = t.replace(/^[\s\S]*?<\/(think|thinking|reasoning|thought)>/i, ''); // 只有结尾标签：前面整段都是思考
    t = t.replace(/<(think|thinking|reasoning|thought)(?:\s[^>]*)?>[\s\S]*$/i, ''); // 只有开头标签：后面整段都是思考
    return t.trim();
}

export const TEXT_LANG = { '': '自动判断', fr: '法文原文', zh: '中文稿（故事里实际以法文刊出）', bi: '法中对照', other: '其他语言稿' };
/** 作品手头这份原文是什么语言：填了就用填的，否则按样本里汉字占比猜 */
export function textLangOf(work, sample = '') {
    if (work?.textLang) return work.textLang;
    const t = String(sample || work?.sourceText || '').slice(0, 20000);
    if (!t) return '';
    // 一个汉字约等于四五个拉丁字母的信息量，按 4 折算
    const cjk = (t.match(/[\u4e00-\u9fff\u3040-\u30ff]/g) || []).length, lat = (t.match(/[A-Za-zÀ-ÿ]/g) || []).length / 4;
    if (cjk && lat && Math.min(cjk, lat) / (cjk + lat) > 0.2) return 'bi';
    return cjk > lat ? 'zh' : lat ? 'fr' : '';
}
/** 原文不是法文时给模型的提醒 */
export function langRule(lang) {
    if (lang === 'zh') return '注意：手头这份原文是中文稿，故事里这部作品是以法文刊出的。可以据此判断内容、结构、意象、论证和叙事节奏，但不要把中文句子当作他读到的法文原句加引号引用，也不要评论具体的法文用词、语法和音韵；需要引用时写“某段写到……”的转述。';
    if (lang === 'bi') return '注意：手头这份原文是法中对照。引用他读到的字句只用法文部分；中文部分只是对照，不是他读到的。';
    if (lang === 'other') return '注意：手头这份原文不是故事里刊出时的语言。只据此判断内容与结构，不要把它当作他读到的原句引用或评论字词。';
    return '';
}
