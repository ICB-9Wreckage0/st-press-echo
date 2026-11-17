// txtimport.js — 把作品的 txt 文件批量导入为作品，按文件名判断刊物和首发日期。
//
// 文件名约定（都可以省略一部分）：
//   作品名-刊物名1890-4-12.txt       长子-回声报-1890-4-15.txt      石田日记-回声报1890-5-1.txt
//   生者与死亡1-小册子1890-5-1.txt   生者与死亡3-上-1890-9-1.txt    日语简明入门（……）1890-6中.txt
// 规则：
//   - 末尾的日期是首次发表日（连载取第一期）。只有年月、或写“上/中/下旬”的，记为约略日期，需要你确认；
//   - 日期前、最后一个“-”之后的是刊物名；“小册子/单行本/附赠本”等不是刊物，而是作品形式；
//   - 只有一个字的“上/中/下”之类是作品的分篇，并回作品名；
//   - 文件名开头的 0、AA 之类排序前缀会去掉；没有日期的视为未发表的稿子或资料，默认不导入。

import { normalizeISO } from './date.js';
import { findByName } from './data.js';

const FORM_WORDS = [
    [/单行本|成书|书籍/, 'book'],
    [/小册子|附赠本?|册子/, 'pamphlet'],
];
const PART_RE = /^(上|中|下|上篇|下篇|前篇|后篇|续|[一二三四五六七八九十]+|\d{1,2}|改前|改后|初稿|定稿|草稿|修订版?|直译|译稿|原文|删节版?)$/;

/** 去掉文件名开头的排序前缀：0、00、AA、A1 之类（后面紧跟非数字时才去，免得把“1999年”切掉） */
function stripPrefix(s) {
    return s.replace(/^(?:0+|[A-Z]{1,3}\d?)(?=[^\dA-Za-z])/, '').replace(/^[-_\s.]+/, '');
}

/**
 * 解析文件名。返回 { title, outletName, form, date, dateApprox, dateRaw, isDraft }
 * date 是 YYYY-MM-DD（约略日期也会给出一个近似值，dateApprox=true）
 */
export function parseFileName(fileName) {
    let base = String(fileName || '').replace(/\.(txt|md|text)$/i, '').trim();
    const prefixed = base !== stripPrefix(base);
    base = stripPrefix(base);
    let date = '', dateApprox = false, dateRaw = '';
    // 末尾日期：1890-4-12 / 1890.4.12 / 1890年4月12日 / 1890-6中 / 1890-6
    const m = base.match(/[-_\s]*(1[5-9]\d\d|20\d\d)\s*[-.年/_]\s*(\d{1,2})\s*(?:[-.月/_]\s*(\d{1,2})\s*日?|月?\s*([上中下])旬?|月)?\s*$/);
    if (m) {
        dateRaw = m[0].replace(/^[-_\s]+/, '');
        const [, y, mo, d, xun] = m;
        if (d) date = normalizeISO(`${y}-${mo}-${d}`) || '';
        else { date = normalizeISO(`${y}-${mo}-${xun ? { 上: 5, 中: 15, 下: 25 }[xun] : 1}`) || ''; dateApprox = true; }
        base = base.slice(0, m.index).replace(/[-_\s]+$/, '');
    }
    // 拆作品名和刊物名：最后一个“-”
    let title = base, outletName = '', form = '';
    const parts = base.split(/\s*[-—_]\s*/).filter(Boolean);
    if (parts.length >= 2) {
        const last = parts[parts.length - 1];
        if (PART_RE.test(last)) {
            title = parts.join('-');
        } else {
            title = parts.slice(0, -1).join('-');
            outletName = last;
        }
    }
    for (const [re, f] of FORM_WORDS) {
        if (outletName && re.test(outletName)) { form = f; outletName = ''; break; }
    }
    return { title: title.trim(), outletName: outletName.trim(), form, date, dateApprox, dateRaw, isDraft: !date, prefixed };
}

const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
/** 比较用：去标点；“第一册/第1期/卷二”统一成数字 */
const normT = t => String(t || '')
    .replace(/[《》「」『』“”"'\s·・\-—_（）()]/g, '')
    .replace(/第?([一二三四五六七八九十]|\d+)[册期卷部集回章篇]?/g, (_, n) => String(CN_NUM[n] || n))
    .toLowerCase();

function editDistance(a, b) {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    return d[a.length][b.length];
}

/** 结合现有数据给出导入建议 */
export function planImport(state, fileName, text) {
    const p = parseFileName(fileName);
    const outlet = p.outletName ? findByName(state.outlets, p.outletName) : null;
    // 已有作品：名字相同，或一方包含另一方且相差不多
    const nt = normT(p.title);
    const existing = (state.works || []).find(w => normT(w.title) === nt)
        || (state.works || []).find(w => { const a = normT(w.title); return a.length >= 2 && nt.length >= 2 && (a.includes(nt) || nt.includes(a)) && Math.abs(a.length - nt.length) <= 2; })
        || (state.works || []).find(w => { const a = normT(w.title); return a.length >= 4 && nt.length >= 4 && editDistance(a, nt) <= 1; });
    let form = p.form;
    if (!form && existing?.form) form = existing.form;
    if (!form) {
        const per = outlet?.periodicity;
        const len = String(text || '').length;
        if (/日记|译/.test(p.title) && per === 'daily') form = 'translation_serial';
        else if (per === 'daily' && len > 12000) form = 'serial';
        else form = 'article';
    }
    return {
        fileName,
        title: p.title,
        outletName: p.outletName,
        outletId: outlet?.id || '',
        newOutlet: !!p.outletName && !outlet,
        form,
        date: p.date,
        dateApprox: p.dateApprox,
        dateRaw: p.dateRaw,
        length: String(text || '').length,
        action: p.isDraft ? 'skip' : existing ? 'update' : 'new',
        workId: existing?.id || '',
        isDraft: p.isDraft,
    };
}

/** 读 txt：先按 UTF-8 解，解不开再按 GB18030（Windows 上中文 txt 常见） */
export async function readTextFile(file) {
    const buf = await file.arrayBuffer();
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, '');
    } catch {
        try { return new TextDecoder('gb18030').decode(buf); } catch { return new TextDecoder('utf-8').decode(buf); }
    }
}
