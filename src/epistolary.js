// epistolary.js — 与书信簿（st-epistolary）协作。只读，不写回书信簿的档案。
//
// 档案来源有两种：
//  - 实时：书信簿插件把档案挂在 globalThis.epistolary.store.archive 上；
//  - 备份：书信簿“导出备份”得到的 JSON（{kind:'epistolary-backup', archive:{...}}），在面板里直接读取。
//    备份只放在内存里（可能有好几 MB，不适合存进聊天元数据），刷新页面后需要重新读取；
//    已经处理过的线索、已经导入的原文会保存在本聊天里。
// 读进来的内容全部只作“辅助线索”，默认不当作已发生的反响。

import { normalizeISO, cmp } from './date.js';
import { truncate } from './util.js';
import { findByName } from './data.js';

let backup = null; // { archive, fileName, exportedAt, version }

function ctx() { return globalThis.SillyTavern?.getContext?.(); }
function liveArchive() { return globalThis.epistolary?.store?.archive || null; }

// ———————————— 来源 ————————————

/** 读取备份文件内容（已 JSON.parse 的对象）。返回概况 */
export function loadBackup(obj, fileName = '') {
    const archive = obj?.kind === 'epistolary-backup' ? obj.archive : (obj?.letters ? obj : obj?.archive);
    if (!archive || typeof archive.letters !== 'object') throw new Error('这不是书信簿的备份文件（找不到 archive.letters）');
    backup = { archive, fileName, exportedAt: obj.exportedAt || '', version: obj.version || '' };
    return backupInfo();
}

export function clearBackup() { backup = null; }

export function backupInfo() {
    if (!backup) return null;
    const letters = Object.values(backup.archive.letters || {});
    const scopes = {};
    for (const l of letters) {
        const k = l.scope || '';
        scopes[k] = scopes[k] || { key: k, name: l.scopeName || k || '（未归属）', count: 0 };
        scopes[k].count++;
    }
    const dates = letters.map(letterDate).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
    return {
        fileName: backup.fileName, exportedAt: backup.exportedAt, version: backup.version,
        letters: letters.filter(l => l.kind !== 'note').length,
        notes: letters.filter(l => l.kind === 'note').length,
        people: (backup.archive.people || []).length,
        scopes: Object.values(scopes).sort((a, b) => b.count - a.count),
        from: dates[0] || '', to: dates.at(-1) || '',
    };
}

/** 当前用哪份档案：读了备份就用备份，否则用实时插件 */
export function archiveSource() {
    if (backup) return 'backup';
    if (liveArchive()) return 'live';
    return null;
}
function archive() { return backup ? backup.archive : liveArchive(); }

export function epistolaryAvailable() { return !!archive(); }

export function epistolaryStoryDate() {
    const md = ctx()?.chatMetadata;
    return normalizeISO(md?.epistolary?.storyDate || '') || null;
}

function curScopeKey() {
    const c = ctx();
    if (!c) return null;
    if (c.groupId) return `group:${c.groupId}`;
    const ch = c.characters?.[c.characterId];
    return ch ? `char:${ch.avatar || ch.name}` : null;
}

/** 实际使用的角色卡范围。'*' 表示全部 */
export function effectiveScope(state) {
    if (state?.epiScope) return state.epiScope;
    const cur = curScopeKey();
    if (!backup) return cur || '*';
    const info = backupInfo();
    if (cur && info.scopes.some(s => s.key === cur)) return cur;
    return info.scopes.length === 1 ? info.scopes[0].key : '*';
}

function lettersHere(state) {
    const arc = archive();
    if (!arc?.letters) return [];
    const key = effectiveScope(state);
    return Object.values(arc.letters).filter(l => key === '*' || (l.scope || '') === key);
}

// ———————————— 日期 ————————————

