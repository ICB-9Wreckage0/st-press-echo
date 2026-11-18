// data.js — 增删改与“待合并建议”的落地

import { uid, parseTags } from './util.js';
import { normalizeISO } from './date.js';
import { setStatus } from './engine.js';

const norm = s => String(s || '').toLowerCase().replace(/[《》「」『』“”"'（）()\s·・.]/g, '');

export function findByName(list, name, field = 'name') {
    const n = norm(name);
    if (!n) return null;
    return (list || []).find(x => norm(x[field]) === n)
        || (list || []).find(x => { const m = norm(x[field]); return m && (m.includes(n) || n.includes(m)); })
        || null;
}

export function blankPenname() {
    return { id: uid('pen'), name: '', owner: '', publicIdentityKnown: false, knownBy: [] };
}
export function blankOutlet() {
    return { id: uid('out'), name: '', periodicity: 'daily', weekday: null, monthDays: [], politics: [], circle: 'general', tier: 3, sections: [], capacity: null, deadlineDays: null, real: true, note: '' };
}
export function blankPerson() {
    return { id: uid('per'), name: '', roles: ['critic'], outletIds: [], interests: [], likes: [], dislikes: [], closeness: 0, monthlyCapacity: 2, columnWeekday: null, reads: [], busy: '', relations: [], knowsIdentity: false, real: true, active: true, notes: '' };
}
export function blankWork() {
    return { id: uid('wrk'), title: '', pennameId: '', form: 'serial', outletId: '', pubDate: '', endDate: '', themes: [], aliases: [], series: '', summary: '', parentId: '', sourceText: '', sourceFrom: [], evidence: null };
}

function ensurePenname(state, name) {
    if (!name) return '';
    let p = findByName(state.pennames, name);
    if (!p) {
        p = { ...blankPenname(), name };
        state.pennames.push(p);
    }
    return p.id;
}

function ensureOutletId(state, name) {
    if (!name) return '';
    const o = findByName(state.outlets, name);
    return o ? o.id : '';
}

/** 落地一条建议；返回说明文字 */
export function applyProposal(state, prop) {
    const d = prop.data || {};
    switch (prop.kind) {
    case 'penname': {
        const ex = findByName(state.pennames, d.name);
        if (ex) { if (d.owner) ex.owner = d.owner; return `笔名“${d.name}”已存在，已更新`; }
        state.pennames.push({ ...blankPenname(), name: d.name, owner: d.owner || '' });
        return `新增笔名“${d.name}”`;
    }
    case 'outlet': {
        const ex = findByName(state.outlets, d.name);
        const obj = {
            name: d.name,
            periodicity: d.periodicity || 'irregular',
            weekday: Number.isInteger(d.weekday) ? d.weekday : null,
            politics: parseTags(d.politics),
            circle: d.circle || 'general',
            tier: Number(d.tier) || 3,
            real: d.real !== false,
            note: d.note || '',
        };
        if (ex) { Object.assign(ex, Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== '' && v != null))); return `刊物“${d.name}”已存在，已更新`; }
        state.outlets.push({ ...blankOutlet(), ...obj });
        return `新增刊物“${d.name}”`;
    }
    case 'person': {
        const outletIds = (d.outletNames || []).map(n => ensureOutletId(state, n)).filter(Boolean);
        const obj = {
            name: d.name,
            roles: (d.roles || ['critic']).filter(Boolean),
            outletIds,
            interests: parseTags(d.interests),
            likes: parseTags(d.likes),
            dislikes: parseTags(d.dislikes),
            closeness: Math.max(0, Math.min(3, Number(d.closeness) || 0)),
            monthlyCapacity: Number(d.monthlyCapacity) || 2,
            knowsIdentity: !!d.knowsIdentity,
            real: d.real !== false,
            notes: d.notes || '',
        };
        const ex = findByName(state.persons, d.name);
        if (ex) {
            for (const [k, v] of Object.entries(obj)) {
                if (Array.isArray(v) ? v.length : v !== '' && v != null) ex[k] = Array.isArray(v) && Array.isArray(ex[k]) ? [...new Set([...ex[k], ...v])] : v;
            }
            return `人物“${d.name}”已存在，已合并`;
        }
        state.persons.push({ ...blankPerson(), ...obj });
        return `新增人物“${d.name}”${outletIds.length < (d.outletNames || []).length ? '（部分供稿刊物未找到，请先合并刊物再合并人物）' : ''}`;
    }
    case 'work': {
        const obj = {
            title: d.title,
            pennameId: ensurePenname(state, d.penname),
            form: d.form || 'serial',
            outletId: ensureOutletId(state, d.outletName),
            pubDate: normalizeISO(d.pubDate) || '',
            endDate: normalizeISO(d.endDate) || '',
            themes: parseTags(d.themes),
            summary: d.summary || '',
        };
        const ex = findByName(state.works, d.title, 'title');
        if (ex) { Object.assign(ex, Object.fromEntries(Object.entries(obj).filter(([, v]) => (Array.isArray(v) ? v.length : v !== '' && v != null)))); return `作品《${d.title}》已存在，已更新`; }
        state.works.push({ ...blankWork(), ...obj });
        return `新增作品《${d.title}》`;
    }
    case 'reaction': {
        const date = normalizeISO(d.date);
        if (!date) return `跳过：反响缺少有效日期（${d.summary || ''}）`;
        const work = findByName(state.works, d.work, 'title');
        const person = findByName(state.persons, d.person);
        const ev = {
            id: uid('ev'), key: null, origin: 'manual', date,
            layer: d.layer || 'notice',
            personId: person?.id || null,
            personName: person ? undefined : d.person,
            outletId: ensureOutletId(state, d.outletName) || null,
            workId: work?.id || null,
            pennameId: work?.pennameId || null,
            polarity: Number(d.polarity) || 0,
            status: 'candidate', text: d.summary ? { summary: d.summary, body: '', title: '', byline: '', section: '' } : null,
            flags: ['来自书信簿：模拟中已确认发生'], repApplied: null,
        };
        state.ledger.push(ev);
        setStatus(state, ev, 'approved');
        return `录入已发生反响：${date} ${d.person || ''}`;
    }
    default:
        return '未知类型';
    }
}

export function addManualEvent(state, fields) {
    const ev = {
        id: uid('ev'), key: null, origin: 'manual',
        date: normalizeISO(fields.date) || state.currentDate,
        layer: fields.layer || 'notice',
        personId: fields.personId || null,
        outletId: fields.outletId || null,
        workId: fields.workId || null,
        pennameId: fields.pennameId || (state.works.find(w => w.id === fields.workId)?.pennameId ?? null),
        polarity: Number(fields.polarity) || 0,
        count: fields.count ? Number(fields.count) : undefined,
        status: 'candidate',
        text: fields.summary ? { summary: fields.summary, body: '', title: '', byline: '', section: '' } : null,
        flags: ['手动录入'], repApplied: null,
        // 私信的收信人：'protagonist' = 主角；其他人名 = 别人之间的信（主角要等 knownAt 才知道）
        to: fields.layer === 'private_letter' ? (fields.to || 'protagonist') : null,
        knownAt: normalizeISO(fields.knownAt) || (fields.layer !== 'private_letter' || !fields.to || fields.to === 'protagonist' ? (normalizeISO(fields.date) || state.currentDate) : null),
    };
    state.ledger.push(ev);
    if (fields.approved) setStatus(state, ev, 'approved');
    return ev;
}
