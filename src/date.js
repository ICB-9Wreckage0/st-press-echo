// date.js — 故事日期：识别（中/法/英/ISO）、计算、星期校验
// 所有日期在内部都用 'YYYY-MM-DD' 字符串，按 UTC 计算，避免时区误差。

const WEEKDAY_ZH = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
const WEEKDAY_FR = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const WEEKDAY_EN = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const MONTHS_FR = {
    janvier: 1, 'février': 2, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7,
    'août': 8, aout: 8, septembre: 9, octobre: 10, novembre: 11, 'décembre': 12, decembre: 12,
};
const MONTHS_EN = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8,
    september: 9, october: 10, november: 11, december: 12,
    jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

const pad = n => String(n).padStart(2, '0');

export function isValidYMD(y, m, d) {
    if (!(y >= 1 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return false;
    const dt = new Date(Date.UTC(y, m - 1, d));
    // 处理公元 100 年以前 Date.UTC 的两位年份怪癖
    if (y < 100) dt.setUTCFullYear(y);
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function toISO(y, m, d) {
    return `${String(y).padStart(4, '0')}-${pad(m)}-${pad(d)}`;
}

export function parseISO(iso) {
    const m = /^(\d{1,4})-(\d{1,2})-(\d{1,2})$/.exec(String(iso || '').trim());
    if (!m) return null;
    const y = +m[1], mo = +m[2], d = +m[3];
    if (!isValidYMD(y, mo, d)) return null;
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (y < 100) dt.setUTCFullYear(y);
    return dt;
}

export function normalizeISO(iso) {
    const dt = parseISO(iso);
    return dt ? fmt(dt) : null;
}

export function fmt(dt) {
    return toISO(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

export function addDays(iso, n) {
    const dt = parseISO(iso);
    if (!dt) return null;
    dt.setUTCDate(dt.getUTCDate() + n);
    return fmt(dt);
}

export function diffDays(a, b) {
    // a - b，单位：天
    const A = parseISO(a), B = parseISO(b);
    if (!A || !B) return NaN;
    return Math.round((A - B) / 86400000);
}

export function weekday(iso) {
    const dt = parseISO(iso);
    return dt ? dt.getUTCDay() : -1;
}

export function weekdayZh(iso) {
    const w = weekday(iso);
    return w >= 0 ? WEEKDAY_ZH[w] : '';
}

export function yearOf(iso) { return +String(iso).slice(0, 4); }
export function monthOf(iso) { return +String(iso).slice(5, 7); }
export function dayOf(iso) { return +String(iso).slice(8, 10); }
export function monthKey(iso) { return String(iso).slice(0, 7); }

export function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

// —— 中文数字 ——
const CN_DIGIT = { '〇': 0, '零': 0, '○': 0, 'Ｏ': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };

function cnYear(s) {
    // 一八九〇 → 1890（逐位）
    let out = '';
    for (const ch of s) {
        if (!(ch in CN_DIGIT)) return NaN;
        out += CN_DIGIT[ch];
    }
    return +out;
}

function cnSmall(s) {
    // 十 / 十二 / 二十 / 二十九 / 三十一 / 九
    if (!s) return NaN;
    if (/^\d+$/.test(s)) return +s;
    const i = s.indexOf('十');
    if (i < 0) return s.length === 1 && s in CN_DIGIT ? CN_DIGIT[s] : NaN;
    const tens = i === 0 ? 1 : CN_DIGIT[s[i - 1]];
    const ones = i === s.length - 1 ? 0 : CN_DIGIT[s[i + 1]];
    if (tens === undefined || ones === undefined) return NaN;
    return tens * 10 + ones;
}

function weekdayNear(text, idx, len) {
    const tail = text.slice(idx + len, idx + len + 16);
    const head = text.slice(Math.max(0, idx - 14), idx);
    let m = /(?:星期|周|礼拜)([一二三四五六日天])/.exec(tail) || /(?:星期|周|礼拜)([一二三四五六日天])/.exec(head);
    if (m) {
        const map = { '日': 0, '天': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6 };
        return map[m[1]];
    }
    const lower = (head + ' ' + tail).toLowerCase();
    for (let i = 0; i < 7; i++) {
        if (lower.includes(WEEKDAY_FR[i]) || lower.includes(WEEKDAY_EN[i])) return i;
    }
    return null;
}

/**
 * 找出文本中所有可识别的日期。
 * 返回 [{iso, index, length, statedWeekday, raw}]
 */
export function findDates(text) {
    const s = String(text || '');
    const out = [];
    const push = (y, m, d, index, length, raw) => {
        if (!isValidYMD(y, m, d)) return;
        out.push({ iso: toISO(y, m, d), index, length, raw, statedWeekday: weekdayNear(s, index, length) });
    };
    let m;
    // 1890年6月24日 / 1890 年 6 月 24 日
    const reZh = /(\d{3,4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/g;
    while ((m = reZh.exec(s))) push(+m[1], +m[2], +m[3], m.index, m[0].length, m[0]);
    // 一八九〇年十月二十九日
    const reCn = /([〇零○Ｏ一二三四五六七八九]{3,4})年([一二三四五六七八九十]{1,3})月([一二三四五六七八九十]{1,3})[日号]/g;
    while ((m = reCn.exec(s))) push(cnYear(m[1]), cnSmall(m[2]), cnSmall(m[3]), m.index, m[0].length, m[0]);
    // 24 juin 1890 / 1er mai 1890
    const reFr = /\b(1er|\d{1,2})\s+(janvier|f[ée]vrier|mars|avril|mai|juin|juillet|ao[uû]t|septembre|octobre|novembre|d[ée]cembre)\s+(\d{3,4})\b/gi;
    while ((m = reFr.exec(s))) {
        const day = m[1].toLowerCase() === '1er' ? 1 : +m[1];
        const mon = MONTHS_FR[m[2].toLowerCase().replace('û', 'u')] || MONTHS_FR[m[2].toLowerCase()];
        push(+m[3], mon, day, m.index, m[0].length, m[0]);
    }
    // June 24, 1890
    const reEn1 = /\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{3,4})\b/gi;
    while ((m = reEn1.exec(s))) push(+m[3], MONTHS_EN[m[1].toLowerCase()], +m[2], m.index, m[0].length, m[0]);
    // 24 June 1890
    const reEn2 = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{3,4})\b/gi;
    while ((m = reEn2.exec(s))) push(+m[3], MONTHS_EN[m[2].toLowerCase()], +m[1], m.index, m[0].length, m[0]);
    // 1890-06-24
    const reIso = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g;
    while ((m = reIso.exec(s))) push(+m[1], +m[2], +m[3], m.index, m[0].length, m[0]);
    // 去重（同一位置被多个正则命中）
    const seen = new Set();
    return out.filter(x => {
        const k = x.index + '|' + x.iso;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    }).sort((a, b) => a.index - b.index);
}

/**
 * 从一条消息里挑出“当前故事日期”。
 * 规则：
 *  - 消息开头（headChars 内）的日期、带星期的日期优先；
 *  - 已有当前日期时：只接受不早于当前日期、且前进不超过 maxJumpDays 的日期
 *    （防止正文里提到的历史日期，如“1887年8月31日处决”，把时间拨回去）；
 *  - 同分取较晚者。
 * 返回 {iso, statedWeekday, weekdayMismatch, raw} 或 null
 */
export function pickStoryDate(text, currentIso, opts = {}) {
    const headChars = opts.headChars ?? 160;
    const maxJump = opts.maxJumpDays ?? 120;
    const allowBackward = !!opts.allowBackward;
    const cands = findDates(text);
    let best = null;
    for (const c of cands) {
        if (currentIso) {
            const delta = diffDays(c.iso, currentIso);
            if (!allowBackward && delta < 0) continue;
            if (delta > maxJump) continue;
        }
        let score = 0;
        if (c.index < headChars) score += 2;
        if (c.statedWeekday !== null) score += 2;
        if (/[（(]\s*(?:星期|周)/.test(String(text).slice(c.index + c.length, c.index + c.length + 4))) score += 1;
        const cand = { ...c, score };
        if (!best || score > best.score || (score === best.score && c.iso > best.iso)) best = cand;
    }
    if (!best) return null;
    const real = weekday(best.iso);
    return {
        iso: best.iso,
        raw: best.raw,
        statedWeekday: best.statedWeekday,
        weekdayMismatch: best.statedWeekday !== null && best.statedWeekday !== real,
    };
}

export { WEEKDAY_ZH };