/** 一封信的日期：写信日期 → 事件里最早的“写成/寄出”日期 → 投递预计日 */
export function letterDate(l) {
    const w = String(l?.writtenAt || '').trim();
    if (w) return /^\d{4}-\d{2}-\d{2}$/.test(w) ? normalizeISO(w) || w : w;
    const evs = (l?.events || []).filter(e => e?.date && ['written', 'sent'].includes(e.type)).map(e => e.date).sort();
    if (evs.length) return normalizeISO(evs[0]) || evs[0];
    const any = (l?.events || []).filter(e => e?.date).map(e => e.date).sort();
    if (any.length) return normalizeISO(any[0]) || any[0];
    return normalizeISO(l?.delivery?.eta || '') || '';
}

const sameName = (a, b) => {
    const x = String(a || '').replace(/[\s·・.]/g, ''); const y = String(b || '').replace(/[\s·・.]/g, '');
    return !!x && !!y && (x.includes(y) || y.includes(x));
};

/** 某人读到这封信的日期（书信簿事件里的“已读/收到”），没有就返回空 */
function readDateOf(l, name) {
    const evs = (l?.events || []).filter(e => e?.date && ['read', 'received'].includes(e.type) && sameName(e.who, name)).map(e => e.date).sort();
    return evs.length ? normalizeISO(evs[0]) || evs[0] : '';
}

function onOrBefore(written, storyDate) {
    const w = String(written || '').trim();
    if (!storyDate) return true;
    if (!/^\d{4}(-\d{1,2})?(-\d{1,2})?$/.test(w)) return false; // 写不成日期的不参与
    const parts = w.split('-').map(Number);
    const full = normalizeISO(`${parts[0]}-${parts[1] || 1}-${parts[2] || 1}`);
    return full ? cmp(full, storyDate) <= 0 : false;
}

function excerpt(text, idx, len) {
    const a = Math.max(0, idx - 50);
    const b = Math.min(text.length, idx + len + 70);
    return (a > 0 ? '…' : '') + text.slice(a, b).replace(/\s+/g, ' ') + (b < text.length ? '…' : '');
}

// ———————————— 身份 ————————————

function ownerNames(state) {
    const owner = new Set((state.pennames || []).map(p => (p.owner || '').trim()).filter(Boolean));
    const userName = (ctx()?.name1 || '').trim();
    if (userName) owner.add(userName);
    return [...owner];
}
const isOwner = (owners, name) => owners.some(o => sameName(o, name));

/** 不是人的署名：角色卡名（旁白）、“无” */
const CLIPPING = /剪报|argus|coupure|clipping/i;
function notPerson(l, name) {
    const n = String(name || '').trim();
    return !n || n === '无' || n === l.scopeName || `char:${n}` === l.scope || CLIPPING.test(n);
}

/** 这封信算不算“已经发生”：草稿不算；主角写的未寄出且没有任何寄出/收到/阅读记录的也不算 */
function happened(l, owners) {
    if (l.status === 'draft') return false;
    if (l.status === 'unsent' && isOwner(owners, l.author)) {
        return (l.events || []).some(e => ['sent', 'received', 'read'].includes(e.type));
    }
    return true;
}

/** 主角自己的文章稿（书信簿里放在“文章”文件夹、或主角写给无人的长便条） */
function isArticle(l, owners) {
    if (l.kind !== 'note') return false;
    if (/文章|article|稿/i.test(l.folder || '')) return true;
    const rc = (l.recipients || []).filter(r => r && r !== '无');
    return isOwner(owners, l.author) && !rc.length && String(l.body || '').length >= 1500;
}

// ———————————— 作品匹配 ————————————

