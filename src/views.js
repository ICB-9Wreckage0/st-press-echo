// views.js — 两张图：作品反响时间线、人物关系网。只读，不改数据。
// 颜色只表达一件事：褒贬（绿=肯定、金=参半、红=批评）或私交深浅（与人物卡片同色）；
// 泳道、线型和文字标签负责身份，所以不靠颜色也能读。

import { byId, LAYERS, READ_STATES, STRENGTH, CHANNELS, REL_TYPES, REL_BASIS, ROLES, knowsPen, effectivePubDate, READ_DONE, relCat, relOn, isMutual, relationsOf } from './engine.js';
import { cmp, addDays, diffDays } from './date.js';
import { escapeHtml as h, truncate } from './util.js';

const POL_COLOR = { 1: 'var(--pe-good)', 0: 'var(--pe-mid)', '-1': 'var(--pe-bad)' };
const POL_TXT = { 1: '偏肯定', 0: '参半', '-1': '偏批评' };
export const CLOSE_COLOR = { 0: '#8a8f98', 1: '#6fa8dc', 2: '#7fc48f', 3: '#e78fb3' };
const CLOSE = ['陌生', '认识', '朋友', '至交'];
const normT = t => String(t || '').replace(/[《》「」\s·]/g, '').toLowerCase();

// ———————————— 作品反响时间线 ————————————

/** 收集一部作品到今天为止的所有动静（不含未来，不剧透） */
export function workTimeline(st, workId) {
    const w = byId(st.works, workId);
    if (!w) return null;
    const today = st.currentDate;
    // 首发日期不确定（只知道“不晚于”等）时，推算的首发日可能早于登记的日期
    const eff = effectivePubDate(st, w);
    const start = eff && w.pubDate && cmp(eff, w.pubDate) < 0 ? eff : w.pubDate;
    const ok = d => d && (!today || cmp(d, today) <= 0) && (!start || cmp(d, start) >= 0);
    const name = id => byId(st.persons, id)?.name || '';
    const items = [];
    for (const e of st.ledger || []) {
        if (e.workId !== w.id || e.status !== 'approved' || !ok(e.date)) continue;
        const o = byId(st.outlets, e.outletId);
        const agg = e.layer === 'reader_letters' || e.layer === 'mentions';
        items.push({
            lane: e.layer === 'private_letter' ? 'letter' : agg ? 'agg' : 'press', date: e.date, pol: agg ? null : e.polarity, size: agg ? Math.min(16, 6 + Math.sqrt(e.count || 1)) : 6,
            label: agg ? `${LAYERS[e.layer]?.label} 约 ${e.count}` : `${o ? '《' + o.name + '》' : ''}${name(e.personId) || e.personName || ''}`,
            tip: `${e.date} ${LAYERS[e.layer]?.label || ''}\n${o ? '《' + o.name + '》 ' : ''}${name(e.personId) || e.personName || ''}${agg ? ` 约 ${e.count}` : '，' + POL_TXT[e.polarity]}${e.text?.summary ? '\n' + truncate(e.text.summary, 80) : ''}`,
        });
    }
    for (const r of st.receptions || []) {
        if (r.workId !== w.id) continue;
        if (READ_DONE.includes(r.read) && ok(r.readDate)) {
            items.push({ lane: 'read', date: r.readDate, pol: r.polarity ?? 0, hollow: r.read !== 'finished', size: r.strength === 'strong' ? 7 : 5.5, label: name(r.personId),
                tip: `${r.readDate} ${name(r.personId)} ${READ_STATES[r.read]}\n${CHANNELS[r.channel] || ''}（${r.contactDate || ''} 接触）\n${POL_TXT[r.polarity ?? 0]}，${STRENGTH[r.strength] || ''}${r.opinion?.summary ? '\n' + truncate(r.opinion.summary, 80) : ''}` });
        } else if (r.read === 'ignored' && ok(r.contactDate)) {
            items.push({ lane: 'read', date: r.contactDate, tick: true, label: '', tip: `${r.contactDate} ${name(r.personId)} 接触到，没读（${CHANNELS[r.channel] || ''}）` });
        }
    }
    for (const [pid, x] of Object.entries(st.recommends?.[w.id] || {})) {
        if (!ok(x.date)) continue;
        items.push({ lane: 'talk', date: x.date, pol: x.polarity ?? 0, size: 5.5, label: `${x.byName || name(x.by)}→${name(pid)}`, tip: `${x.date} ${x.byName || name(x.by)} 向 ${name(pid)} 谈起（${x.polarity === 1 ? '说好' : x.polarity === -1 ? '说不好' : '只是提起'}）` });
    }
    for (const d of st.offscreen || []) for (const it of d.items || []) {
        if (!ok(it.date) || !it.work || normT(it.work) !== normT(w.title)) continue;
        items.push({ lane: 'off', date: it.date, size: 5.5, diamond: true, label: (it.who || []).join('、'), tip: `${it.date} 幕后：${truncate(it.text, 110)}${it.knows === 'no' ? '\n（主角不知道）' : ''}` });
    }
    items.sort((a, b) => cmp(a.date, b.date));
    return { work: w, items, start };
}

