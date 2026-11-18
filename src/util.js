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