const normTitle = t => String(t || '').replace(/[《》「」『』“”"'’\s·・]/g, '');

/** 作品的检索词：书名（短书名必须带书名号）+ 别名 */
function workKeys(w) {
    const keys = [];
    const t = String(w.title || '').trim();
    const bare = t.replace(/[《》]/g, '');
    if (bare.length >= 4) keys.push(bare);
    if (bare.length >= 1) keys.push(`《${bare}》`);
    for (const a of w.aliases || []) if (String(a).trim().length >= 3) keys.push(String(a).trim());
    return [...new Set(keys)];
}

/**
 * 扫描书信，找出提到作品/笔名的地方。
 * 返回 [{id, letterId, code, date, author, recipients, workId, workTitle, penname, personName, personId, direction, excerpt, suggestion}]
 */
export function scanLetters(state) {
    if (!epistolaryAvailable()) throw new Error('没有书信簿档案：请装上书信簿插件，或在下面读取书信簿的备份文件');
    const hints = [];
    const titles = (state.works || []).filter(w => w.title).map(w => ({ w, keys: workKeys(w) }));
    const pens = (state.pennames || []).filter(p => p.name).map(p => ({ p, keys: [p.name, p.name.replace(/\s+/g, '')] }));
    const owners = ownerNames(state);
    for (const l of lettersHere(state)) {
        if (isArticle(l, owners) || !happened(l, owners)) continue;
        const date = letterDate(l);
        if (!onOrBefore(date, state.currentDate)) continue;
        const body = String(l.body || '');
        const authorIsOwner = isOwner(owners, l.author);
        const ownerInvolved = authorIsOwner || (l.recipients || []).some(r => isOwner(owners, r));
        const found = new Map();
        for (const { w, keys } of titles) {
            for (const k of keys) {
                const i = body.indexOf(k);
                if (i >= 0) { found.set('w:' + w.id, { work: w, idx: i, len: k.length }); break; }
            }
        }
        // 写给主角或主角写的信里出现笔名是常事（称呼、落款），只在第三方之间的信里才算线索
        if (!ownerInvolved) {
            for (const { p, keys } of pens) {
                for (const k of keys) {
                    const i = body.indexOf(k);
                    if (i >= 0 && ![...found.values()].some(f => f.work?.pennameId === p.id)) { found.set('p:' + p.id, { penname: p, idx: i, len: k.length }); break; }
                }
            }
        }
        for (const f of found.values()) {
            const counterpart = authorIsOwner ? (l.recipients || []).find(r => !notPerson(l, r)) || '' : (notPerson(l, l.author) ? '' : l.author);
            const person = counterpart ? findByName(state.persons, counterpart) : null;
            // 主角写出去的信：对方读到的那天才算得知
            const readAt = authorIsOwner && counterpart ? readDateOf(l, counterpart) : '';
            const hintDate = readAt || date;
            const clipping = CLIPPING.test(l.author || '') || CLIPPING.test(body.slice(0, 200));
            const direction = authorIsOwner ? 'from_user' : ownerInvolved ? 'to_user' : 'third_party';
            hints.push({
                id: `${l.id}|${f.work?.id || f.penname?.id}`,
                letterId: l.id,
                code: l.code || '',
                kind: l.kind || 'letter',
                date: /^\d{4}-\d{2}-\d{2}$/.test(hintDate) ? hintDate : hintDate || '',
                author: l.author || '',
                recipients: l.recipients || [],
                workId: f.work?.id || null,
                workTitle: f.work?.title || '',
                penname: f.penname?.name || '',
                personName: counterpart || '',
                personId: person?.id || null,
                direction,
                excerpt: excerpt(body, f.idx, f.len),
                bodyLength: body.length,
                clipping,
                suggestion: clipping
                    ? '看起来是剪报汇编：里面是已经见报的评论 → 建议“送去抽取”，把其中的评论录入为已发生的反响'
                    : direction === 'from_user'
                    ? `主角在信里向 ${counterpart || '收信人'} 提到此作品${readAt ? `（书信簿记录对方 ${readAt} 读到）` : ''} → 可记为对方“经书信得知”`
                    : direction === 'to_user'
                        ? `${counterpart || '写信人'} 在信里提到此作品 → 可记为此人此前已读过；若信本身就是评论，可记为私信反响`
                        : `${counterpart || '写信人'} 在给第三方的信里谈到 → 说明此人知道这部作品/这个笔名`,
            });
        }
    }
    const done = new Set((state.epiHints || []).filter(h => h.handled).map(h => h.id));
    return hints.filter(h => !done.has(h.id));
}

/** 取一封信的全文（送去抽取用） */
export function letterText(letterId) {
    const l = archive()?.letters?.[letterId];
    if (!l) return '';
    const head = `${l.code || `【${l.id}】`}${l.author || ''} → ${(l.recipients || []).join('、')}（${letterDate(l) || '日期不详'}）`;
    return `${head}\n${l.body || ''}`;
}

// ———————————— 主角的文章稿 ————————————

/** 列出书信簿里的文章稿，并按标题猜测对应哪部作品 */
export function listArticles(state) {
    const owners = ownerNames(state);
    const works = (state.works || []).filter(w => w.title);
    return lettersHere(state).filter(l => isArticle(l, owners)).map(l => {
        const body = String(l.body || '');
        const head = (body.trim().split('\n').find(x => x.trim()) || '').trim();
        const hay = normTitle(`${l.code || ''} ${body.slice(0, 400)}`);
        let match = null;
        let best = 0;
        for (const w of works) {
            for (const k of [w.title, ...(w.aliases || [])].map(normTitle).filter(k => k.length >= 2)) {
                if (hay.includes(k) && k.length > best) { best = k.length; match = w; }
            }
        }
        return {
            id: l.id, code: l.code || '', date: letterDate(l), status: l.status || '', folder: l.folder || '',
            length: body.length, head: truncate(head.replace(/^#+\s*/, ''), 60), matchWorkId: match?.id || '',
        };
    }).sort((a, b) => cmp(a.date || '9999', b.date || '9999'));
}

export function articleBody(letterId) {
    return String(archive()?.letters?.[letterId]?.body || '');
}

// ———————————— 人物 ————————————

/** 书信簿人物档案 + 通信对象 → 待合并建议 */
export function peopleProposals(state) {
    const arc = archive();
    if (!arc) return [];
    const owners = ownerNames(state);
    const out = [];
    const seen = new Set();
    const add = (name, data, evidence) => {
        if (!name || isOwner(owners, name) || seen.has(name) || findByName(state.persons, name)) return;
        seen.add(name);
        out.push({ kind: 'person', source: backup ? '书信簿备份' : '书信簿', evidence, data: { name, roles: [], outletNames: [], interests: [], likes: [], dislikes: [], closeness: 1, ...data } });
    };
    for (const p of arc.people || []) {
        if (!p?.name) continue;
        add(p.name, { real: !!p.historical, notes: p.aliases?.length ? `别名：${p.aliases.join('、')}` : '' }, truncate([p.styleSource, p.styleNotes].filter(Boolean).join('；'), 80) || '书信簿人物档案');
    }
    // 与主角通过信的人：通信越多，私交估得越深（只是建议，合并前请核对）
    const count = {};
    for (const l of lettersHere(state)) {
        if (isArticle(l, owners)) continue;
        const names = isOwner(owners, l.author) ? (l.recipients || []) : [l.author];
        if (!isOwner(owners, l.author) && !(l.recipients || []).some(r => isOwner(owners, r))) continue;
        for (const n of names) if (!notPerson(l, n)) count[n] = (count[n] || 0) + 1;
    }
    for (const [n, c] of Object.entries(count).sort((a, b) => b[1] - a[1])) {
        add(n, { closeness: c >= 8 ? 2 : 1, notes: `与主角通信 ${c} 封（书信簿）` }, `与主角通信 ${c} 封`);
    }
    return out;
}

// ———————————— 写入：把私信寄进书信簿 ————————————
// 只在书信簿插件正在运行时可用（备份文件不能写）。优先借用书信簿自己的 createLetter，
// 保证编号、暗号、文件夹、分段都和手写的信一样；借不到时按书信簿的数据结构自己拼一封。

let epiModel;
async function loadEpiModel() {
    if (epiModel !== undefined) return epiModel;
    epiModel = null;
    for (const dir of ['st-epistolary', 'SillyTavern-Epistolary', 'st-epistolary-main', 'epistolary']) {
        try {
            const m = await import(new URL(`../../${dir}/src/model.js`, import.meta.url).href);
            if (typeof m.createLetter === 'function') { epiModel = m; break; }
        } catch { /* 试下一个目录名 */ }
    }
    return epiModel;
}
export const epistolaryWritable = () => !!globalThis.epistolary?.store?.archive && typeof globalThis.epistolary.store.save === 'function';

function manualLetter(archive, partial) {
    archive.counters = archive.counters || {};
    archive.counters.letter = (archive.counters.letter || 0) + 1;
    const id = `LETTER-${String(archive.counters.letter).padStart(4, '0')}`;
    const now = new Date().toISOString();
    const body = partial.body || '';
    const letter = {
        id, kind: 'letter', status: 'sent', authenticity: 'original', title: partial.title || '', author: partial.author || '', signature: partial.signature || '',
        recipients: partial.recipients || [], writtenAt: partial.writtenAt || '', placeFrom: partial.placeFrom || '', placeTo: '', language: '', tags: [], folder: '',
        scope: partial.scope || '', scopeName: partial.scopeName || '', body, shell: false, code: '',
        segments: body.split(/\n\s*\n/).map(t => t.trim()).filter(Boolean).map((text, i) => ({ id: `S${i + 1}`, text, keywords: [] })),
        events: [], attachments: [], enclosures: [], appearance: {}, links: { works: [] }, inReplyTo: '', importance: '', autoFrom: null, envNote: '', blurb: '', blurbAuto: false, blurbHash: '',
        replied: '', aiDraft: false, openedAt: '', delivery: null, autoDelivery: [], source: null, translations: {}, memories: [], recallKeys: [], codeFloors: [], whereabouts: null,
        notes: partial.notes || '', createdAt: now, updatedAt: now,
    };
    archive.letters[id] = letter;
    return letter;
}

/** 已经寄过的那封（按备注里的标记找） */
export function sentLetterFor(ev) {
    const letters = globalThis.epistolary?.store?.archive?.letters || {};
    return Object.values(letters).find(l => String(l.notes || '').includes(`press-echo:${ev.id}`)) || null;
}

/** 把一条已写好的私信寄进书信簿。返回 { letter, existed } */
export async function sendToEpistolary(state, ev, { person, protagonist = '' } = {}) {
    if (!epistolaryWritable()) throw new Error('书信簿插件没有在运行（读进来的备份文件不能写回）');
    if (ev.layer !== 'private_letter') throw new Error('只有私信能寄进书信簿');
    if (!ev.text?.body) throw new Error('这封私信还没写正文，先写稿');
    if (ev.text.stanceOnly) throw new Error('这封是真实人物的“立场摘要”，不是信的原文。要寄，请在设置里把“真实人物”改成允许拟写全文，再重写这封');
    const old = sentLetterFor(ev);
    if (old) return { letter: old, existed: true };
    const store = globalThis.epistolary.store;
    const archive = store.archive;
    const c = ctx();
    const me = protagonist || c?.name1 || '';
    const sc = curScopeKey();
    const ch = c?.characters?.[c.characterId];
    const partial = {
        kind: 'letter', status: 'sent', author: person?.name || ev.personName || '', signature: ev.text.byline || '',
        recipients: me ? [me] : [], writtenAt: ev.date, title: ev.text.title || '', body: ev.text.body,
        notes: `报刊回声推演出的私信（press-echo:${ev.id}）`,
        ...(sc ? { scope: sc, scopeName: c?.groupId ? '' : ch?.name || '' } : {}),
    };
    const m = await loadEpiModel();
    const letter = m ? m.createLetter(archive, partial) : manualLetter(archive, partial);
    letter.events = letter.events || [];
    const eid = () => `E${letter.events.length + 1}`;
    letter.events.push({ id: eid(), type: 'written', who: letter.author, date: ev.date, segments: null, to: letter.recipients.join('、'), note: '报刊回声推演出的私信', place: '', mes: null, auto: false, chatId: '' });
    letter.events.push({ id: eid(), type: 'sent', who: letter.author, date: ev.date, segments: null, to: letter.recipients.join('、'), note: '', place: '', mes: null, auto: false, chatId: '' });
    store.save();
    try { globalThis.epistolary.ui?.refresh?.(); } catch { /* 书信簿界面没开 */ }
    ev.epiSent = { id: letter.id, code: letter.code || '', at: new Date().toISOString() };
    return { letter, existed: false };
}