const LANES = [['press', '见报评论'], ['letter', '私信'], ['agg', '来信·转载'], ['read', '读到'], ['talk', '熟人谈起'], ['off', '幕后']];

export function timelineSvg(st, tl) {
    const { work: w, items } = tl;
    const start = tl.start || w.pubDate || items[0]?.date;
    if (!start) return '<div class="pe-empty-sm">这部作品还没有发表日期。</div>';
    let end = st.currentDate && cmp(st.currentDate, start) > 0 ? st.currentDate : addDays(start, 30);
    const span = Math.max(14, diffDays(end, start));
    const W = 900, L = 92, R = 18, top = 96, laneH = 40;
    const lanes = LANES.filter(([k]) => k === 'read' || items.some(i => i.lane === k));
    const H = top + lanes.length * laneH + 34;
    const x = d => L + (diffDays(d, start) / span) * (W - L - R);
    // 刻度：按跨度选周/月
    const ticks = [];
    const step = span <= 45 ? 7 : span <= 120 ? 14 : span <= 400 ? 30 : 90;
    for (let d = start; cmp(d, end) <= 0; d = addDays(d, step)) ticks.push(d);
    // 累计读者（读完或读了一部分）
    const reads = items.filter(i => i.lane === 'read' && !i.tick).map(i => i.date).sort(cmp);
    const maxN = Math.max(1, reads.length);
    let path = `M${L},${top - 14}`; let n = 0;
    for (const d of reads) { n++; const xx = x(d).toFixed(1); path += ` H${xx} V${(top - 14 - (n / maxN) * 60).toFixed(1)}`; }
    path += ` H${W - R}`;
    const laneY = k => top + lanes.findIndex(([kk]) => kk === k) * laneH + laneH / 2;
    // 同一天、同一泳道的点稍微错开
    const seen = {};
    const marks = items.map(it => {
        const kk = it.lane + it.date; const j = seen[kk] = (seen[kk] || 0) + 1;
        const cx = x(it.date) + (j - 1) * 5, cy = laneY(it.lane) + ((j % 2) ? 0 : -6);
        const tip = h(it.tip);
        if (it.tick) return `<line class="pe-tl-tick" x1="${cx}" x2="${cx}" y1="${cy - 5}" y2="${cy + 5}" data-tip="${tip}"/>`;
        const fill = it.pol == null ? 'var(--pe-accent)' : POL_COLOR[it.pol];
        if (it.diamond) return `<rect class="pe-tl-m" x="${cx - 5}" y="${cy - 5}" width="10" height="10" transform="rotate(45 ${cx} ${cy})" fill="#8fa8d8" data-tip="${tip}"/>`;
        return `<circle class="pe-tl-m" cx="${cx}" cy="${cy}" r="${it.size}" fill="${it.hollow ? 'var(--pe-bg)' : fill}" stroke="${fill}" stroke-width="${it.hollow ? 2 : 1.5}" data-tip="${tip}"/>`;
    }).join('');
    return `<svg class="pe-tl" viewBox="0 0 ${W} ${H}" role="img" aria-label="《${h(w.title)}》反响时间线">
      <text x="${L - 8}" y="${top - 70}" class="pe-tl-axis" text-anchor="end">累计读者</text>
      <text x="${L - 8}" y="${top - 12}" class="pe-tl-axis" text-anchor="end">0</text>
      <text x="${L - 8}" y="${top - 70}" dy="12" class="pe-tl-axis" text-anchor="end">${maxN}</text>
      <path d="${path}" class="pe-tl-cum"/>
      ${lanes.map(([k, lab], i) => `<g><rect x="${L}" y="${top + i * laneH}" width="${W - L - R}" height="${laneH}" class="pe-tl-lane ${i % 2 ? 'odd' : ''}"/><text x="${L - 8}" y="${top + i * laneH + laneH / 2 + 4}" class="pe-tl-lab" text-anchor="end">${lab}</text></g>`).join('')}
      ${ticks.map(d => `<g><line x1="${x(d)}" x2="${x(d)}" y1="${top}" y2="${H - 30}" class="pe-tl-grid"/><text x="${x(d)}" y="${H - 14}" class="pe-tl-axis" text-anchor="middle">${d.slice(5)}</text></g>`).join('')}
      <line x1="${x(start)}" x2="${x(start)}" y1="${top - 80}" y2="${H - 30}" class="pe-tl-pub"/><text x="${x(start) + 4}" y="${top - 74}" class="pe-tl-axis">发表 ${start}</text>
      ${marks}
    </svg>`;
}

// ———————————— 人物关系网 ————————————

/**
 * 节点和边。edge.kind：rel 熟人关系（cat=private/literary/social）/ close 与主角私交 / talk 谈起作品 / leak 可能泄露身份或私事。
 * opts.asOf：只画那天有效的关系与已发生的传递；opts.implicit：画出同刊同事（推演自动算的，没手填）。
 */
export function networkData(st, opts = {}) {
    const asOf = opts.asOf || st.currentDate || null;
    const persons = (st.persons || []).filter(p => p.active !== false);
    const nodes = [{ id: '__me', name: '主角', me: true }, ...persons.map(p => ({ id: p.id, name: p.name, close: p.closeness || 0, reads: (st.receptions || []).filter(r => r.personId === p.id && READ_DONE.includes(r.read) && (!r.readDate || !asOf || cmp(r.readDate, asOf) <= 0)).length, p }))];
    const has = new Set(nodes.map(n => n.id));
    const nm = id => byId(st.persons, id)?.name || '?';
    const edges = [];
    const pair = new Map();
    for (const p of persons) for (const r of p.relations || []) {
        if (!has.has(r.to) || r.to === p.id || !relOn(r, asOf)) continue;
        const k = [p.id, r.to].sort().join('|');
        const line = `${nm(p.id)} → ${nm(r.to)}：${REL_TYPES[r.type] || r.type}，${CLOSE[r.closeness ?? 1]}${r.since ? '，自 ' + r.since : ''}${r.until ? ' 至 ' + r.until : ''}${r.basis ? '（' + (REL_BASIS[r.basis] || r.basis) + '）' : ''}${r.evidence ? '\n依据：' + r.evidence : ''}`;
        if (pair.has(k)) { const e = pair.get(k); e.both = true; e.tip += '\n' + line; e.w = Math.max(e.w, 1 + (r.closeness ?? 1)); if (r.basis !== 'guess') e.guess = false; continue; }
        const e = { kind: 'rel', a: p.id, b: r.to, w: 1 + (r.closeness ?? 1), type: r.type, cat: relCat(r.type), guess: r.basis === 'guess', both: isMutual(r), tip: line };
        pair.set(k, e); edges.push(e);
    }
    if (opts.implicit) for (const p of persons) for (const r of relationsOf(st, p)) {
        if (!r.implicit || !has.has(r.to)) continue;
        const k = [p.id, r.to].sort().join('|');
        if (pair.has(k)) continue;
        const e = { kind: 'rel', a: p.id, b: r.to, w: 1, type: 'colleague', cat: 'literary', implicit: true, both: true, tip: `${nm(p.id)} — ${nm(r.to)}：同一刊物的同事（没手填，推演按“每周见、一般熟”自动算）` };
        pair.set(k, e); edges.push(e);
    }
    for (const p of persons) if ((p.closeness || 0) >= 1) edges.push({ kind: 'close', a: '__me', b: p.id, w: p.closeness, tip: `与主角：${CLOSE[p.closeness]}` });
    for (const [wid, box] of Object.entries(st.recommends || {})) for (const [pid, x] of Object.entries(box || {})) {
        if (!has.has(pid) || !has.has(x.by) || (asOf && x.date && cmp(x.date, asOf) > 0)) continue;
        edges.push({ kind: 'talk', a: x.by, b: pid, dir: true, w: 1, tip: `${x.date} ${x.byName || ''} 向 ${nm(pid)} 谈起《${byId(st.works, wid)?.title || ''}》` });
    }
    const ST = { pending: '未确认', confirmed: '确有其事', denied: '没有' };
    for (const l of st.identityLeaks || []) {
        if (!has.has(l.from) || !has.has(l.to) || l.status === 'denied' || (asOf && l.date && cmp(l.date, asOf) > 0)) continue;
        edges.push({ kind: 'leak', a: l.from, b: l.to, dir: true, w: 1.5, pending: l.status === 'pending', tip: `${l.date} ${nm(l.from)} 可能向 ${nm(l.to)} 透露了“${byId(st.pennames, l.pennameId)?.name || ''}”的身份（${ST[l.status] || l.status}）` });
    }
    for (const l of st.factLeaks || []) {
        if (!has.has(l.from) || !has.has(l.to) || l.status === 'denied' || (asOf && l.date && cmp(l.date, asOf) > 0)) continue;
        const f = (st.privateFacts || []).find(x => x.id === l.factId);
        edges.push({ kind: 'leak', a: l.from, b: l.to, dir: true, w: 1.5, pending: l.status === 'pending', tip: `${l.date} ${nm(l.from)} 可能向 ${nm(l.to)} 说起主角的私事“${(f?.text || '').slice(0, 24)}”（${ST[l.status] || l.status}）` });
    }
    return { nodes, edges, asOf };
}

/** 按显示开关筛边；隐藏孤立人物时，去掉没有任何可见连线的人 */
export function visibleNetwork(data, show = {}, hideIsolated = false) {
    const edges = data.edges.filter(e => show[e.kind] !== false && (e.kind !== 'rel' || show['cat_' + e.cat] !== false));
    if (!hideIsolated) return { ...data, edges };
    const used = new Set(['__me']); for (const e of edges) { used.add(e.a); used.add(e.b); }
    return { ...data, edges, nodes: data.nodes.filter(n => used.has(n.id)) };
}

/** 简单的力导向布局（确定性：同一份数据每次结果一样）。pos 里已有的位置会保留 */
export function layoutNetwork(data, pos = {}, W = 900, H = 620) {
    const N = data.nodes;
    const P = {};
    N.forEach((n, i) => {
        if (pos[n.id]) { P[n.id] = { ...pos[n.id] }; return; }
        if (n.me) { P[n.id] = { x: W / 2, y: H / 2 }; return; }
        const a = (i / N.length) * Math.PI * 2, r = 120 + (3 - (n.close || 0)) * 60;
        P[n.id] = { x: W / 2 + Math.cos(a) * r, y: H / 2 + Math.sin(a) * r };
    });
    const fresh = N.filter(n => !pos[n.id]).length;
    if (!fresh) return P;
    const links = data.edges.filter(e => e.kind !== 'talk' && e.kind !== 'leak');
    for (let it = 0; it < 260; it++) {
        const F = {}; for (const n of N) F[n.id] = { x: 0, y: 0 };
        for (let i = 0; i < N.length; i++) for (let j = i + 1; j < N.length; j++) {
            const a = P[N[i].id], b = P[N[j].id];
            let dx = a.x - b.x, dy = a.y - b.y; const d2 = Math.max(80, dx * dx + dy * dy); const f = 5200 / d2; const d = Math.sqrt(d2);
            dx /= d; dy /= d; F[N[i].id].x += dx * f; F[N[i].id].y += dy * f; F[N[j].id].x -= dx * f; F[N[j].id].y -= dy * f;
        }
        for (const e of links) {
            const a = P[e.a], b = P[e.b]; if (!a || !b) continue;
            const dx = b.x - a.x, dy = b.y - a.y; const d = Math.sqrt(dx * dx + dy * dy) || 1;
            const want = e.kind === 'close' ? 200 - e.w * 35 : 110; const f = (d - want) * 0.02;
            F[e.a].x += dx / d * f; F[e.a].y += dy / d * f; F[e.b].x -= dx / d * f; F[e.b].y -= dy / d * f;
        }
        for (const n of N) {
            if (n.me || pos[n.id]) continue;
            const p = P[n.id]; const cool = 1 - it / 300;
            p.x += Math.max(-12, Math.min(12, F[n.id].x + (W / 2 - p.x) * 0.004)) * cool;
            p.y += Math.max(-12, Math.min(12, F[n.id].y + (H / 2 - p.y) * 0.004)) * cool;
            p.x = Math.max(40, Math.min(W - 40, p.x)); p.y = Math.max(30, Math.min(H - 30, p.y));
        }
    }
    return P;
}

export function networkSvg(st, data, P, show, W = 900, H = 620) {
    const pens = (st.pennames || []).filter(pen => (st.works || []).some(w => w.pennameId === pen.id));
    const ed = data.edges.filter(e => show[e.kind] !== false && (e.kind !== 'rel' || show['cat_' + e.cat] !== false) && P[e.a] && P[e.b]);
    const line = e => {
        const a = P[e.a], b = P[e.b];
        const cls = `pe-nw-e pe-nw-${e.kind}${e.kind === 'rel' ? ' c-' + e.cat : ''}${e.type === 'family' ? ' fam' : ''}${e.guess ? ' guess' : ''}${e.implicit ? ' implicit' : ''}${e.pending ? ' pending' : ''}`;
        const sw = e.kind === 'close' ? 1 + e.w * 0.8 : e.kind === 'rel' ? 0.8 + e.w * 0.5 : 1.6;
        const stroke = e.kind === 'close' ? CLOSE_COLOR[e.w] : '';
        const one = e.kind === 'rel' && !e.both; // 只有一方写了的关系：箭头指向被写的人
        const xy = `x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}"`;
        const sel = e.kind === 'rel' || e.kind === 'talk' || e.kind === 'leak' ? ` data-edge="${e.a}|${e.b}"` : '';
        return `<line class="${cls}" ${xy} stroke-width="${sw}" ${stroke ? `stroke="${stroke}"` : ''} ${e.dir || one ? 'marker-end="url(#pe-nw-arrow)"' : ''} data-a="${e.a}" data-b="${e.b}"/>`
            + `<line class="pe-nw-hit" ${xy} data-a="${e.a}" data-b="${e.b}"${sel} data-tip="${h(e.tip)}"/>`;
    };
    const node = n => {
        const p = P[n.id];
        if (n.me) return `<g class="pe-nw-n me" data-id="__me" transform="translate(${p.x.toFixed(1)},${p.y.toFixed(1)})"><circle r="16"/><text dy="34" text-anchor="middle">主角</text></g>`;
        const r = 7 + Math.min(9, Math.sqrt(n.reads) * 3);
        const knows = pens.filter(pen => knowsPen(st, n.p, pen.id)).map(pen => pen.name);
        const tip = `${n.name}${(n.p.roles || []).length ? '（' + n.p.roles.map(x => ROLES[x] || x).join('/') + '）' : ''}\n与主角：${CLOSE[n.close]}\n读过主角的作品：${n.reads} 部${knows.length ? '\n知道 ' + knows.join('、') + ' 是主角' : ''}`;
        return `<g class="pe-nw-n" data-id="${n.id}" transform="translate(${p.x.toFixed(1)},${p.y.toFixed(1)})" data-tip="${h(tip)}"><circle r="${r.toFixed(1)}" fill="${CLOSE_COLOR[n.close]}"/>${knows.length ? `<circle r="${(r + 3.5).toFixed(1)}" class="pe-nw-knows"/>` : ''}<text dy="${(r + 13).toFixed(0)}" text-anchor="middle">${h(n.name)}</text></g>`;
    };
    return `<svg class="pe-nw" id="pe-nw" viewBox="0 0 ${W} ${H}" role="img" aria-label="人物关系网">
      <defs><marker id="pe-nw-arrow" viewBox="0 0 10 10" refX="22" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="context-stroke"/></marker></defs>
      <g class="pe-nw-edges">${ed.map(line).join('')}</g>
      <g class="pe-nw-nodes">${data.nodes.filter(n => P[n.id]).map(node).join('')}</g>
    </svg>`;
}

// ———————————— 报纸版面预览 ————————————

const FR_WD = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
const FR_MO = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const ZH_WD = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
const wdOf = d => new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10))).getUTCDay();
export const frDate = d => `${FR_WD[wdOf(d)]} ${+d.slice(8, 10) === 1 ? '1er' : +d.slice(8, 10)} ${FR_MO[+d.slice(5, 7) - 1]} ${d.slice(0, 4)}`;
const zhDate = d => `${+d.slice(0, 4)}年${+d.slice(5, 7)}月${+d.slice(8, 10)}日 ${ZH_WD[wdOf(d)]}`;
/** 刊物原名：有 originalName 用它；否则从备注里找第一段西文 */
export function outletOriginal(o) {
    if (o?.originalName) return o.originalName;
    const m = String(o?.note || '').match(/^[^；;]*?([A-ZÀ-Ý][\p{L}'’\- .]+[\p{L}])/u);
    return m ? m[1].trim() : '';
}
const PAPER_SECTION = { review: '文艺批评', polemic: '论战', notice: '新书简讯', echo: '巴黎回声', reader_letters: '读者来信', mentions: '各报摘录', private_letter: '' };
const ORDER = ['review', 'polemic', 'notice', 'echo', 'reader_letters', 'mentions'];

/** 某刊物在某天（或这一周）有哪些已入账、主角已知的公开文章 */
export function paperItems(st, outletId, date, span = 'day') {
    const from = span === 'week' ? addDays(date, -((wdOf(date) + 6) % 7)) : date;
    const to = span === 'week' ? addDays(from, 6) : date;
    return (st.ledger || []).filter(e => e.status === 'approved' && e.outletId === outletId && e.layer !== 'private_letter'
        && cmp(e.date, from) >= 0 && cmp(e.date, to) <= 0 && (!st.currentDate || cmp(e.date, st.currentDate) <= 0))
        .sort((a, b) => ORDER.indexOf(a.layer) - ORDER.indexOf(b.layer) || cmp(a.date, b.date));
}
/** 这家刊物有哪些日子可以看版面 */
export function paperDates(st, outletId) {
    return [...new Set((st.ledger || []).filter(e => e.status === 'approved' && e.outletId === outletId && e.layer !== 'private_letter' && (!st.currentDate || cmp(e.date, st.currentDate) <= 0)).map(e => e.date))].sort(cmp).reverse();
}

const PAPER_SECTION_FR = { review: 'Critique littéraire', polemic: 'Polémique', notice: 'Livres nouveaux', echo: 'Échos', reader_letters: 'Courrier des lecteurs', mentions: 'Revue de la presse' };
const PERIODICITY_FR = { daily: 'Quotidien', weekly: 'Hebdomadaire', biweekly: 'Bimensuel', monthly: 'Mensuel', irregular: 'Paraît irrégulièrement' };
const latin = t => /[A-Za-zÀ-ÿ]/.test(t || '') && !/[一-鿿]/.test(t || '');
/** 作品的法文名：别名里第一个西文名 */
export const workFr = w => (w?.aliases || []).find(latin) || w?.titleFr || '';
const paras = (t, cls = '') => String(t || '').split(/\n+/).filter(x => x.trim()).map(p => `<p${cls ? ` class="${cls}"` : ''}>${h(p.trim())}</p>`).join('');

/** 这一版有哪些文章还没有法文稿（用来决定要不要调用 AI） */
export function paperMissingFr(st, outletId, date, span = 'day') {
    return paperItems(st, outletId, date, span).filter(e => (e.text?.body || e.text?.summary || e.text?.title) && !e.text?.fr);
}

/**
 * lang：fr 法语（主）· zh 中文 · both 法语正文、每篇后附中文译文
 * 法文稿存在 e.text.fr = { title, section, byline, body }，由 AI 依据中文稿还原；改写中文稿后自动作废。
 */
export function paperHtml(st, outletId, date, span = 'day', lang = 'fr') {
    const o = byId(st.outlets, outletId);
    const items = paperItems(st, outletId, date, span);
    const orig = outletOriginal(o);
    const FR = lang !== 'zh';
    const art = e => {
        const w = byId(st.works, e.workId);
        const who = byId(st.persons, e.personId)?.name || e.personName || '';
        const t = e.text || {};
        const f = t.fr || null;
        const agg = e.layer === 'reader_letters' || e.layer === 'mentions';
        const wFr = workFr(w);
        // —— 中文 ——
        const zhSec = t.section || PAPER_SECTION[e.layer] || LAYERS[e.layer]?.label || '';
        const zhTitle = t.title || (['review', 'polemic'].includes(e.layer) ? (w ? `评《${w.title}》` : '') : '');
        let zhBody;
        if (t.body && !t.stanceOnly) zhBody = paras(t.body);
        else if (t.body && t.stanceOnly) zhBody = `<p class="pp-note">（推演摘要，非原文）${h(t.body)}</p>`;
        else if (agg) zhBody = `<p>${e.layer === 'reader_letters' ? `本报近日收到读者来信约 ${h(e.count || '若干')} 封，谈${w ? '《' + h(w.title) + '》' : '本报所载文字'}。` : `各报转载、提及${w ? '《' + h(w.title) + '》' : ''}约 ${h(e.count || '若干')} 处。`}${t.summary ? h(t.summary) : ''}</p>`;
        else zhBody = `<p class="pp-note">（概要，正文未写）${h(t.summary || '')}</p>`;
        // —— 法语 ——
        let frSec = f?.section || PAPER_SECTION_FR[e.layer] || '';
        let frTitle = f?.title || (['review', 'polemic'].includes(e.layer) && wFr ? `« ${wFr} »` : '');
        let frBody;
        if (f?.body) frBody = t.stanceOnly ? `<p class="pp-note">(Résumé de la position — texte non rédigé) ${h(f.body)}</p>` : paras(f.body);
        else if (agg && !t.summary) frBody = `<p>${e.layer === 'reader_letters' ? `La rédaction a reçu environ ${h(e.count || 'quelques')} lettres de lecteurs au sujet ${wFr ? `de « ${h(wFr)} »` : 'des textes parus dans nos colonnes'}.` : `Environ ${h(e.count || 'quelques')} reprises et mentions ${wFr ? `de « ${h(wFr)} »` : ''} dans la presse.`}</p>`;
        else frBody = null; // 还没有法文稿
        const byline = (FR ? f?.byline : '') || t.byline || who;
        const head = (sec, title) => `${sec ? `<div class="pp-sec">${h(sec)}</div>` : ''}${title ? `<h3>${h(title)}</h3>` : ''}${span === 'week' ? `<div class="pp-date">${h(FR ? frDate(e.date) : zhDate(e.date))}</div>` : ''}`;
        if (!FR) return `<article class="pp-art pp-${e.layer}">${head(zhSec, zhTitle)}<div class="pp-body">${zhBody}</div>${byline ? `<div class="pp-by">${h(byline)}</div>` : ''}</article>`;
        if (!frBody) {
            // 没有法文稿：先排中文，并注明
            return `<article class="pp-art pp-${e.layer} pp-nofr">${head(frSec || zhSec, frTitle || zhTitle)}<p class="pp-note">(Texte français non encore établi — 法语稿未生成)</p><div class="pp-body pp-zh">${zhBody}</div>${byline ? `<div class="pp-by">${h(byline)}</div>` : ''}</article>`;
        }
        return `<article class="pp-art pp-${e.layer}" lang="fr">${head(frSec, frTitle)}<div class="pp-body">${frBody}</div>${byline ? `<div class="pp-by">${h(byline)}</div>` : ''}
          ${lang === 'both' ? `<div class="pp-trans" lang="zh"><div class="pp-trans-h">译文${zhTitle ? '　' + h(zhTitle) : ''}</div>${zhBody}</div>` : ''}</article>`;
    };
    const d0 = span === 'week' ? paperWeek(date) : [date, date];
    return `<div class="pe-paper ${FR ? 'pp-fr' : 'pp-zhmode'}">
      <header class="pp-head">
        <div class="pp-ear"><span>${h(FR ? PERIODICITY_FR[o?.periodicity] || '' : PERIODICITY_ZH[o?.periodicity] || '')}</span><span>${FR ? '' : h(o?.politics?.join(' · ') || '')}</span></div>
        <div class="pp-title">${h(orig || o?.name || '')}</div>
        ${orig ? `<div class="pp-sub">${h(o?.name || '')}</div>` : ''}
        <div class="pp-dateline">${FR
            ? `<span>${h(span === 'week' ? `Semaine du ${frDate(d0[0])}` : frDate(date))}</span><span>Paris</span><span>${h(span === 'week' ? `${zhDate(d0[0])} 起一周` : zhDate(date))}</span>`
            : `<span>${h(span === 'week' ? `${zhDate(d0[0])} 起一周` : zhDate(date))}</span><span>巴黎</span><span>${h(span === 'week' ? `Semaine du ${frDate(d0[0])}` : frDate(date))}</span>`}</div>
      </header>
      <div class="pp-cols">${items.length ? items.map(art).join('') : `<p class="pp-note">${FR ? 'Rien, ce jour-là, sur les œuvres de l’auteur.' : '这一天本报没有与主角作品相关的文章。'}</p>`}</div>
      <footer class="pp-foot">报刊回声 · 依据推演结果排出的虚构版面${FR ? ' · Mise en page fictive d’après la simulation' : ''}</footer>
    </div>`;
}
const PERIODICITY_ZH = { daily: '日报', weekly: '周刊', biweekly: '半月刊', monthly: '月刊', irregular: '不定期' };
export const paperWeek = date => { const a = addDays(date, -((wdOf(date) + 6) % 7)); return [a, addDays(a, 6)]; };

export const PAPER_CSS = `
.pe-paper { background: #f1e9d6; color: #1f1b14; font-family: "Noto Serif SC", "Source Han Serif SC", "Songti SC", "STSong", Georgia, serif; padding: 22px 26px 16px; border-radius: 3px; box-shadow: inset 0 0 60px rgba(120, 90, 40, .18); max-width: 1000px; margin: 0 auto; line-height: 1.7; }
.pe-paper .pp-head { text-align: center; border-bottom: 3px double #2a241a; padding-bottom: 6px; margin-bottom: 12px; }
.pe-paper .pp-ear { display: flex; justify-content: space-between; font-size: 12px; color: #5a4d35; border-bottom: 1px solid #2a241a; padding-bottom: 3px; }
.pe-paper .pp-title { font-family: "Playfair Display", "Didot", "Bodoni 72", Georgia, "Times New Roman", serif; font-size: 46px; font-weight: 700; letter-spacing: .02em; line-height: 1.15; margin: 8px 0 0; }
.pe-paper .pp-sub { font-size: 14px; letter-spacing: .3em; color: #4a3f2b; }
.pe-paper .pp-dateline { display: flex; justify-content: space-between; font-size: 12.5px; border-top: 1px solid #2a241a; margin-top: 6px; padding-top: 3px; font-style: italic; }
.pe-paper .pp-cols { column-count: 3; column-gap: 22px; column-rule: 1px solid #b9a982; }
.pe-paper .pp-art { break-inside: avoid-column; margin: 0 0 14px; }
.pe-paper .pp-art.pp-review, .pe-paper .pp-art.pp-polemic { break-inside: auto; }
.pe-paper .pp-sec { font-size: 11.5px; letter-spacing: .25em; text-align: center; border-top: 1px solid #2a241a; border-bottom: 1px solid #2a241a; padding: 1px 0; margin-bottom: 4px; }
.pe-paper h3 { font-size: 18px; text-align: center; margin: 4px 0 6px; line-height: 1.35; font-weight: 700; }
.pe-paper .pp-date { text-align: center; font-size: 11.5px; font-style: italic; color: #5a4d35; margin-top: -4px; }
.pe-paper .pp-body p { margin: 0; text-indent: 2em; text-align: justify; font-size: 14px; }
.pe-paper .pp-review .pp-body p:first-child { text-indent: 0; }
.pe-paper .pp-review .pp-body p:first-child::first-letter { font-size: 2.7em; float: left; line-height: .95; margin: 4px 6px 0 0; font-weight: 700; }
.pe-paper .pp-by { text-align: right; font-style: italic; font-size: 13px; margin-top: 4px; }
.pe-paper .pp-note { color: #6b5d42; font-style: italic; text-indent: 0 !important; font-size: 13px; }
.pe-paper.pp-fr .pp-body p, .pe-paper.pp-fr h3, .pe-paper.pp-fr .pp-by { font-family: "Libre Caslon Text", "Baskerville", "Garamond", "EB Garamond", Georgia, "Times New Roman", serif; hyphens: auto; }
.pe-paper.pp-fr .pp-body p { font-size: 14.5px; line-height: 1.55; }
.pe-paper .pp-trans { margin-top: 6px; padding: 5px 8px; border-left: 2px solid #b9a982; background: rgba(120, 90, 40, .06); }
.pe-paper .pp-trans p { font-size: 12.5px !important; line-height: 1.6; color: #4a3f2b; }
.pe-paper .pp-trans-h { font-size: 11px; letter-spacing: .2em; color: #7a6b4c; margin-bottom: 2px; }
.pe-paper .pp-zh p { color: #4a3f2b; }
.pe-paper .pp-foot { margin-top: 10px; border-top: 1px solid #2a241a; text-align: center; font-size: 10.5px; color: #7a6b4c; padding-top: 3px; }
@media (max-width: 760px) { .pe-paper .pp-cols { column-count: 1; } .pe-paper .pp-title { font-size: 32px; } }
`;
