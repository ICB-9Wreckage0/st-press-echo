// ui.js — 面板界面（纯 DOM，不依赖框架）

import { escapeHtml as h, parseTags, tagsToText, truncate, uid, extractJSON } from './util.js';
import { weekdayZh, normalizeISO, yearOf, cmp, addDays, diffDays, pickStoryDate } from './date.js';
import {
    FORMS, PERIODICITY, CIRCLES, LAYERS, ROLES, repLabel, setStatus, rerollWork, advanceTo, byId, columnSlots,
    READ_STATES, STRENGTH, EXPRESSION, CHANNELS, OPINION_STATUS, REL_TYPES, REL_FREQ, relationsOf, opinionStatus, isMajor, recordManualReading, backfill, backfillBegin, backfillStep, backfillEnd, simulate, impressionAt, IMPRESSION_LABEL, seriesKey,
} from './engine.js';
import { buildEvidenceCard, cardText, generateOpinion, OPINION_DIMS } from './analysis.js';
import {
    epistolaryAvailable, epistolaryStoryDate, scanLetters, peopleProposals, loadBackup, clearBackup, backupInfo, archiveSource,
    effectiveScope, listArticles, articleBody, letterText,
} from './epistolary.js';
import { getSettings, saveSettings, getState, saveState, resetState, replaceState, logLine, looksLikeBundleData } from './store.js';
import { blankOutlet, blankPerson, blankWork, blankPenname, applyProposal, addManualEvent } from './data.js';
import { writeEvent, buildWriterPrompt } from './writer.js';
import {
    guessPlace, eraKey, defaultWikiTitles, gatherSources, buildEraProfile, profileToProposals, wikiSearch, wikiExtract, trimFuture,
} from './era.js';
import { extractFromText, loadWorldbookText } from './extract.js';
import { callLLM } from './llm.js';
import { Fab } from './fab.js';
import { buildConcepts, unclassified, allTags, conceptGroups } from './concepts.js';
import { planImport, readTextFile, parseFileName } from './txtimport.js';
import {
    FORMAT_SPEC, FORMAT_RULES, buildExternalPrompt, normalizeBundle, mergeBundles, previewBundle, applyBundle, organize,
    chatToText, parseJsonl, looksLikeBundle, chunk as chunkMaterial,
} from './bundle.js';

let app = null; // { refreshInjection, detectFromChat }
let tab = 'overview';
let editing = null; // { kind, id }
let busy = '';
let searchResults = [];
let ledgerFilter = '';
let lastReport = null;
let fab = null;
let txtPlan = []; // txt 批量导入的预览（正文只放在内存里，导入时才写进作品）
let txtOverwrite = false;
let materials = []; // 一键整理的材料（只在内存里）：{ id, label, kind, text }
let orgAbort = null;
let simView = null; // 预演视图：{ kind: 'work'|'person', ... }

const toast = (type, msg) => (globalThis.toastr?.[type] ? globalThis.toastr[type](msg, '报刊回声') : console.log('[报刊回声]', msg));

export function getEra() {
    const st = getState();
    const s = getSettings();
    if (!st) return null;
    return st.eraProfile || (st.era?.key ? s.eraCache?.[st.era.key] : null) || null;
}

// ———————————— 表单生成 ————————————

function fieldHtml(f, val, state) {
    const id = `pe-f-${f.key}`;
    const label = `<label for="${id}">${h(f.label)}</label>`;
    switch (f.type) {
    case 'color':
        return `<div class="pe-field">${label}<input id="${id}" type="color" data-k="${f.key}" value="${h(val || '#e0a458')}">${f.hint ? `<small>${h(f.hint)}</small>` : ''}</div>`;
    case 'checkbox':
        return `<div class="pe-field pe-check"><label><input type="checkbox" data-k="${f.key}" ${val ? 'checked' : ''}> ${h(f.label)}</label>${f.hint ? `<small>${h(f.hint)}</small>` : ''}</div>`;
    case 'select': {
        const opts = typeof f.options === 'function' ? f.options(state) : f.options;
        return `<div class="pe-field">${label}<select id="${id}" data-k="${f.key}">${Object.entries(opts).map(([k, v]) => `<option value="${h(k)}" ${String(val) === String(k) ? 'selected' : ''}>${h(v)}</option>`).join('')}</select>${f.hint ? `<small>${h(f.hint)}</small>` : ''}</div>`;
    }
    case 'multi': {
        const opts = typeof f.options === 'function' ? f.options(state) : f.options;
        const arr = Array.isArray(val) ? val.map(String) : [];
        const items = Object.entries(opts);
        return `<div class="pe-field">${label}<div class="pe-multi" data-k="${f.key}" data-multi="1">${items.length ? items.map(([k, v]) => `<label><input type="checkbox" value="${h(k)}" ${arr.includes(String(k)) ? 'checked' : ''}> ${h(v)}</label>`).join('') : '<small>（暂无可选项）</small>'}</div>${f.hint ? `<small>${h(f.hint)}</small>` : ''}</div>`;
    }
    case 'tags':
        return `<div class="pe-field">${label}<input id="${id}" type="text" data-k="${f.key}" data-tags="1" value="${h(tagsToText(val))}" placeholder="用逗号或顿号分隔">${f.hint ? `<small>${h(f.hint)}</small>` : ''}</div>`;
    case 'textarea':
        return `<div class="pe-field pe-wide">${label}<textarea id="${id}" data-k="${f.key}" rows="${f.rows || 3}">${h(val ?? '')}</textarea>${f.hint ? `<small>${h(f.hint)}</small>` : ''}</div>`;
    case 'number':
        return `<div class="pe-field">${label}<input id="${id}" type="number" step="${f.step ?? 1}" data-k="${f.key}" data-num="1" value="${h(val ?? '')}">${f.hint ? `<small>${h(f.hint)}</small>` : ''}</div>`;
    case 'password':
        return `<div class="pe-field">${label}<input id="${id}" type="password" data-k="${f.key}" value="${h(val ?? '')}" autocomplete="off"></div>`;
    default:
        return `<div class="pe-field">${label}<input id="${id}" type="text" data-k="${f.key}" value="${h(val ?? '')}" placeholder="${h(f.placeholder || '')}">${f.hint ? `<small>${h(f.hint)}</small>` : ''}</div>`;
    }
}

function formHtml(spec, obj, state) {
    return `<div class="pe-form">${spec.map(f => fieldHtml(f, obj?.[f.key], state)).join('')}</div>`;
}

function readForm(root, spec) {
    const out = {};
    for (const f of spec) {
        if (f.type === 'multi') {
            const box = root.querySelector(`[data-k="${f.key}"][data-multi]`);
            out[f.key] = box ? [...box.querySelectorAll('input:checked')].map(i => i.value) : [];
            if (f.numeric) out[f.key] = out[f.key].map(Number);
            continue;
        }
        const el = root.querySelector(`[data-k="${f.key}"]`);
        if (!el) continue;
        if (f.type === 'checkbox') out[f.key] = el.checked;
        else if (f.type === 'tags') out[f.key] = f.numeric ? parseTags(el.value).map(Number).filter(n => !isNaN(n)) : parseTags(el.value);
        else if (f.type === 'number') out[f.key] = el.value === '' ? null : Number(el.value);
        else if (f.type === 'date') out[f.key] = normalizeISO(el.value) || '';
        else if (f.type === 'select' && f.numeric) out[f.key] = el.value === '' ? null : Number(el.value);
        else out[f.key] = el.value;
    }
    return out;
}

const WEEKDAYS = { '': '（不适用）', 0: '星期日', 1: '星期一', 2: '星期二', 3: '星期三', 4: '星期四', 5: '星期五', 6: '星期六' };
const CLOSE = { 0: '陌生', 1: '认识', 2: '朋友', 3: '至交' };
// 私交（好感度）配色：灰 陌生 → 蓝 认识 → 绿 朋友 → 粉 至交
const CLOSE_COLOR = { 0: '#8a8f98', 1: '#6fa8dc', 2: '#7fc48f', 3: '#e78fb3' };
// 笔名配色：没手动选色时按顺序取
const PEN_PALETTE = ['#e0a458', '#6fb3d2', '#c98bd6', '#7fc48f', '#e07a7a', '#d6c66b', '#8aa1e6', '#5fc4b8'];
function penColor(st, id) {
    const i = st.pennames.findIndex(p => p.id === id);
    if (i < 0) return '';
    return st.pennames[i].color || PEN_PALETTE[i % PEN_PALETTE.length];
}
function penChip(st, id) {
    const p = byId(st.pennames, id);
    return p ? `<span class="pe-chip pe-pen" style="--c:${penColor(st, id)}">${h(p.name)}</span>` : '';
}
/** 书名加书名号；书名里已经带书名号的（如“《生者与死亡》第一册”）原样显示 */
const bt = t => { const x = String(t ?? ''); return x.includes('《') ? h(x) : `《${h(x)}》`; };
const statusChip = r => { const k = opinionStatus(r); return k === 'unread' ? '' : `<span class="pe-chip pe-op-${k}" title="${k === 'unanalyzed' ? '读过，但还没让模型生成具体看法' : k === 'shallow' ? '推演结果：读了但印象不深' : k === 'private' ? '已生成具体看法，尚未对外表达' : '在谈话、书信或文章里表达过'}">${OPINION_STATUS[k]}</span>`; };
const dimsHtml = d => (d && Object.entries(OPINION_DIMS).some(([k]) => d[k] != null)) ? `<span class="pe-dims">${Object.entries(OPINION_DIMS).filter(([k]) => d[k] != null).map(([k, v]) => `<span class="pe-dim pe-dim${Math.sign(d[k])}" title="${v} ${d[k] > 0 ? '+' : ''}${d[k]}">${v}${'●'.repeat(Math.abs(d[k]) || 0) || '○'}</span>`).join('')}</span>` : '';
const closeOf = p => Math.max(0, Math.min(3, Number(p?.closeness) || 0));
/** 人名按私交着色；陌生人不加色点 */
function personTag(p, fallback = '') {
    if (!p) return h(fallback);
    const c = closeOf(p);
    return `<span class="pe-person pe-close${c}" style="--c:${CLOSE_COLOR[c]}" title="与主角：${CLOSE[c]}">${h(p.name)}</span>`;
}
const closeLegend = () => `<div class="pe-legend">${Object.entries(CLOSE).map(([k, v]) => `<span class="pe-person pe-close${k}" style="--c:${CLOSE_COLOR[k]}">${v}</span>`).join('')}</div>`;
const POLS = { 1: '肯定', 0: '褒贬参半', '-1': '批评' };
const optsOf = (list, label = 'name', blank = true) => state => {
    const o = blank ? { '': '（无）' } : {};
    for (const x of list(state) || []) o[x.id] = x[label] || x.title || '(未命名)';
    return o;
};

const PEN_SPEC = [
    { key: 'name', label: '笔名' },
    { key: 'owner', label: '真实作者' },
    { key: 'color', label: '标签颜色', type: 'color', hint: '作品列表、反响卡片里用这个颜色区分不同署名' },
    { key: 'publicIdentityKnown', label: '公众已知其身份', type: 'checkbox' },
    { key: 'knownBy', label: '知道身份的人', type: 'multi', options: optsOf(s => s.persons, 'name', false) },
];
const OUTLET_SPEC = [
    { key: 'name', label: '刊物名' },
    { key: 'periodicity', label: '出刊周期', type: 'select', options: PERIODICITY },
    { key: 'weekday', label: '周刊出刊日', type: 'select', options: WEEKDAYS, numeric: true, hint: '仅周刊用' },
    { key: 'monthDays', label: '月刊/半月刊出刊日', type: 'tags', numeric: true, hint: '如：1，15。留空则半月刊=1、15日，月刊=1日' },
    { key: 'politics', label: '政治/宗教倾向', type: 'tags' },
    { key: 'circle', label: '所属圈子', type: 'select', options: CIRCLES, hint: '决定批准后的反响计入哪一类声誉' },
    { key: 'tier', label: '影响力（1–5）', type: 'number', hint: '影响读者来信数量' },
    { key: 'capacity', label: '每期版面（篇）', type: 'number', hint: '每期（日报按每周）最多登几篇与主角作品相关的稿件。留空：日报2、其余1' },
    { key: 'deadlineDays', label: '截稿提前天数', type: 'number', hint: '留空：日报1、周刊3、半月刊5、月刊8' },
    { key: 'sections', label: '有哪些栏目', type: 'multi', options: { review: '正式书评', notice: '书讯/短评', echo: '短讯/八卦', polemic: '论战文章', reader_letters: '读者来信' }, hint: '不勾选则按出刊周期给默认值' },
    { key: 'real', label: '真实存在的刊物', type: 'checkbox' },
    { key: 'note', label: '备注', type: 'textarea', rows: 2 },
];
const PERSON_SPEC = [
    { key: 'name', label: '姓名' },
    { key: 'roles', label: '身份', type: 'multi', options: ROLES },
    { key: 'outletIds', label: '供稿刊物', type: 'multi', options: optsOf(s => s.outlets, 'name', false) },
    { key: 'reads', label: '常读的报刊', type: 'multi', options: optsOf(s => s.outlets, 'name', false), hint: '决定能否“接触到”作品。不勾选：默认读自己供稿的刊物和影响力 4 级以上的大报' },
    { key: 'busy', label: '忙碌期', hint: '如：1890-06-01~1890-06-30；多段用分号隔开。忙时读得少、读得慢' },
    { key: 'interests', label: '关注题材', type: 'tags' },
    { key: 'likes', label: '欣赏', type: 'tags', hint: '与作品题材或刊物倾向重叠越多，越偏好评' },
    { key: 'dislikes', label: '反感', type: 'tags', hint: '重叠越多越偏批评，也越可能写论战文章' },
    { key: 'closeness', label: '与主角私交', type: 'select', options: CLOSE, numeric: true, hint: '私交越深越倾向写私信，而不是公开书评' },
    { key: 'monthlyCapacity', label: '每月公开文章上限', type: 'number' },
    { key: 'columnWeekday', label: '个人专栏固定在', type: 'select', options: WEEKDAYS, numeric: true, hint: '例如日报上的周日文学专栏；书评/书讯只会落在这一天' },
    { key: 'knowsIdentity', label: '知道主角的笔名身份', type: 'checkbox' },
    { key: 'real', label: '真实历史人物', type: 'checkbox', hint: '真实人物默认只生成立场摘要，不替他写原话' },
    { key: 'active', label: '参与推演', type: 'checkbox' },
    { key: 'notes', label: '备注（书信簿里的关系、往来）', type: 'textarea', rows: 2 },
];
const WORK_SPEC = [
    { key: 'title', label: '作品名' },
    { key: 'aliases', label: '别名／外文名', type: 'tags', hint: '如 L’Aîné、Le Journal d’Ishida。扫描书信时也按这些找；两三个字的短书名只在带书名号时才算提到' },
    { key: 'pennameId', label: '署名', type: 'select', options: optsOf(s => s.pennames) },
    { key: 'form', label: '形式', type: 'select', options: FORMS, hint: '连载很少进正式书评；成书、小册子才进书评栏' },
    { key: 'outletId', label: '发表刊物', type: 'select', options: optsOf(s => s.outlets) },
    { key: 'pubDate', label: '发表日期', type: 'date', placeholder: 'YYYY-MM-DD' },
    { key: 'endDate', label: '连载结束日', type: 'date', placeholder: 'YYYY-MM-DD，可空' },
    { key: 'themes', label: '题材标签', type: 'tags' },
    { key: 'summary', label: '内容摘要', type: 'textarea', rows: 3 },
    { key: 'series', label: '系列', hint: '同系列的作品（如《生者与死亡》各册）读者最想接着找来读。留空则从书名推断，去掉“第一册”“（上）”之类' },
    { key: 'parentId', label: '同一作品的另一个版本', type: 'select', options: optsOf(s => s.works, 'title'), hint: '如单行本对应的连载版。读过另一版本的人不太会再读一遍' },
    { key: 'sourceText', label: '原文（用于生成证据卡，可粘贴全文）', type: 'textarea', rows: 6 },
];

// ———————————— 外壳 ————————————

const TABS = [
    ['overview', '概览'], ['queue', '待审核'], ['ledger', '账本'], ['reading', '阅读记录'],
    ['works', '作品'], ['people', '人物与刊物'], ['era', '年代'], ['import', '导入与整理'], ['settings', '⚙ 设置'],
];

export function mountUI(appApi) {
    app = appApi;
    if (document.getElementById('pe-panel')) return;
    const s0 = getSettings();
    fab = new Fab({
        onClick: () => togglePanel(),
        getPos: () => getSettings().fabPos,
        setPos: pos => { getSettings().fabPos = pos; saveSettings(); },
    });

    const panel = document.createElement('div');
    panel.id = 'pe-panel';
    panel.className = 'pe-hidden';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', '报刊回声');
    panel.innerHTML = `
      <div class="pe-header" title="按住标题栏拖动窗口；双击恢复默认位置">
        <span class="pe-title">¶ 报刊回声</span>
        <span class="pe-datechip" id="pe-head-date"></span>
        <span class="pe-busy" id="pe-busy"></span>
        <span class="pe-spacer"></span>
        <button class="pe-close" data-act="win-reset" title="恢复默认位置和大小">⤢</button>
        <button class="pe-close" data-act="close" title="关闭">✕</button>
      </div>
      <nav class="pe-tabs"></nav>
      <div class="pe-body" id="pe-body"></div>
      <div class="pe-resize" title="拖动调整大小"></div>`;
    document.body.appendChild(panel);
    panel.addEventListener('click', onClick);
    panel.addEventListener('change', onChange);
    panel.addEventListener('input', e => { if (e.target.dataset?.txt != null && e.target.tagName === 'INPUT') syncTxtField(e.target); });
    const zone = e => e.target.closest?.('#pe-txt-drop, #pe-org-drop');
    panel.addEventListener('dragover', e => { const z = zone(e); if (z) { e.preventDefault(); z.classList.add('pe-drop-on'); } });
    panel.addEventListener('dragleave', e => { zone(e)?.classList.remove('pe-drop-on'); });
    panel.addEventListener('drop', e => {
        const z = zone(e); if (!z) return;
        e.preventDefault(); z.classList.remove('pe-drop-on');
        const files = [...(e.dataTransfer?.files || [])];
        if (z.id === 'pe-org-drop') addOrgFiles(files); else loadTxtFiles(files);
    });
    bindWindow(panel);
    applyRect(panel, s0.winRect);
    window.addEventListener('resize', () => applyRect(panel, getSettings().winRect));
    refresh();
}

// ———— 窗口：拖动标题栏移动，拖右下角调整大小，位置和大小都记住 ————

function defaultRect() {
    const vw = window.innerWidth, vh = window.innerHeight;
    if (vw <= 760) return { left: 0, top: Math.round(vh * 0.08), width: vw, height: Math.round(vh * 0.86) };
    const width = Math.min(860, vw - 40);
    const height = Math.min(Math.round(vh * 0.86), 960);
    return { left: Math.round((vw - width) / 2), top: Math.round((vh - height) / 2), width, height };
}

function applyRect(panel, r) {
    const vw = window.innerWidth, vh = window.innerHeight;
    const d = defaultRect();
    const width = Math.min(Math.max(320, r?.width ?? d.width), vw);
    const height = Math.min(Math.max(240, r?.height ?? d.height), vh);
    // 至少留 80px 宽、标题栏整条在屏幕里，免得拖丢
    const left = Math.min(Math.max(80 - width, r?.left ?? d.left), vw - 80);
    const top = Math.min(Math.max(0, r?.top ?? d.top), vh - 44);
    Object.assign(panel.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
    return { left, top, width, height };
}

function bindWindow(panel) {
    const head = panel.querySelector('.pe-header');
    const grip = panel.querySelector('.pe-resize');
    const rectNow = () => ({ left: panel.offsetLeft, top: panel.offsetTop, width: panel.offsetWidth, height: panel.offsetHeight });
    const save = r => { getSettings().winRect = r; saveSettings(); };
    const drag = (el, onMove, skip) => {
        let st = null;
        el.addEventListener('pointerdown', e => {
            if ((e.button != null && e.button !== 0) || skip?.(e)) return;
            st = { x: e.clientX, y: e.clientY, r: rectNow() };
            el.setPointerCapture?.(e.pointerId);
            panel.classList.add('pe-moving');
            e.preventDefault();
        });
        el.addEventListener('pointermove', e => { if (st) onMove(st.r, e.clientX - st.x, e.clientY - st.y); });
        const end = e => {
            if (!st) return;
            st = null;
            el.releasePointerCapture?.(e.pointerId);
            panel.classList.remove('pe-moving');
            save(rectNow());
        };
        el.addEventListener('pointerup', end);
        el.addEventListener('pointercancel', end);
    };
    drag(head, (r, dx, dy) => applyRect(panel, { ...r, left: r.left + dx, top: r.top + dy }), e => e.target.closest('button, input, select, a'));
    drag(grip, (r, dx, dy) => applyRect(panel, { ...r, width: r.width + dx, height: r.height + dy }));
    head.addEventListener('dblclick', e => { if (e.target.closest('button')) return; save(null); applyRect(panel, null); });
}

export function togglePanel(force) {
    const p = document.getElementById('pe-panel');
    if (!p) return;
    const show = force ?? p.classList.contains('pe-hidden');
    p.classList.toggle('pe-hidden', !show);
    fab?.setActive(show);
    if (show) { applyRect(p, getSettings().winRect); refresh(); }
}

function setBusy(text) {
    busy = text || '';
    const b = document.getElementById('pe-busy');
    if (b) { b.textContent = busy ? `${busy}…` : ''; b.classList.toggle('on', !!busy); }
}

export function refresh() {
    const body = document.getElementById('pe-body');
    if (!body) return;
    const st = getState();
    const s = getSettings();
    const pending = st ? st.ledger.filter(e => e.status === 'candidate').length : 0;
    const nav = document.querySelector('#pe-panel .pe-tabs');
    if (nav) nav.innerHTML = TABS.map(([k, v]) => `<button data-tab="${k}" class="${k === tab ? 'active' : ''}">${v}${k === 'queue' && pending ? ` <span class="pe-count">${pending}</span>` : ''}</button>`).join('');
    const hd = document.getElementById('pe-head-date');
    if (hd) { hd.textContent = st?.currentDate ? `${st.currentDate} · ${weekdayZh(st.currentDate)}` : '未设定日期'; hd.classList.toggle('pe-unset', !st?.currentDate); }
    fab?.setBadge(pending);
    fab?.setVisible(!!s.enabled);
    if (!st) { body.innerHTML = '<div class="pe-empty">请先打开一个聊天。</div>'; return; }
    if (looksLikeBundleData(st)) {
        body.innerHTML = `<div class="pe-callout pe-callout-warn"><div><b>本聊天的数据有问题</b><br>
          看起来是把“整理包”当成存档导入了（设置页的“导入 JSON”），导致笔名、刊物、人物、作品都没有编号：所有作品都会被算到第一个笔名、第一家刊物名下，推演也无法进行。<br>
          点下面的按钮修复：会把这份数据当作整理包重新导入（先给出预览），原来推演出的内容会清掉。</div>
          <button class="menu_button pe-primary" data-act="repair-bundle-state">修复</button></div>`;
        return;
    }
    const render = simView ? simPage : { overview, queue, ledger, reading, works, people, era, importTab, settings }[tab === 'import' ? 'importTab' : tab];
    const y = body.scrollTop;
    const active = document.activeElement;
    if (active && body.contains(active)) active.blur();
    body.innerHTML = render(st, s);
    // 统一成酒馆原生控件样式（与书信簿一致）
    body.querySelectorAll('button').forEach(b => b.classList.add('menu_button'));
    body.querySelectorAll('input[type=text], input[type=number], input[type=password], select, textarea').forEach(x => x.classList.add('text_pole'));
    body.scrollTop = y;
}

function commit(msg) {
    saveState();
    app?.refreshInjection?.();
    refresh();
    if (msg) toast('success', msg);
}

// ———————————— 各页 ————————————

function overview(st, s) {
    const era = getEra();
    const cand = st.ledger.filter(e => e.status === 'candidate').length;
    const sched = st.ledger.filter(e => e.status === 'scheduled').length;
    const appr = st.ledger.filter(e => e.status === 'approved').length;
    const readers = (st.receptions || []).filter(r => ['skimmed', 'finished'].includes(r.read) && (!r.readDate || !st.currentDate || r.readDate <= st.currentDate)).length;
    const d = st.currentDate;
    const bigDate = d ? `${+d.slice(0, 4)} 年 ${+d.slice(5, 7)} 月 ${+d.slice(8, 10)} 日` : '尚未设定故事日期';
    const epiD = epistolaryAvailable() ? epistolaryStoryDate() : null;
    const recent = st.ledger.filter(e => e.status === 'approved').slice(-4).reverse();
    const pens = st.pennames.map(p => {
        const rep = st.reputation[p.id] || {};
        return `<tr><td><b>${h(p.name)}</b>${p.publicIdentityKnown ? ' <span class="pe-chip">身份已公开</span>' : ''}</td>${Object.keys(CIRCLES).map(c => `<td title="${(rep[c] || 0).toFixed(2)}" class="pe-rep pe-rep${Math.sign(Math.round((rep[c] || 0) * 2))}">${repLabel(rep[c] || 0)}</td>`).join('')}</tr>`;
    }).join('');
    const rumors = (st.rumors || []).map(r => `<div class="pe-card pe-card-slim"><div class="pe-card-main">${h(r.text)}
        <div class="pe-meter" title="热度 ${Math.round(r.strength * 100)}%"><i style="width:${Math.round(r.strength * 100)}%"></i></div></div>
        <div class="pe-card-actions"><button class="pe-mini" data-act="rumor-pin" data-id="${r.id}">${r.pinned ? '取消固定' : '固定'}</button>
        <button class="pe-mini" data-act="rumor-del" data-id="${r.id}">删除</button></div></div>`).join('');
    return `
    <div class="pe-hero">
      <div class="pe-hero-main">
        <div class="pe-hero-date">${h(bigDate)}</div>
        <div class="pe-hero-sub">${d ? h(weekdayZh(d)) + ' · ' : ''}${h(st.era?.place || '地点未设定')} · 年代档案 ${era ? `<span class="pe-ok">已生成</span>` : `<a data-tab-go="era" class="pe-link">未生成，去生成</a>`}</div>
      </div>
      <div class="pe-hero-side">
        ${!d ? '<div class="pe-muted">聊天里出现日期时会自动识别，也可以在下面手动设定。</div>' : ''}
        ${st.detectedDate ? `<div class="pe-callout">识别到新日期 <b>${h(st.detectedDate)}</b><button class="pe-primary" data-act="advance-detected">推进到这一天</button></div>` : ''}
        ${epiD && epiD !== d && (!d || epiD > d) ? `<div class="pe-callout">书信簿剧情日期 <b>${h(epiD)}</b><button class="pe-primary" data-act="epi-date-adopt">跟上</button></div>` : ''}
      </div>
    </div>
    ${st.weekdayWarning ? `<div class="pe-callout pe-callout-warn">⚠ ${h(st.weekdayWarning)} <button class="pe-mini" data-act="clear-wd">知道了</button></div>` : ''}
    <div class="pe-stats">
      <div class="pe-stat ${cand ? 'pe-stat-hot' : ''}" data-tab-go="queue"><b>${cand}</b><span>待你审核</span></div>
      <div class="pe-stat" data-tab-go="ledger"><b>${appr}</b><span>已见报 / 已收到</span></div>
      <div class="pe-stat" title="到期前不显示内容，避免剧透"><b>${sched}</b><span>已排期，未到期</span></div>
      <div class="pe-stat" data-tab-go="reading"><b>${readers}</b><span>读过的人次</span></div>
    </div>
    ${lastReport ? `<div class="pe-muted pe-report">上次推进 ${h(lastReport.from || '起点')} → ${h(lastReport.to)}：${lastReport.newCandidates.filter(x => x.status === 'candidate').length} 条待审核，${lastReport.autoApproved.length} 条次要反响自动入账，新排期 ${lastReport.scheduled} 条。</div>` : ''}
    ${backfillHint(st)}
    ${leaksBlock(st)}
    ${cand ? `<div class="pe-callout pe-callout-accent">有 <b>${cand}</b> 条反响等你确认。<button class="pe-primary" data-tab-go="queue">去审核</button></div>` : ''}

    <h4>最近入账</h4>
    ${recent.length ? recent.map(e => evCard(st, e, '', { compact: true })).join('') + '<div class="pe-more"><a class="pe-link" data-tab-go="ledger">查看全部账本 →</a></div>' : '<div class="pe-empty-sm">还没有入账的反响。</div>'}

    <h4>笔名声誉 <small class="pe-muted">只由已入账的公开反响改变</small></h4>
    ${st.pennames.length ? `<div class="pe-table-wrap"><table class="pe-table"><tr><th></th>${Object.values(CIRCLES).map(c => `<th>${c}</th>`).join('')}</tr>${pens}</table></div>` : '<div class="pe-empty-sm">还没有笔名。<a class="pe-link" data-tab-go="works">去添加</a></div>'}

    <h4>坊间传闻</h4>
    ${rumors || '<div class="pe-empty-sm">暂无。</div>'}
    <div class="pe-toolbar"><input id="pe-rumor" type="text" placeholder="手动添加一条传闻" class="pe-grow"><button data-act="rumor-add">添加</button></div>

    <details class="pe-fold"><summary>手动调整日期与地点</summary>
      <div class="pe-toolbar">
        <input id="pe-date" type="text" value="${h(d || '')}" placeholder="YYYY-MM-DD" style="width:9em">
        <button class="pe-primary" data-act="date-advance">推进到此日期</button>
        <button data-act="date-set" title="只改日期，不产生新的推演">设为当前（不推演）</button>
        <button data-act="date-detect">从最新消息识别</button>
      </div>
      <div class="pe-muted">日期只会向前推进；正文里提到的较早日期（例如回忆往事）不会把时间拨回去。改写或删除消息会自动回滚。</div>
      <div class="pe-toolbar">
        <span>年份 <b>${h(st.era?.year ?? '—')}</b></span>
        <input id="pe-place" type="text" value="${h(st.era?.place || '')}" placeholder="如：法国·巴黎" style="width:10em">
        <button data-act="place-save">保存地点</button>
        <button data-act="place-guess">从聊天猜测</button>
      </div>
    </details>
    <details class="pe-fold" ${st.backfillRun || !st.backfilledAt ? 'open' : ''}><summary>回溯推演：补上从首次发表到现在的经过</summary>${backfillBody(st)}</details>
    <details class="pe-fold"><summary>日志</summary>
      <ul class="pe-log">${(st.log || []).slice(0, 30).map(l => `<li><span class="pe-muted">${h(l.date || '')}</span> ${h(l.text)}</li>`).join('')}</ul>
    </details>`;
}

/** 一条反响的卡片。actions 是右侧按钮的 HTML */
// ———————————— 预演视图 ————————————

const pctTxt = p => `${Math.round((p || 0) * 100)}%`;
const bar = (p, cls = '') => `<span class="pe-bar ${cls}"><i style="width:${Math.round(Math.min(1, p || 0) * 100)}%"></i></span><b>${pctTxt(p)}</b>`;
const polBar = r => `<span class="pe-polbar" title="偏肯定 ${pctTxt(r.pos)} · 参半 ${pctTxt(r.mid)} · 偏批评 ${pctTxt(r.neg)}"><i class="p1" style="width:${r.pos * 100}%"></i><i class="p0" style="width:${r.mid * 100}%"></i><i class="p-1" style="width:${r.neg * 100}%"></i></span>`;

function simPage(st, s) {
    return `<div class="pe-toolbar"><button data-act="sim-close">← 返回</button><span class="pe-muted">预演在数据副本上进行，不会改动任何记录。</span></div>`
        + (simView.kind === 'work' ? simWorkPage(st, s) : simPersonPage(st, s));
}

function simWorkPage(st) {
    const w = byId(st.works, simView.workId);
    if (!w) return '<div class="pe-empty">作品不存在。</div>';
    const r = simView.result;
    const manualPeople = st.persons.filter(p => st.receptions.some(x => x.workId === w.id && x.personId === p.id && x.origin === 'manual'));
    return `
    <h4>推演${bt(w.title)} ${penChip(st, w.pennameId)}</h4>
    <div class="pe-toolbar">
      <label class="pe-inline-field">刊物 <select id="pe-sim-outlet"><option value="">（无刊物/自行出版）</option>${st.outlets.map(o => `<option value="${o.id}" ${o.id === (simView.outletId ?? w.outletId) ? 'selected' : ''}>${h(o.name)}</option>`).join('')}</select></label>
      <label class="pe-inline-field">发表日期 <input id="pe-sim-date" type="text" value="${h(simView.pubDate || w.pubDate || st.currentDate || '')}" placeholder="YYYY-MM-DD" style="width:8.5em"></label>
      <label class="pe-inline-field">只看到 <input id="pe-sim-until" type="text" value="${h(simView.until || '')}" placeholder="截止日期，可空" style="width:8.5em"></label>
      <label class="pe-inline-field">推演次数 <select id="pe-sim-runs">${[20, 40, 100].map(n => `<option ${n === (simView.runs || 40) ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <button class="pe-primary" data-act="sim-work-run">推演</button>
    </div>
    <div class="pe-muted">换个刊物或日期，就是“假如改投给某刊 / 推迟发表”会怎样。每次用不同的随机数推演，百分比是这些次里发生的比例。</div>
    ${r ? `
    <div class="pe-stats">
      <div class="pe-stat"><b>${r.expectContact.toFixed(1)}</b><span>人可能接触到</span></div>
      <div class="pe-stat pe-stat-hot"><b>${r.expectReaders.toFixed(1)}</b><span>人预计会读</span></div>
      <div class="pe-stat"><b>${r.expectPublic.toFixed(2)}</b><span>篇公开评论（期望）</span></div>
      <div class="pe-stat"><b>${r.expectLetters.toFixed(2)}</b><span>封私信（期望）</span></div>
    </div>
    <div class="pe-muted">${r.until ? `只统计到 ${h(r.until)}。` : ''}另有约 ${r.expectSeekers.toFixed(1)} 人会因此去找作者的其他作品（同系列最想找；旧报纸不一定找得到）。${r.outlets.length ? `公开评论最可能出现在：${r.outlets.slice(0, 4).map(o => `${h(byId(st.outlets, o.outletId)?.name || '?')}（${o.n.toFixed(2)} 篇）`).join('、')}。` : ''}</div>
    ${manualPeople.length ? `<div class="pe-muted">已有阅读记录、不参与预演：${manualPeople.map(p => personTag(p)).join('、')}</div>` : ''}
    <div class="pe-simtable">
      <div class="pe-simrow pe-simhead"><span>人物</span><span>接触</span><span>读</span><span>倾向</span><span>公开发表</span><span>私信</span><span>去找旧作</span></div>
      ${r.rows.filter(x => x.contact > 0 || x.read > 0).map(x => { const p = byId(st.persons, x.personId); return `<details class="pe-simrow-wrap"><summary class="pe-simrow">
        <span>${personTag(p)}</span><span>${bar(x.contact)}</span><span>${bar(x.read, 'hot')}</span><span>${x.read ? polBar(x) : '—'}</span>
        <span>${bar(x.public)}${x.layer ? ` <small>${h(LAYERS[x.layer]?.label || '')}</small>` : ''}</span><span>${bar(x.letter)}</span><span>${bar(x.seek)}</span></summary>
        <div class="pe-simdetail">${x.medianRead ? `一般在 <b>${h(x.medianRead)}</b> 前后读到。` : ''}${x.outletId ? `若公开发表，多半在《${h(byId(st.outlets, x.outletId)?.name || '')}》。` : ''}
          ${x.alsoRead.length ? `<div>顺带找来读的：${x.alsoRead.slice(0, 5).map(a => `${bt(byId(st.works, a.workId)?.title || '')}${pctTxt(a.p)}`).join('、')}</div>` : ''}
          ${x.sample ? `<div class="pe-muted">其中一次推演的经过：</div><ol class="pe-why-ol">${x.sample.why.map(t => `<li>${h(t)}</li>`).join('')}</ol>` : ''}</div></details>`; }).join('')}
    </div>
    ${r.rows.every(x => !x.contact) ? '<div class="pe-empty-sm">没有人接触得到。检查人物的“常读的报刊”和私交。</div>' : ''}` : ''}`;
}

function simPersonPage(st) {
    const p = byId(st.persons, simView.personId);
    if (!p) return '<div class="pe-empty">人物不存在。</div>';
    const works = [...st.works].filter(w => w.pubDate).sort((a, b) => cmp(a.pubDate, b.pubDate));
    const recOf = w => (st.receptions || []).filter(r => r.workId === w.id && r.personId === p.id && !r.superseded)
        .sort((a, b) => ['finished', 'skimmed', 'ignored', 'none'].indexOf(a.read) - ['finished', 'skimmed', 'ignored', 'none'].indexOf(b.read))[0];
    const fol = st.pennames.map(pen => ({ pen, since: st.followers?.[pen.id]?.[p.id], imp: impressionAt(st, pen.id, p.id, st.currentDate), hist: st.impressions?.[pen.id]?.[p.id] || [] })).filter(x => x.hist.length || x.since);
    const odds = simView.odds || {};
    const wi = simView.whatIf;
    const r = simView.result;
    const x = r?.rows?.[0];
    return `
    <h4>${personTag(p)} <span class="pe-chip pe-close-chip" style="--c:${CLOSE_COLOR[closeOf(p)]}">${CLOSE[closeOf(p)]}</span>
      <small class="pe-muted">${(p.roles || []).map(r2 => ROLES[r2]).join('/') || '不公开写评论'} · 常读：${[...new Set([...(p.reads || []), ...(p.outletIds || [])])].map(id => byId(st.outlets, id)?.name).filter(Boolean).join('、') || '（默认：供稿刊物和大报）'}</small></h4>
    ${fol.length ? `<h5>作者印象 <small class="pe-muted">和“欣赏/反感”分开：那是长期口味，这里是读过之后对这个署名的看法，按时间累积，可升可降</small></h5>
      ${fol.map(f => `<div class="pe-callout">${penChip(st, f.pen.id)} 截至 ${h(st.currentDate || '')}：<b>${IMPRESSION_LABEL(f.imp)}</b>（${f.imp.toFixed(2)}）
        ${f.since ? ` · 约 ${h(f.since)} 起开始留意这个署名` : ''}
        <div class="pe-muted">${f.hist.slice().sort((a, b) => cmp(a.date, b.date)).map(x => `${h(x.date)} 读${bt(byId(st.works, x.workId)?.title || '')}${x.delta >= 0 ? '+' : ''}${x.delta}`).join(' → ')}</div>
        <div class="pe-muted">印象 ≥ 1 时，此后的新作会经“追读”渠道读到；只看他当时已有的印象，以后的看法不会倒过来影响以前。他是否知道这个笔名背后是谁另算（“知道笔名身份”），对一个笔名的印象也不会转到另一个笔名上。</div></div>`).join('')}` : ''}
    ${relationsOf(st, p).length ? `<h5>熟人 <small class="pe-muted">读到东西可能谈起的对象</small></h5><div class="pe-era-chips pe-era-chips-wrap">${relationsOf(st, p).map(r => { const q = byId(st.persons, r.to); return q ? `<span class="pe-chip">${personTag(q)} ${h(REL_TYPES[r.type] || '')} · ${h(REL_FREQ[r.frequency] || '')}${r.implicit ? '（同刊同事）' : ''}${r.since ? ` · ${h(r.since)} 起` : ''}${r.until ? ` · 至 ${h(r.until)}` : ''}${r.discloseIdentity ? ' · 可能说出身份' : ''}</span>` : ''; }).join('')}</div>` : ''}
    <h5>和各部作品的关系（截至 ${h(st.currentDate || '')}）</h5>
    ${works.map(w => { const rc = recOf(w); const future = rc?.readDate && st.currentDate && rc.readDate > st.currentDate; const o = odds[w.id];
      return `<div class="pe-card pe-card-slim pe-colored" style="--c:${penColor(st, w.pennameId) || 'var(--pe-border)'}"><div class="pe-card-main">
        <b>${bt(w.title)}</b> <small class="pe-muted">${h(w.pubDate)}</small>
        ${rc ? `${rc.channel ? ` · ${h(CHANNELS[rc.channel] || '')}` : ''} · <b>${future ? '尚未读到' : h(READ_STATES[rc.read] || rc.read || '未推演')}</b>${rc.readDate && !future ? ` ${h(rc.readDate)}` : ''}${rc.strength && !future ? ` · <span class="pe-chip pe-pol pe-pol${rc.polarity}">${['偏批评', '参半', '偏肯定'][rc.polarity + 1]}</span> ${h(STRENGTH[rc.strength])} ${statusChip(rc)}` : ''}${rc.expression && !future ? ` · ${h(EXPRESSION[rc.expression])}` : ''}${rc.origin === 'manual' ? ' <span class="pe-chip">手动/导入</span>' : ''}${rc.seek ? ' <span class="pe-chip pe-chip-layer">由此开始追读</span>' : ''}`
          : ' · <span class="pe-muted">还没推演</span>'}
        ${rc?.opinion && !(rc.readDate && st.currentDate && rc.readDate > st.currentDate) ? `<div class="pe-evi">${h(rc.opinion.summary || '')} ${dimsHtml(rc.opinion.dimensions)}${rc.opinion.authorView ? `<div>对作者：${h(rc.opinion.authorView)}</div>` : ''}</div>` : ''}
        ${o ? `<div class="pe-muted">若重新推演：读到 ${pctTxt(o.read)}，偏肯定 ${pctTxt(o.read ? o.pos : 0)}，公开发表 ${pctTxt(o.public)}，写信 ${pctTxt(o.letter)}</div>` : ''}
        ${rc?.why?.length ? `<details class="pe-why"><summary>为什么？</summary><ol>${rc.why.map(t => `<li>${h(t)}</li>`).join('')}</ol></details>` : ''}
      </div><div class="pe-card-actions"><button class="pe-mini" data-act="sim-person-pick" data-id="${w.id}">假如他读到…</button></div></div>`; }).join('')}
    <div class="pe-toolbar"><button data-act="sim-person-odds">估算他读到每部作品的可能性</button></div>

    <h4>假如……</h4>
    <div class="pe-toolbar">
      <label class="pe-inline-field">他在 <input id="pe-sim-pdate" type="text" value="${h(wi?.date || st.currentDate || '')}" style="width:8.5em"></label>
      <label class="pe-inline-field">读完了 <select id="pe-sim-pwork">${works.map(w => `<option value="${w.id}" ${w.id === wi?.workId ? 'selected' : ''}>${bt(w.title)}</option>`).join('')}</select></label>
      <label class="pe-inline-field">推演次数 <select id="pe-sim-runs">${[40, 100].map(n => `<option ${n === (simView.runs || 40) ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <button class="pe-primary" data-act="sim-person-run">推演</button>
    </div>
    ${x ? `
    <div class="pe-stats">
      <div class="pe-stat"><span>看法</span>${polBar(x)}<span>偏肯定 ${pctTxt(x.pos)} · 参半 ${pctTxt(x.mid)} · 偏批评 ${pctTxt(x.neg)}；看法强烈 ${pctTxt(x.strong)}</span></div>
      <div class="pe-stat"><b>${pctTxt(x.public)}</b><span>会公开写${x.layer ? `（多为${h(LAYERS[x.layer]?.label || '')}${x.outletId ? '，登在《' + h(byId(st.outlets, x.outletId)?.name || '') + '》' : ''}）` : ''}</span></div>
      <div class="pe-stat"><b>${pctTxt(x.letter)}</b><span>会写信给作者</span></div>
      <div class="pe-stat pe-stat-hot"><b>${pctTxt(x.seek)}</b><span>会去找作者的其他作品</span></div>
    </div>
    ${x.alsoRead.length ? `<div><b>会找来读的</b>：${x.alsoRead.map(a => `<span class="pe-chip">${bt(byId(st.works, a.workId)?.title || '')}${pctTxt(a.p)}</span>`).join(' ')}</div>
      <div class="pe-muted">旧作找不找得到也有关系：成书和小册子好买，旧报纸要翻合订本。</div>` : x.seek ? '' : '<div class="pe-muted">不太会去找其他作品。</div>'}
    ${x.sample ? `<details class="pe-why"><summary>其中一次推演的经过</summary><ol>${x.sample.why.map(t => `<li>${h(t)}</li>`).join('')}</ol></details>` : ''}
    <div class="pe-toolbar">${wi?.date && st.currentDate && wi.date <= st.currentDate ? `<button class="pe-primary" data-act="sim-person-commit">这件事确实发生了，记下来</button><span class="pe-muted">记下后按正式规则推演他之后的反应（只取一种结果，不是概率）</span>` : `<span class="pe-muted">日期晚于当前故事日期，只能预演，不能记为已发生。</span>`}</div>` : ''}`;
}

let bfForm = { mode: 'hidden', by: 'floors', size: 100 };

/** 把聊天按楼层或字数分组，每组取其中识别到的最后一个故事日期 */
function planSegments(st, by, size) {
    const target = st.backfillRun?.target || st.currentDate;
    const first = st.works.map(w => w.pubDate).filter(Boolean).sort()[0];
    const segs = [];
    if (by !== 'days') {
        const chat = globalThis.SillyTavern?.getContext?.()?.chat || [];
        let running = null, cur = null;
        const hc = getSettings().headChars;
        chat.forEach((m, i) => {
            if (!m || m.is_system || typeof m.mes !== 'string') return;
            const pick = pickStoryDate(m.mes, running, { maxJumpDays: 400, headChars: hc });
            if (pick) running = pick.iso;
            if (!cur) cur = { fromMes: i, toMes: i, chars: 0, floors: 0, endDate: null };
            cur.toMes = i; cur.chars += m.mes.length; cur.floors++;
            if (running) cur.endDate = running;
            if ((by === 'floors' && cur.floors >= size) || (by === 'chars' && cur.chars >= size)) { segs.push(cur); cur = null; }
        });
        if (cur) segs.push(cur);
    }
    // 只留日期在作品发表之后、并且逐段往后推的；不满足的并进前一段
    let last = first ? addDays(first, -1) : null;
    let out = [];
    const mergePrev = g => { const p = out[out.length - 1]; if (p) { p.toMes = g.toMes; p.chars += g.chars; } };
    for (const g of segs) {
        if (!g.endDate || !first || cmp(g.endDate, first) < 0) { mergePrev(g); continue; }
        const end = cmp(g.endDate, target) > 0 ? target : g.endDate;
        if (last && cmp(end, last) <= 0) { mergePrev(g); continue; }
        out.push({ ...g, endDate: end });
        last = end;
    }
    if (by === 'days' || !out.length) {
        out = [];
        let d = first;
        const step = by === 'days' ? Math.max(1, size) : 14;
        while (d && cmp(d, target) < 0) { d = addDays(d, step); if (cmp(d, target) > 0) d = target; out.push({ endDate: d }); }
    }
    if (out.length && cmp(out[out.length - 1].endDate, target) < 0) out.push({ endDate: target, tail: true });
    return out;
}

function backfillBody(st) {
    const pubs = st.works.map(w => w.pubDate).filter(Boolean).sort();
    if (!pubs.length || !st.currentDate) return '<div class="pe-muted">需要先有故事日期和带发表日期的作品。</div>';
    const run = st.backfillRun;
    if (run) {
        const segs = run.segments || [];
        const done = segs.filter(x => x.result).length;
        const next = segs.find(x => !x.result);
        const segLine = (g, i) => {
            const r = g.result;
            const where = g.fromMes != null ? `第 ${g.fromMes + 1}–${g.toMes + 1} 楼 · 约 ${(g.chars / 10000).toFixed(1)} 万字` : g.tail ? '剩余部分' : '';
            return `<div class="pe-card pe-card-slim ${r ? '' : g === next ? 'pe-card-editing' : 'pe-txt-skip'}"><div class="pe-card-main">
              <b>第 ${i + 1} 段</b> <span class="pe-muted">${where}</span> · 推到 <b class="pe-num">${h(g.endDate)}</b>
              ${r ? `<div>读完 ${r.finished} · 读了一部分 ${r.skimmed} · 接触未读 ${r.ignored}${r.candidates ? ` · 回溯候选 ${r.candidates}` : ''}
                ${r.reads?.length ? `<div class="pe-muted">${r.reads.slice(0, 12).map(x => `${personTag(byId(st.persons, x.personId))} ${x.read === 'finished' ? '读完' : '读了部分'}${bt(byId(st.works, x.workId)?.title || '')}`).join('，')}${r.reads.length > 12 ? ` 等 ${r.reads.length} 人次` : ''}</div>` : ''}
                ${!r.finished && !r.skimmed && !r.ignored && r.diag ? `<div class="pe-muted">这一段没人读到：本段新轮到的“人物 × 作品”组合 ${r.diag.run} 个，已有记录跳过 ${r.diag.preexisting} 个，不参与推演的人 ${r.diag.inactive} 个。${r.diag.run ? '（都没接触到，可检查人物的常读报刊）' : '（这段时间没有新发表的作品，或组合都已推演过）'}</div>` : ''}</div>` : ''}
            </div></div>`;
        };
        return `<div class="pe-callout pe-callout-accent"><div>回溯进行中（${run.mode === 'hidden' ? '只补看不见的部分' : '全部补'}）：已推到 <b>${h(st.currentDate)}</b>，目标 ${h(run.target)}，${done}/${segs.length} 段。回溯期间新消息不会触发自动推进。</div></div>
          <div class="pe-toolbar">${next ? `<button class="pe-primary" data-act="bf-next">推演下一段（到 ${h(next.endDate)}）</button><button data-act="bf-all">剩下的一口气推完</button>` : '<button class="pe-primary" data-act="bf-finish">完成回溯</button>'}<button data-act="bf-cancel">放弃，从头再来</button></div>
          ${segs.map(segLine).join('')}`;
    }
    const sizeHint = { floors: '每段多少楼', chars: '每段多少字', days: '每段多少天（故事内）' };
    return `<div class="pe-muted">从最早的作品（${h(pubs[0])}）起，按规则把到 ${h(st.currentDate)} 为止的经过推演一遍。可以按聊天楼层、文本量或故事天数分段，一段一段推，每段推完先看结果再继续。手动录入和导入的记录、已入账的都保留；之前推演出但没入账的会重新生成。</div>
      <div class="pe-toolbar">
        <label class="pe-inline-field">补什么 <select id="pe-bf-mode"><option value="hidden" ${bfForm.mode === 'hidden' ? 'selected' : ''}>只补看不见的部分（推荐）</option><option value="all" ${bfForm.mode === 'all' ? 'selected' : ''}>连公开报道和私信也补（逐条审核）</option></select></label>
        <label class="pe-inline-field">分段 <select id="pe-bf-by"><option value="floors" ${bfForm.by === 'floors' ? 'selected' : ''}>按聊天楼层</option><option value="chars" ${bfForm.by === 'chars' ? 'selected' : ''}>按文本量</option><option value="days" ${bfForm.by === 'days' ? 'selected' : ''}>按故事天数</option></select></label>
        <label class="pe-inline-field" title="${sizeHint[bfForm.by]}">每段 <input id="pe-bf-size" type="number" min="1" value="${bfForm.size}" style="width:6em"> ${({ floors: '楼', chars: '字', days: '天' })[bfForm.by]}</label>
        <button class="pe-primary" data-act="bf-begin">生成分段并开始</button>
      </div>
      <ul class="pe-era-ul pe-muted">
        <li><b>只补看不见的部分</b>：已导入的剪报、读者来信、私信视为当时的全部。补的是谁读过哪部作品、私下怎么看、跟谁谈起，以及以后会不会对旧作发声。</li>
        <li><b>全部补</b>：导入的记录不全时用。补出的书评、私信、转载标着“回溯”，进待审核，不自动入账。</li>
        <li><b>按楼层 / 文本量</b>：从聊天里逐楼识别故事日期，每段推到那段里出现的最后一个日期。聊天里识别不到日期时，自动改成每 14 天一段。</li>
      </ul>`;
}

function leaksBlock(st) {
    const list = (st.identityLeaks || []).filter(x => x.status === 'pending' && (!st.currentDate || cmp(x.date, st.currentDate) <= 0));
    if (!list.length) return '';
    return `<div class="pe-callout pe-callout-warn"><div><b>可能的身份知情扩散（${list.length}）</b> <span class="pe-muted">推演认为有人可能在谈话里说出了作者是谁。不会自动生效，由你决定。</span>
      ${list.map(x => `<div class="pe-row">${h(x.date)} ${personTag(byId(st.persons, x.from))} → ${personTag(byId(st.persons, x.to))}：${penChip(st, x.pennameId)} 的身份（谈起${bt(byId(st.works, x.workId)?.title || '')}时）
        <button class="pe-mini" data-act="leak-yes" data-id="${x.id}">确有其事</button><button class="pe-mini" data-act="leak-no" data-id="${x.id}">没有</button></div>`).join('')}</div></div>`;
}

function backfillHint(st) {
    if (!st.currentDate || st.backfilledAt || st.backfillRun) return '';
    const early = st.works.filter(w => w.pubDate && cmp(w.pubDate, st.currentDate) < 0);
    const engineRecs = (st.receptions || []).filter(r => r.origin !== 'manual').length;
    if (!early.length || engineRecs) return '';
    return `<div class="pe-callout">已有 ${early.length} 部作品在 ${h(st.currentDate)} 之前发表，但还没有推演过这期间文学界的变化。
      <span class="pe-muted">到下方“回溯推演”分段补上。</span></div>`;
}

function evCard(st, e, actions = '', { compact = false } = {}) {
    const person = byId(st.persons, e.personId);
    const outlet = byId(st.outlets, e.outletId);
    const work = byId(st.works, e.workId);
    const agg = e.layer === 'reader_letters' || e.layer === 'mentions';
    const pol = agg ? `<span class="pe-chip">${e.layer === 'reader_letters' ? `约 ${e.count} 封` : `约 ${e.count} 条`}</span>` : `<span class="pe-chip pe-pol pe-pol${e.polarity}">${POLS[e.polarity]}</span>`;
    const major = isMajor(st, e);
    const who = [outlet ? `《${h(outlet.name)}》` : '', person ? personTag(person) : h(e.personName || '')].filter(Boolean).join(' ');
    const whoText = who || (e.layer === 'mentions' ? '各报' : e.layer === 'reader_letters' ? '读者' : '');
    const sum = e.text?.summary || '';
    return `<div class="pe-card ${major ? 'pe-card-major' : ''} pe-edge${agg ? 'n' : e.polarity}">
      <div class="pe-card-main">
        <div class="pe-card-top">
          <span class="pe-card-date">${h(e.date)}</span><span class="pe-muted">${e.datePrecision ? { xun: '（只知道旬）', month: '（只知道月份）', noLaterThan: '（不晚于）' }[e.datePrecision] || '' : weekdayZh(e.date)}</span>
          <span class="pe-chip pe-chip-layer">${h(LAYERS[e.layer]?.label || e.layer)}</span>${pol}
          ${major && e.status === 'candidate' ? '<span class="pe-chip pe-chip-major">需确认</span>' : ''}
          ${e.origin === 'manual' ? '<span class="pe-chip">手动</span>' : ''}${e.auto ? '<span class="pe-chip">自动入账</span>' : ''}${e.reactsTo ? '<span class="pe-chip">回应前文</span>' : ''}${e.epiLetterId ? '<span class="pe-chip">来自书信簿</span>' : ''}${e.backfill ? '<span class="pe-chip" title="回溯推演补出来的，原记录里没有">回溯</span>' : ''}
        </div>
        <div class="pe-card-title">${whoText || '<span class="pe-muted">（未指定）</span>'}${work ? ` <span class="pe-muted">评</span> ${bt(work.title)} ${st.pennames.length > 1 ? penChip(st, work.pennameId) : ''}` : ''}</div>
        ${e.text?.title ? `<div class="pe-card-sub">「${h(e.text.title)}」${e.text.byline ? ` <span class="pe-muted">${h(e.text.byline)}</span>` : ''}</div>` : ''}
        ${sum ? `<div class="pe-card-sum">${h(compact ? truncate(sum, 90) : sum)}</div>` : ''}
        ${!compact && e.why?.length ? `<details class="pe-why"><summary>为什么会发生？</summary><ol>${e.why.map(w => `<li>${h(w)}</li>`).join('')}</ol></details>` : ''}
        ${!compact ? (e.flags || []).filter(f => f !== '手动录入').map(f => `<div class="pe-flag">⚠ ${h(f)}</div>`).join('') : ''}
        ${!compact && e.text?.body ? `<details class="pe-why"><summary>正文</summary><div class="pe-text">${h(e.text.body).replace(/\n/g, '<br>')}</div></details>` : ''}
      </div>
      ${actions ? `<div class="pe-card-actions">${actions}</div>` : ''}
    </div>`;
}

function queue(st) {
    const cands = st.ledger.filter(e => e.status === 'candidate');
    const majors = cands.filter(e => isMajor(st, e));
    const minors = cands.filter(e => !isMajor(st, e));
    const unwritten = st.ledger.filter(e => e.status === 'approved' && !e.text?.body && e.layer !== 'reader_letters' && e.layer !== 'mentions');
    const sched = st.ledger.filter(e => e.status === 'scheduled').length;
    const LAYER_OPTS = Object.fromEntries(Object.entries(LAYERS).map(([k, v]) => [k, v.label]));
    const act = e => `<button class="pe-primary" data-act="approve" data-id="${e.id}">入账</button>
          <button data-act="approve-write" data-id="${e.id}">入账并写稿</button>
          <button data-act="reject" data-id="${e.id}">驳回</button>
          <details class="pe-more-acts"><summary>调整</summary>
            <button data-act="ev-date" data-id="${e.id}">改日期</button>
            <button data-act="ev-pol" data-id="${e.id}">改褒贬</button>
            <button data-act="ev-note" data-id="${e.id}">写稿要求</button></details>`;
    return `
    <h4>需要你确认 <span class="pe-count">${cands.length}</span>
      ${cands.length ? `<span class="pe-spacer"></span><button data-act="approve-all">全部入账</button><button data-act="reject-all">全部驳回</button>` : ''}</h4>
    <div class="pe-muted">入账后才计入声誉、进入主对话。正式书评、论战和真实人物的私信总在这里等你；次要事件默认自动入账（可在设置里改）。</div>
    ${majors.map(e => evCard(st, e, act(e))).join('')}
    ${minors.length ? `${majors.length ? '<h5>次要事件</h5>' : ''}${minors.map(e => evCard(st, e, act(e))).join('')}` : ''}
    ${!cands.length ? '<div class="pe-empty">没有待审核的反响。故事日期推进后会自动产生。</div>' : ''}
    ${sched ? `<div class="pe-muted">另有 ${sched} 条已排期，到期后才会出现。</div>` : ''}

    <h4>已入账、尚未写稿 <span class="pe-count pe-count-dim">${unwritten.length}</span>
      ${unwritten.length ? `<span class="pe-spacer"></span><button data-act="write-all">逐条写稿</button>` : ''}</h4>
    ${unwritten.map(e => evCard(st, e, `<button class="pe-primary" data-act="write" data-id="${e.id}">写稿</button><button data-act="preview-prompt" data-id="${e.id}">看提示词</button>`)).join('') || '<div class="pe-empty-sm">无</div>'}

    <details class="pe-fold"><summary>手动录入一条反响</summary>
      <div class="pe-muted">录入模拟中已经确认发生的事（例如某人某日的私信），或你想强制安排的评论。</div>
      <div class="pe-form" id="pe-manual">
        ${fieldHtml({ key: 'date', label: '日期', placeholder: 'YYYY-MM-DD' }, st.currentDate)}
        ${fieldHtml({ key: 'layer', label: '层级', type: 'select', options: LAYER_OPTS }, 'notice')}
        ${fieldHtml({ key: 'personId', label: '人物', type: 'select', options: optsOf(x => x.persons) }, '', st)}
        ${fieldHtml({ key: 'outletId', label: '刊物', type: 'select', options: optsOf(x => x.outlets) }, '', st)}
        ${fieldHtml({ key: 'workId', label: '作品', type: 'select', options: optsOf(x => x.works, 'title') }, '', st)}
        ${fieldHtml({ key: 'polarity', label: '褒贬', type: 'select', options: POLS }, 0)}
        ${fieldHtml({ key: 'count', label: '来信数量（仅读者来信）', type: 'number' }, '')}
        ${fieldHtml({ key: 'summary', label: '内容概要', type: 'textarea', rows: 2 }, '')}
        ${fieldHtml({ key: 'approved', label: '直接入账', type: 'checkbox' }, true)}
      </div>
      <button class="pe-primary" data-act="manual-add">录入</button>
    </details>`;
}

function ledger(st) {
    const items = st.ledger.filter(e => e.status === 'approved' && (!ledgerFilter || e.workId === ledgerFilter)).slice().reverse();
    const wopts = optsOf(x => x.works, 'title')(st);
    wopts[''] = '全部作品';
    return `
    <div class="pe-toolbar">
      <select id="pe-ledger-filter">${Object.entries(wopts).map(([k, v]) => `<option value="${h(k)}" ${k === ledgerFilter ? 'selected' : ''}>${h(v)}</option>`).join('')}</select>
      <span class="pe-muted">${items.length} 条，最新的在前</span><span class="pe-spacer"></span>
      <button data-act="export-ledger">导出为文本</button>
    </div>
    ${items.map(e => evCard(st, e, `<button ${e.text?.body || ['mentions', 'reader_letters'].includes(e.layer) ? '' : 'class="pe-primary"'} data-act="write" data-id="${e.id}">${e.text?.body ? '重写' : '写稿'}</button>
        <details class="pe-more-acts"><summary>更多</summary>
          <button data-act="ev-summary" data-id="${e.id}">改概要</button>
          <button data-act="ev-reply" data-id="${e.id}">安排一篇回应</button>
          <button data-act="unapprove" data-id="${e.id}">撤回入账</button>
          <button data-act="ev-del" data-id="${e.id}">删除</button></details>`)).join('') || '<div class="pe-empty">还没有入账的反响。</div>'}`;
}

function reading(st) {
    const wopts = optsOf(x => x.works, 'title')(st);
    wopts[''] = '（全部作品）';
    const recs = (st.receptions || []).filter(r => !ledgerFilter || r.workId === ledgerFilter);
    const byWork = {};
    for (const r of recs) (byWork[r.workId] = byWork[r.workId] || []).push(r);
    const visible = r => !r.contactDate || !st.currentDate || r.contactDate <= st.currentDate;
    const blocks = Object.entries(byWork).map(([wid, list]) => {
        const w = byId(st.works, wid);
        const shown = list.filter(visible);
        const cnt = k => shown.filter(r => r.read === k).length;
        const rows = shown.filter(r => r.read !== 'none').sort((a, b) => cmp(a.readDate || a.contactDate || '9', b.readDate || b.contactDate || '9')).map(r => {
            const p = byId(st.persons, r.personId);
            const future = r.readDate && st.currentDate && r.readDate > st.currentDate;
            return `<li>${personTag(p, '?')} · ${h(CHANNELS[r.channel] || r.channel || '')} ${h(r.contactDate || '')}
              · ${future ? '尚未读到' : h(READ_STATES[r.read] || r.read)}${r.readDate && !future ? ' ' + h(r.readDate) : ''}
              ${!future && r.strength ? `· <span class="pe-pol pe-pol${r.polarity}">${['偏批评', '参半', '偏肯定'][r.polarity + 1]}</span> ${h(STRENGTH[r.strength])} ${statusChip(r)}` : ''}
              ${!future && r.expression ? `· ${h(EXPRESSION[r.expression])}` : ''}
              ${r.origin === 'manual' ? '<small class="pe-tag">手动</small>' : ''}${r.viaEventId ? '<small class="pe-tag">因评论得知</small>' : ''}
              ${r.opinion ? `<div class="pe-evi">私下看法：${h(r.opinion.summary || '')}${r.opinion.understanding && r.opinion.understanding !== 'full' ? `（${r.opinion.understanding === 'partial' ? '部分理解' : '有误读'}）` : ''} ${dimsHtml(r.opinion.dimensions)}
                ${r.opinion.authorView ? `<div>对作者：${h(r.opinion.authorView)}</div>` : ''}${r.opinion.changeFromBefore ? `<div class="pe-muted">与以前相比：${h(r.opinion.changeFromBefore)}</div>` : ''}</div>` : ''}
              <details class="pe-why"><summary>为什么？</summary><ol>${(r.why || []).map(x => `<li>${h(x)}</li>`).join('')}</ol></details>
              ${!future && ['skimmed', 'finished'].includes(r.read) ? `<button class="pe-mini" data-act="gen-opinion" data-id="${r.id}">${r.opinion ? '重新生成看法' : '生成私下看法'}</button>` : ''}</li>`;
        }).join('');
        return `<section><h4>${bt(w?.title || '?')} ${w ? penChip(st, w.pennameId) : ''}</h4>
          <p><small>截至今天：未接触 ${cnt('none')} · 接触未读 ${cnt('ignored')} · 读了一部分 ${cnt('skimmed')} · 读完 ${cnt('finished')}（尚未发生的阅读不显示）</small></p>
          <ul class="pe-list">${rows || '<li>暂无人读过。</li>'}</ul></section>`;
    }).join('');
    return `
    <section>
      <div class="pe-row"><span>筛选：</span><select id="pe-ledger-filter">${Object.entries(wopts).map(([k, v]) => `<option value="${h(k)}" ${k === ledgerFilter ? 'selected' : ''}>${h(v)}</option>`).join('')}</select></div>
      <p><small>阅读记录是私下的：谁读了、读了多少、怎么看，大多不会公开。只有“表达”一关产生的文章、私信才会进入候选和账本。“生成私下看法”才会调用模型；写稿时也会自动补上。</small></p>
    </section>
    ${blocks || '<p>还没有阅读记录。设定故事日期并推进后会产生。</p>'}
    <section>
      <h4>手动记录一次阅读</h4>
      <p><small>例如书信或剧情里已经写明“某人某日读过某作品”。记录后会从这里继续推演他的看法和表达。</small></p>
      <div class="pe-form" id="pe-manual-read">
        ${fieldHtml({ key: 'workId', label: '作品', type: 'select', options: optsOf(x => x.works, 'title') }, '', st)}
        ${fieldHtml({ key: 'personId', label: '人物', type: 'select', options: optsOf(x => x.persons) }, '', st)}
        ${fieldHtml({ key: 'date', label: '日期', placeholder: 'YYYY-MM-DD' }, st.currentDate)}
        ${fieldHtml({ key: 'read', label: '读到什么程度', type: 'select', options: { finished: '读完', skimmed: '读了一部分' } }, 'finished')}
        ${fieldHtml({ key: 'note', label: '依据' }, '')}
      </div>
      <button class="pe-primary" data-act="manual-read">记录</button>
    </section>`;
}

const TRUST = { 0.3: '低', 0.6: '中', 0.9: '高' };
function relRow(st, self, r = {}) {
    const opt = (o, v) => Object.entries(o).map(([k, l]) => `<option value="${h(k)}" ${String(k) === String(v) ? 'selected' : ''}>${h(l)}</option>`).join('');
    const people = st.persons.filter(p => p.id !== self.id);
    const tr = r.trust == null ? 0.6 : [0.3, 0.6, 0.9].reduce((a, b) => (Math.abs(b - r.trust) < Math.abs(a - r.trust) ? b : a));
    return `<div class="pe-rel-row">
      <select data-r="to" class="text_pole"><option value="">（选择人物）</option>${people.map(p => `<option value="${p.id}" ${p.id === r.to ? 'selected' : ''}>${h(p.name)}</option>`).join('')}</select>
      <select data-r="type" class="text_pole">${opt(REL_TYPES, r.type || 'friend')}</select>
      <select data-r="closeness" class="text_pole">${opt(CLOSE, r.closeness ?? 1)}</select>
      <select data-r="frequency" class="text_pole">${opt(REL_FREQ, r.frequency || 'monthly')}</select>
      <select data-r="trust" class="text_pole" title="对这个人的信任">${opt(TRUST, tr)}</select>
      <label title="会不会跟他谈起读过的东西、自己的看法"><input type="checkbox" data-r="discloseOpinions" ${r.discloseOpinions === false ? '' : 'checked'}> 谈看法</label>
      <label title="自己知道笔名背后是谁时，肯不肯告诉他"><input type="checkbox" data-r="discloseIdentity" ${r.discloseIdentity ? 'checked' : ''}> 可能说出作者身份</label>
      <input type="text" data-r="since" class="text_pole" value="${h(r.since || '')}" placeholder="从（可空）" title="关系从哪天开始，例如搬来同住、初次结识" style="width:7.5em">
      <input type="text" data-r="until" class="text_pole" value="${h(r.until || '')}" placeholder="到（可空）" title="哪天起断了往来" style="width:7.5em">
      <button class="menu_button pe-mini" data-act="rel-del" title="删除">✕</button></div>`;
}
function relationsEditor(obj, st) {
    const incoming = st.persons.filter(p => p.id !== obj.id && (p.relations || []).some(r => r.to === obj.id));
    return `<div class="pe-field pe-wide"><label>熟人关系 <small class="pe-muted">有方向：这里写的是“${h(obj.name || '此人')}对别人”。见面越勤、越亲近，读到的东西越可能谈起；同一刊物的同事不填也会按“每周见、一般熟”算</small></label>
      <div class="pe-rel-list" data-self="${obj.id}">${(obj.relations || []).map(r => relRow(st, obj, r)).join('')}</div>
      <div class="pe-row"><button class="menu_button" data-act="rel-add">＋ 添加关系</button>
      ${incoming.length ? `<small class="pe-muted">反过来，把${h(obj.name || '此人')}列为熟人的有：${incoming.map(p => personTag(p)).join('、')}</small>` : ''}</div></div>`;
}
function readRelations(root) {
    return [...root.querySelectorAll('.pe-rel-row')].map(row => {
        const g = k => row.querySelector(`[data-r="${k}"]`);
        return { to: g('to').value, type: g('type').value, closeness: +g('closeness').value, frequency: g('frequency').value, trust: +g('trust').value, discloseOpinions: g('discloseOpinions').checked, discloseIdentity: g('discloseIdentity').checked, since: normalizeISO(g('since').value) || '', until: normalizeISO(g('until').value) || '' };
    }).filter(r => r.to);
}

function listBlock(title, kind, list, spec, st, labelFn, styleFn = null, extra = '', actionsFn = null) {
    const isEdit = editing && editing.kind === kind;
    const isNew = isEdit && !list.some(x => x.id === editing.id);
    const editor = o => { if (!o) return ''; const obj = kind === 'penname' && !o.color ? { ...o, color: penColor(st, o.id) || PEN_PALETTE[st.pennames.length % PEN_PALETTE.length] } : o; return `<div class="pe-editor" data-kind="${kind}">
          <div class="pe-editor-head">${isNew ? `新建${title}` : `编辑${title}：<b>${h(obj.title || obj.name || '')}</b>`}</div>
          ${formHtml(spec, obj, st)}
          ${kind === 'person' ? relationsEditor(obj, st) : ''}
          <div class="pe-row"><button class="pe-primary" data-act="save-item" data-kind="${kind}">保存</button><button data-act="cancel-edit">取消</button>
          ${kind === 'work' && !isNew ? `<button data-act="reroll-work" data-id="${obj.id}" title="资料改动后，重新推演尚未批准的回应">按新资料重推</button><button data-act="gen-card" data-id="${obj.id}" title="先保存原文，再生成">生成证据卡</button>` : ''}</div>
          ${kind === 'work' && obj?.evidence ? `<details><summary>证据卡（${h(obj.evidence.builtAt?.slice(0, 10) || '')}，${(obj.evidence.keyPoints || []).length} 条${obj.evidence.stale ? '，原文已更新，建议重新生成' : ''}）</summary><div class="pe-text">${h(cardText(obj.evidence, 6000)).replace(/\n/g, '<br>')}</div></details>` : ''}</div>`; };
    return `
    <section>
      <h4>${title} <span class="pe-count pe-count-dim">${list.length}</span><span class="pe-spacer"></span>${isNew ? '' : `<button data-act="new-item" data-kind="${kind}">＋ 新增${title}</button>`}</h4>
      ${extra}
      ${isNew ? editor(editing.draft) : ''}
      ${list.map(x => (isEdit && editing.id === x.id) ? editor(x) : `<div class="pe-card pe-card-slim ${styleFn ? 'pe-colored' : ''}" ${styleFn ? `style="--c:${styleFn(x)}"` : ''}><div class="pe-card-main">${labelFn(x)}</div><div class="pe-card-actions pe-card-actions-row">${actionsFn ? actionsFn(x) : ''}
        <button data-act="edit-item" data-kind="${kind}" data-id="${x.id}">编辑</button>
        <button data-act="del-item" data-kind="${kind}" data-id="${x.id}">删除</button></div></div>`).join('') || (isNew ? '' : '<div class="pe-empty-sm">还没有。</div>')}
    </section>`;
}

function txtImportBlock(st) {
    const outOpts = r => `<option value="">（无刊物）</option>${st.outlets.map(o => `<option value="${h(o.id)}" ${o.id === r.outletId ? 'selected' : ''}>${h(o.name)}</option>`).join('')}${r.outletName && !r.outletId ? `<option value="new:${h(r.outletName)}" ${r.newOutlet ? 'selected' : ''}>新建刊物“${h(r.outletName)}”</option>` : ''}`;
    const actOpts = r => `<option value="new" ${r.action === 'new' ? 'selected' : ''}>新建作品</option>${st.works.map(w => `<option value="update:${h(w.id)}" ${r.action === 'update' && r.workId === w.id ? 'selected' : ''}>更新${bt(w.title)}</option>`).join('')}<option value="skip" ${r.action === 'skip' ? 'selected' : ''}>跳过</option>`;
    const formOpts = r => Object.entries(FORMS).map(([k, v]) => `<option value="${k}" ${k === r.form ? 'selected' : ''}>${h(v)}</option>`).join('');
    return `
    <section class="pe-drop" id="pe-txt-drop">
      <h4>从 txt 导入作品</h4>
      <div class="pe-muted">按文件名识别：<b>作品名-刊物名1890-4-12.txt</b>。日期取首次发表（连载写第一期）；“小册子/单行本”会当作形式而不是刊物；写“1890-6中”的记为约略日期；文件名开头的 0、AA 之类前缀会去掉；没有日期的当作未发表的稿子，默认跳过。也可以把文件直接拖到这里。</div>
      <div class="pe-toolbar">
        <label class="menu_button pe-file pe-primary">选择 txt 文件（可多选）<input type="file" id="pe-txt-files" multiple accept=".txt,.md,text/plain" hidden></label>
        ${txtPlan.length ? `<button class="pe-primary" data-act="txt-commit">导入 ${txtPlan.filter(r => r.action !== 'skip').length} 个</button><button data-act="txt-clear">清空</button>
        <label class="pe-check-inline"><input type="checkbox" id="pe-txt-overwrite" ${txtOverwrite ? 'checked' : ''}> 更新已有作品时，也用文件名覆盖它的日期、刊物和形式</label>` : ''}
      </div>
      ${txtPlan.map((r, i) => `<div class="pe-card pe-txt-row ${r.action === 'skip' ? 'pe-txt-skip' : ''}">
        <div class="pe-card-main">
          <div class="pe-card-top"><span class="pe-muted">${h(r.fileName)}</span><span class="pe-chip">${r.length} 字</span>
            ${r.isDraft ? '<span class="pe-chip">无日期·当作草稿</span>' : ''}${r.dateApprox ? `<span class="pe-chip pe-chip-major">约略日期“${h(r.dateRaw)}”，请核对</span>` : ''}</div>
          <div class="pe-txt-grid">
            <label>作品名<input type="text" data-txt="${i}" data-f="title" value="${h(r.title)}"></label>
            <label>首次发表<input type="text" data-txt="${i}" data-f="date" value="${h(r.date)}" placeholder="YYYY-MM-DD"></label>
            <label>刊物<select data-txt="${i}" data-f="outlet">${outOpts(r)}</select></label>
            <label>形式<select data-txt="${i}" data-f="form">${formOpts(r)}</select></label>
            <label>操作<select data-txt="${i}" data-f="action">${actOpts(r)}</select></label>
          </div>
        </div></div>`).join('')}
    </section>`;
}

function works(st) {
    return txtImportBlock(st)
        + listBlock('作品', 'work', [...st.works].sort((a, b) => cmp(a.pubDate || '9', b.pubDate || '9')), WORK_SPEC, st, w => `${penChip(st, w.pennameId)} <b>${bt(w.title)}</b> <small>${h(FORMS[w.form] || '')} · ${h(byId(st.outlets, w.outletId)?.name || '')} · ${h(w.pubDate || '未定日期')}${w.datePrecision ? ({ xun: '（只知道旬）', month: '（只知道月份）', noLaterThan: '（不晚于）' }[w.datePrecision] || '') : ''}${w.sourceText ? ` · 原文 ${w.sourceText.length} 字` : ''}${w.evidence ? ' · 有证据卡' : ''}</small>`, w => penColor(st, w.pennameId) || 'var(--pe-border)', st.pennames.length > 1 ? `<div class="pe-legend">${st.pennames.map(p => penChip(st, p.id)).join('')}</div>` : '', w => `<button class="pe-primary" data-act="sim-work" data-id="${w.id}" title="谁可能读到、会怎么反应；也可以假设改投别的刊物">推演</button>`)
        + listBlock('笔名', 'penname', st.pennames, PEN_SPEC, st, p => `${penChip(st, p.id)} ${p.owner ? '<small>（' + h(p.owner) + '）</small>' : ''} ${p.publicIdentityKnown ? '<small class="pe-tag">身份已公开</small>' : ''}`, p => penColor(st, p.id));
}

async function loadTxtFiles(files) {
    const st = getState();
    if (!st || !files?.length) return;
    setBusy('读取 txt');
    try {
        for (const f of files) {
            if (!/\.(txt|md|text)$/i.test(f.name) && f.type && !f.type.startsWith('text/')) continue;
            const text = await readTextFile(f);
            txtPlan = txtPlan.filter(r => r.fileName !== f.name);
            txtPlan.push({ ...planImport(st, f.name, text), text });
        }
        txtPlan.sort((a, b) => cmp(a.date || '9999', b.date || '9999'));
    } finally { setBusy(''); }
    refresh();
}

function syncTxtField(t) {
    const r = txtPlan[+t.dataset.txt];
    if (!r) return;
    const f = t.dataset.f;
    if (f === 'title') r.title = t.value.trim();
    else if (f === 'date') { r.date = normalizeISO(t.value.trim()) || t.value.trim(); r.dateApprox = false; }
    else if (f === 'form') r.form = t.value;
    else if (f === 'outlet') {
        if (t.value.startsWith('new:')) { r.outletId = ''; r.newOutlet = true; } else { r.outletId = t.value; r.newOutlet = false; }
    } else if (f === 'action') {
        if (t.value.startsWith('update:')) { r.action = 'update'; r.workId = t.value.slice(7); } else { r.action = t.value; }
        refresh();
    }
}

function commitTxt(st) {
    const MAX = 150000;
    let made = 0, updated = 0, outlets = 0;
    const bad = [];
    for (const r of txtPlan) {
        if (r.action === 'skip') continue;
        if (!r.title) { bad.push(r.fileName + '：缺作品名'); continue; }
        if (r.date && !/^\d{4}-\d{2}-\d{2}$/.test(r.date)) { bad.push(r.fileName + '：日期格式不对'); continue; }
        let outletId = r.outletId;
        if (!outletId && r.newOutlet && r.outletName) {
            let o = findOutlet(st, r.outletName);
            if (!o) { o = { ...blankOutlet(), name: r.outletName }; st.outlets.push(o); outlets++; }
            outletId = o.id;
        }
        const text = String(r.text || '').slice(0, MAX);
        let w = r.action === 'update' ? byId(st.works, r.workId) : null;
        if (w) {
            w.sourceText = text;
            w.sourceFrom = [`txt:${r.fileName}`];
            if (w.evidence) w.evidence.stale = true;
            if (txtOverwrite || !w.pubDate) w.pubDate = r.date || w.pubDate;
            if (txtOverwrite || !w.outletId) w.outletId = outletId || w.outletId;
            if (txtOverwrite) w.form = r.form;
            updated++;
        } else {
            w = { ...blankWork(), title: r.title, pubDate: r.date || '', outletId: outletId || '', form: r.form, pennameId: st.pennames[0]?.id || '', sourceText: text, sourceFrom: [`txt:${r.fileName}`] };
            st.works.push(w);
            made++;
        }
    }
    txtPlan = [];
    logLine(st, `txt 导入：新建 ${made}，更新 ${updated}，新刊物 ${outlets}`);
    commit(`已导入：新建 ${made} 部、更新 ${updated} 部${outlets ? `，新建刊物 ${outlets} 个（请到“人物与刊物”补全出刊周期）` : ''}${bad.length ? `；跳过 ${bad.length} 个：${bad.join('；')}` : ''}`);
}

function pickUpdate(st, r) {
    const p = planImport(st, r.fileName, r.text);
    return p.action === 'update' ? { action: 'update', workId: p.workId } : {};
}

function findOutlet(st, name) {
    const n = String(name).replace(/\s/g, '');
    return st.outlets.find(o => o.name.replace(/\s/g, '') === n) || st.outlets.find(o => { const m = o.name.replace(/\s/g, ''); return m.includes(n) || n.includes(m); }) || null;
}

function conceptsBlock(st) {
    const total = allTags(st).length;
    const un = unclassified(st);
    const groups = conceptGroups(st);
    return `<details class="pe-fold" ${st.concepts && !un.length ? '' : 'open'}><summary>标签语义归类 <span class="pe-muted">${st.concepts ? `已归 ${groups.length} 组` : '未归类'}${un.length ? ` · ${un.length}/${total} 个标签还没归类` : ''}</span></summary>
      <div class="pe-muted">人物的关注、欣赏、反感和作品题材往往不是同一个词（“家庭责任”“长子困境”“道德义务”）。归类一次，推演就能认出意思相近的标签，而不必手改成同一个词。只在这里调用模型，之后推演不再调用。没归类的标签按字面兜底：相同或互相包含算匹配，只共用词根的只算“有点兴趣”，不影响褒贬。</div>
      <div class="pe-toolbar"><button class="pe-primary" data-act="concepts-build" ${un.length ? '' : 'disabled'}>${st.concepts ? `归类新增的 ${un.length} 个标签` : `用模型归类全部 ${total} 个标签`}</button>${st.concepts ? '<button data-act="concepts-rebuild">全部重新归类</button>' : ''}</div>
      ${groups.length ? `<div class="pe-concepts">${groups.map(g => `<div><b>${h(g.name)}</b> <span class="pe-muted">${g.tags.map(h).join('、')}</span></div>`).join('')}</div>` : ''}
    </details>`;
}

function people(st) {
    return conceptsBlock(st) + listBlock('刊物', 'outlet', st.outlets, OUTLET_SPEC, st, o => `<b>${h(o.name)}</b> <small>${h(PERIODICITY[o.periodicity] || '')}${o.periodicity === 'weekly' && Number.isInteger(o.weekday) ? '·' + WEEKDAYS[o.weekday] : ''} · ${h(CIRCLES[o.circle] || '')} · ${h(tagsToText(o.politics))}</small>`)
        + listBlock('人物', 'person', [...st.persons].sort((a, b) => closeOf(b) - closeOf(a)), PERSON_SPEC, st, p => `${personTag(p)} <span class="pe-chip pe-close-chip" style="--c:${CLOSE_COLOR[closeOf(p)]}">${CLOSE[closeOf(p)]}</span> <small>${(p.roles || []).map(r => ROLES[r]).join('/')} · ${(p.outletIds || []).map(id => byId(st.outlets, id)?.name).filter(Boolean).join('、') || '无供稿刊物'} ${(p.relations || []).length ? ` · 熟人 ${(p.relations || []).length}` : ''}${p.knowsIdentity ? ' · 知道笔名身份' : ''}${p.real ? ' · 真实人物' : ''}${p.active === false ? ' · 不参与推演' : ''}</small>`, p => CLOSE_COLOR[closeOf(p)], `<div class="pe-muted">颜色表示与主角的私交，按私交从深到浅排列：</div>${closeLegend()}`, p => `<button class="pe-primary" data-act="sim-person" data-id="${p.id}" title="此人和作者作品的关系；假如他读到某部作品会怎样">推演</button>`);
}

// ———— 年代档案的排版：把模型返回的长串拆成卡片、标签和列表 ————

const asArr = v => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]);
const asText = v => (typeof v === 'string' ? v : v == null ? '' : typeof v === 'object' ? Object.values(v).filter(Boolean).join(' / ') : String(v));
/** 把 ；; 。分隔的长句拆成条目 */
function splitPoints(t, commas = false) {
    // 按 ；; 。（可选：，,）拆，括号里的不拆
    const out = []; let cur = ''; let depth = 0;
    const seps = commas ? '；;。，,' : '；;。';
    for (const ch of String(t || '')) {
        if ('（(《“'.includes(ch)) depth++;
        if ('）)》”'.includes(ch)) depth = Math.max(0, depth - 1);
        if (!depth && seps.includes(ch)) { if (cur.trim()) out.push(cur.trim()); cur = ''; continue; }
        cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
}
/** 突出价格、数字和书名号里的名字 */
function emph(t) {
    return h(t)
        .replace(/(\d[\d,.]*\s*(?:至|-|–|~)?\s*\d*[\d,.]*\s*(?:法郎|生丁|苏|先令|便士|英镑|美元|马克|卢布|里拉|元|文|万份|份|册|页|%|年|月|日))/g, '<b class="pe-num">$1</b>')
        .replace(/(《[^》]{1,40}》)/g, '<span class="pe-em">$1</span>');
}
const PER_SHORT = { daily: '日报', weekly: '周刊', biweekly: '半月刊', monthly: '月刊', irregular: '不定期' };

function eraPress(list) {
    const items = asArr(list).map(x => (typeof x === 'string' ? { name: x } : x || {}))
        .sort((a, b) => (Number(b.tier) || 0) - (Number(a.tier) || 0));
    if (!items.length) return '';
    return `<div class="pe-era-grid">${items.map(o => `<div class="pe-era-card">
        <div class="pe-era-name"><b>${h(o.nameZh || o.name || '')}</b>${o.nameZh && o.name ? ` <span class="pe-muted">${h(o.name)}</span>` : ''}</div>
        <div class="pe-era-chips">
          ${o.type ? `<span class="pe-chip pe-chip-layer">${h(PER_SHORT[o.type] || PERIODICITY[o.type] || o.type)}</span>` : ''}
          ${o.circle ? `<span class="pe-chip">${h(CIRCLES[o.circle] || o.circle)}</span>` : ''}
          ${o.tier ? `<span class="pe-chip pe-tier" title="影响力 ${h(o.tier)}/5">${'●'.repeat(Math.max(0, Math.min(5, Number(o.tier) || 0)))}<i>${'●'.repeat(5 - Math.max(0, Math.min(5, Number(o.tier) || 0)))}</i></span>` : ''}
        </div>
        ${o.politics ? `<div class="pe-era-line"><span class="pe-era-k">倾向</span>${emph(o.politics)}</div>` : ''}
        ${o.note ? `<div class="pe-era-note">${emph(o.note)}</div>` : ''}
      </div>`).join('')}</div>`;
}

function eraCritics(list) {
    const items = asArr(list).map(x => (typeof x === 'string' ? { name: x } : x || {}));
    if (!items.length) return '';
    return `<div class="pe-era-grid">${items.map(c => `<div class="pe-era-card">
        <div class="pe-era-name"><b>${h(c.nameZh || c.name || '')}</b>${c.nameZh && c.name ? ` <span class="pe-muted">${h(c.name)}</span>` : ''}</div>
        ${c.venue ? `<div class="pe-era-chips"><span class="pe-chip pe-chip-layer">${h(c.venue)}</span></div>` : ''}
        ${c.stance ? `<div class="pe-era-line"><span class="pe-era-k">立场</span>${emph(c.stance)}</div>` : ''}
        ${c.note ? `<div class="pe-era-note">${emph(c.note)}</div>` : ''}
      </div>`).join('')}</div>`;
}

function eraEvents(list) {
    const items = asArr(list).map(x => (typeof x === 'string' ? { event: x } : x || {}))
        .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
    if (!items.length) return '';
    return `<div class="pe-era-tl">${items.map(e => `<div class="pe-era-tl-row"><span class="pe-era-tl-date">${h(e.date || '—')}</span><span class="pe-era-tl-ev">${emph(e.event || asText(e))}</span></div>`).join('')}</div>`;
}

function eraSeason(f) {
    if (!f || typeof f !== 'object') return '';
    const vals = Array.from({ length: 12 }, (_, i) => Number(f[i + 1] ?? f[String(i + 1)] ?? 1));
    return `<div class="pe-era-season">${vals.map((v, i) => `<div class="pe-era-mon ${v < 0.8 ? 'low' : ''}" title="${i + 1} 月：报刊活跃度 ×${v}"><i style="height:${Math.round(Math.max(0.1, Math.min(1.3, v)) / 1.3 * 100)}%"></i><span>${i + 1}</span></div>`).join('')}</div>
      <div class="pe-muted">柱子越低，这个月报刊上的评论越少（例如八月的巴黎报界淡季）。</div>`;
}

function eraBlock(title, body, { open = true, count = null, cls = '' } = {}) {
    if (!body) return '';
    return `<details class="pe-era-sec ${cls}" ${open ? 'open' : ''}><summary>${title}${count != null ? ` <span class="pe-count pe-count-dim">${count}</span>` : ''}</summary>${body}</details>`;
}

function eraView(prof) {
    const bullets = arr => arr.length ? `<ul class="pe-era-ul">${arr.map(x => `<li>${emph(x)}</li>`).join('')}</ul>` : '';
    const chips = (arr, cls = '') => arr.length ? `<div class="pe-era-chips pe-era-chips-wrap">${arr.map(x => `<span class="pe-chip ${cls}">${h(asText(x))}</span>`).join('')}</div>` : '';
    const press = asArr(prof.pressLandscape), critics = asArr(prof.critics), events = asArr(prof.recentEvents);
    return `
      ${prof.summary ? `<div class="pe-era-summary">${emph(asText(prof.summary))}</div>` : ''}
      ${asArr(prof.uncertain).length ? `<div class="pe-callout pe-callout-warn"><div><b>需要你核对</b>${bullets(asArr(prof.uncertain).map(asText))}</div></div>` : ''}
      <div class="pe-era-two">
        ${prof.currency ? `<div class="pe-era-box"><div class="pe-era-boxt">货币与物价</div>${bullets(splitPoints(asText(prof.currency), true))}</div>` : ''}
        ${prof.styleNotes ? `<div class="pe-era-box"><div class="pe-era-boxt">报刊文体</div>${bullets(splitPoints(asText(prof.styleNotes)))}</div>` : ''}
      </div>
      ${eraBlock('报刊格局', eraPress(press), { count: press.length })}
      ${eraBlock('活跃评论家', eraCritics(critics), { count: critics.length })}
      ${eraBlock('近期大事', eraEvents(events), { count: events.length })}
      ${eraBlock('文学与思想潮流', chips(asArr(prof.movements), 'pe-chip-layer'))}
      ${eraBlock('时代用语', chips(asArr(prof.vocabulary)), { open: false })}
      ${eraBlock('此时尚不存在（写进去会穿帮）', chips(asArr(prof.forbiddenAnachronisms), 'pe-chip-no'), { cls: 'pe-era-no' })}
      ${eraBlock('报刊季节活跃度', eraSeason(prof.seasonFactors), { open: false })}`;
}

function era(st, s) {
    const prof = getEra();
    const year = st.era?.year || (st.currentDate ? yearOf(st.currentDate) : '');
    const titles = defaultWikiTitles(year, st.era?.country || '', s.wikiLangs).map(t => `${t.lang}:${t.title}`).join('\n');
    return `
    <section>
      <div class="pe-era-head">
        <div>
          <div class="pe-era-title">${h(prof?.year || year || '—')} 年代档案</div>
          <div class="pe-muted">${prof ? `截至 <b class="pe-num">${h(prof.asOf || prof.year)}</b> · ${h(prof.place || st.era?.place || '')}` : '尚未生成。生成后，写稿和注入都会按这个年代约束。'}</div>
          ${prof ? `<div class="pe-era-chips pe-era-chips-wrap" style="margin-top:4px">${(prof.sources || []).length ? prof.sources.map(x => `<span class="pe-chip" title="资料来源">${h(x)}</span>`).join('') : '<span class="pe-chip">仅凭模型知识</span>'}</div>` : ''}
        </div>
        <div class="pe-toolbar">
          <button class="pe-primary" data-act="era-build" ${s.wikiEnabled ? '' : 'disabled'}>${prof ? '重新检索并生成' : '检索维基百科并生成'}</button>
          <button data-act="era-build-nowiki">仅用模型知识生成</button>
          ${prof ? '<details class="pe-more-acts pe-inline-more"><summary>更多</summary><button data-act="era-propose">刊物与评论家加入待合并</button><button data-act="era-edit">编辑 JSON</button><button data-act="era-clear">清除</button></details>' : ''}
        </div>
      </div>
      ${editing?.kind === 'era' ? `<textarea id="pe-era-json" rows="16">${h(JSON.stringify(prof, null, 2))}</textarea><div class="pe-row"><button class="pe-primary" data-act="era-save-json">保存</button><button data-act="cancel-edit">取消</button></div>` : ''}
      ${prof && editing?.kind !== 'era' ? eraView(prof) : ''}
      <details class="pe-fold"><summary>检索的维基页面（每行 语言:标题，可改）</summary><textarea id="pe-wiki-titles" rows="5">${h(titles)}</textarea>
      <div class="pe-muted">同年份的页面会自动剪掉当前故事日期之后的月份和条目，避免剧透未来。</div></details>
    </section>
    <section>
      <h4>检索当前年代</h4>
      <div class="pe-row">
        <select id="pe-search-lang">${String(s.wikiLangs || 'fr,en,zh').split(/[,，\s]+/).filter(Boolean).map(l => `<option>${h(l)}</option>`).join('')}</select>
        <input id="pe-search-q" type="text" placeholder="例如：Le Temps 1890 / Journal des Débats / Kemmler" style="flex:1">
        <button data-act="wiki-search">搜索</button>
      </div>
      <ul class="pe-list">${searchResults.map((r, i) => `<li><b>${h(r.title)}</b> <small>${h(r.lang)}</small><br><small>${h(r.snippet)}</small>
        ${r.extract ? `<details open><summary>摘要</summary><div class="pe-text">${h(truncate(r.extract, 1500)).replace(/\n/g, '<br>')}</div></details>` : ''}
        <div class="pe-row"><button class="pe-mini" data-act="wiki-open" data-i="${i}">查看摘要</button><button class="pe-mini" data-act="wiki-note" data-i="${i}">加入年代笔记</button></div></li>`).join('')}</ul>
    </section>
    <section>
      <h4>年代笔记（${st.eraNotes.length}）</h4>
      <p><small>生成年代档案时会一并提供给模型。也可以手写你在别处查到的资料。</small></p>
      <ul class="pe-list">${st.eraNotes.map((n, i) => `<li><b>${h(n.title || '笔记')}</b>：${h(truncate(n.text, 300))} <button class="pe-mini" data-act="note-del" data-i="${i}">删除</button></li>`).join('')}</ul>
      <div class="pe-row"><input id="pe-note-title" type="text" placeholder="标题" style="width:8em"><input id="pe-note-text" type="text" placeholder="内容" style="flex:1"><button data-act="note-add">添加</button></div>
    </section>`;
}

const KIND_LABEL = { pennames: '笔名', outlets: '刊物', persons: '人物', works: '作品', reactions: '已发生的反响', readings: '阅读记录', rumors: '传闻', eraNotes: '年代笔记' };
const estCalls = () => materials.reduce((n, m) => n + chunkMaterial(m.text).length, 0);

function organizerBlock(st) {
    const calls = estCalls();
    const chars = materials.reduce((n, m) => n + m.text.length, 0);
    return `${st.pendingBundle ? bundlePreview(st) : ''}
    <section class="pe-drop" id="pe-org-drop">
      <h4>一键整理 <span class="pe-muted">把材料放进来，交给已连接的模型整理成人物、刊物、作品和已发生的反响</span></h4>
      <div class="pe-toolbar">
        <label class="menu_button pe-file pe-primary">添加文件<input type="file" id="pe-org-files" multiple accept=".txt,.md,.json,.jsonl,text/plain,application/json" hidden></label>
        <button data-act="org-chat">加入当前聊天记录</button>
        <input id="pe-org-last" type="number" min="0" placeholder="最近几楼（空=全部）" style="width:11em">
        <input id="pe-wb-name" type="text" placeholder="世界书名称" style="width:9em"><button data-act="wb-load">加入世界书</button>
      </div>
      <div class="pe-muted">可以直接拖进来，能识别这几类：</div>
      <ul class="pe-era-ul pe-muted">
        <li>聊天记录：.txt 文本，或酒馆导出的 .jsonl</li>
        <li>书信簿备份 .json：会同时读进书信簿联动</li>
        <li>整理包 .json：直接进入预览，不调用模型</li>
        <li>作品原文：文件名带日期的 .txt（如 长子-回声报1890-4-15.txt），会进入“作品”页的 txt 导入，应用时一并导入</li>
      </ul>
      <textarea id="pe-import-text" rows="4" placeholder="也可以把设定、笔记、某段剧情粘贴在这里，再点“加入材料”。"></textarea>
      <div class="pe-toolbar"><button data-act="org-paste">加入材料</button></div>
      ${materials.length ? `<div class="pe-org-list">${materials.map(m => `<div class="pe-card pe-card-slim"><div class="pe-card-main"><span class="pe-chip pe-chip-layer">${h(m.kind)}</span> ${h(m.label)} <span class="pe-muted">${m.text.length.toLocaleString()} 字 · ${chunkMaterial(m.text).length} 段</span></div>
          <div class="pe-card-actions pe-card-actions-row"><button class="pe-mini" data-act="org-del" data-id="${m.id}">移除</button></div></div>`).join('')}</div>
        <div class="pe-callout ${calls > 40 ? 'pe-callout-warn' : 'pe-callout-accent'}">共 ${chars.toLocaleString()} 字，约 <b>${calls}</b> 次模型调用。${calls > 40 ? '材料很长：用插件逐段整理会比较慢、耗费也多，可以考虑下面的“用外部 AI 整理”，长上下文的聊天 AI 一次就能读完。' : ''}
          ${orgAbort ? '<button data-act="org-stop">停止</button>' : `<button class="pe-primary" data-act="org-run">开始整理</button><button data-act="org-clear">清空材料</button>`}</div>` : ''}
      ${txtPlan.length ? `<div class="pe-muted">另有 ${txtPlan.length} 个作品原文 txt 已放进 <a class="pe-link" data-tab-go="works">作品页</a> 的导入列表。</div>` : ''}
    </section>

    <details class="pe-fold" ${st.pendingBundle ? '' : 'open'}><summary>用外部 AI 整理（适合很长的聊天记录）</summary>
      <ol class="pe-era-ul">
        <li>点“复制提示词”，发给 Claude、ChatGPT、Gemini 等长上下文的聊天 AI；</li>
        <li>把聊天记录、书信、设定发给它（可以分几次）；</li>
        <li>把它回复的 JSON 粘贴到下面点“读取”，或者存成 .json 文件拖进上面的整理区。分几次输出的可以多次读取，会自动合并。</li>
      </ol>
      <div class="pe-toolbar"><button class="pe-primary" data-act="bundle-prompt">复制提示词</button><button data-act="bundle-spec">下载格式说明</button></div>
      <textarea id="pe-bundle-text" rows="4" placeholder="把外部 AI 输出的 JSON 粘贴到这里"></textarea>
      <div class="pe-toolbar"><button data-act="bundle-read">读取</button></div>
    </details>`;
}

function bundlePreview(st) {
    const b = st.pendingBundle;
    const pv = previewBundle(st, b);
    const kinds = Object.keys(KIND_LABEL).filter(k => (pv.counts[k]?.new || 0) + (pv.counts[k]?.update || 0) > 0);
    return `
    <section class="pe-bundle">
      <h4>整理结果预览 <span class="pe-spacer"></span><button class="pe-primary" data-act="bundle-apply">应用</button><button data-act="bundle-download">下载整理包</button><button data-act="bundle-drop">丢弃</button></h4>
      <div class="pe-muted">确认后才会写进数据。按名字合并：已有的只补充和更新，不会删除你填过的内容；导入的反响记为“已发生”，直接入账。</div>
      ${b.storyDate ? `<div class="pe-callout">故事日期 <b class="pe-num">${h(b.storyDate)}</b>${b.place ? ` · ${h(b.place)}` : ''}
        <select id="pe-bundle-datemode"><option value="set">直接设为当前日期（之前的反响以整理包为准，不再推演）</option><option value="none">不改日期</option></select></div>` : ''}
      <div class="pe-stats pe-bundle-stats">${kinds.map(k => `<label class="pe-stat"><span><input type="checkbox" class="pe-bundle-kind" value="${k}" checked> ${KIND_LABEL[k]}</span>
        <b>${pv.counts[k].new + pv.counts[k].update}</b><span>${pv.counts[k].update ? `新建 ${pv.counts[k].new} · 更新 ${pv.counts[k].update}` : k === 'reactions' || k === 'readings' ? '记为已发生' : '新建'}</span></label>`).join('') || '<div class="pe-empty-sm">整理包是空的。</div>'}</div>
      ${pv.stale.length || st.persons.length ? `<div class="pe-callout ${pv.stale.length ? 'pe-callout-warn' : ''}"><div><label class="pe-check-inline"><input type="checkbox" id="pe-bundle-sync" checked> <b>以这份整理包为准</b>（导入新版整理包时用）</label>
        <div class="pe-muted">勾选：人物的关注、欣赏、反感、供稿与常读刊物、熟人关系，刊物的刊期和倾向，作品的题材，都换成新版的写法（不勾选则只补充、不替换，旧标签和旧关系会留着）；以前导入的阅读记录按新版重建${pv.stale.length ? `；并删除以前导入、但新版已经没有的 ${pv.stale.length} 条已发生反响` : ''}。你手动录入的反响不受影响。</div>
        ${pv.stale.length ? `<ul class="pe-era-ul">${pv.stale.slice(0, 20).map(x => `<li>${h(x)}</li>`).join('')}</ul>` : ''}</div></div>` : ''}
      ${pv.warnings.length ? `<div class="pe-callout pe-callout-warn"><div><b>注意（${pv.warnings.length}）</b><ul class="pe-era-ul">${pv.warnings.slice(0, 30).map(w => `<li>${h(w)}</li>`).join('')}</ul></div></div>` : ''}
      ${kinds.map(k => `<details class="pe-era-sec"><summary>${KIND_LABEL[k]} <span class="pe-count pe-count-dim">${pv.items[k]?.length ?? pv.counts[k].new}</span></summary>
        <div class="pe-era-chips pe-era-chips-wrap">${(pv.items[k] || (b[k] || []).map(x => ({ name: x.text || x.title, exists: false }))).map(x => `<span class="pe-chip ${x.exists ? '' : 'pe-chip-layer'}" title="${x.exists ? '已有，将更新' : '新建'}">${h(truncate(x.name || '', 50))}</span>`).join('')}</div></details>`).join('')}
      <div class="pe-toolbar"><button class="pe-primary" data-act="bundle-apply">应用整理结果${txtPlan.length ? `（并导入 ${txtPlan.filter(r => r.action !== 'skip').length} 个作品原文）` : ''}</button></div>
    </section>`;
}

async function addOrgFiles(files) {
    const st = getState();
    if (!st) return;
    setBusy('读取文件');
    const notes = [];
    try {
        for (const f of files) {
            const text = await readTextFile(f);
            if (/\.jsonl$/i.test(f.name)) {
                const rows = parseJsonl(text);
                materials.push({ id: uid(), label: f.name, kind: '聊天记录', text: chatToText(rows) });
                continue;
            }
            if (/\.json$/i.test(f.name)) {
                let obj;
                try { obj = JSON.parse(text); } catch { try { obj = extractJSON(text); } catch { notes.push(`${f.name}：不是合法的 JSON`); continue; } }
                if (obj?.kind === 'epistolary-backup' || obj?.archive?.letters) {
                    const info = loadBackup(obj, f.name);
                    st.epiScope = '';
                    const letters = Object.values(obj.archive.letters || {}).filter(l => l.body && (effectiveScope(st) === '*' || l.scope === effectiveScope(st)));
                    const txt = letters.map(l => letterText(l.id)).join('\n\n');
                    materials.push({ id: uid(), label: `${f.name}（书信簿 ${info.letters} 封信、${info.notes} 篇便条/文章）`, kind: '书信', text: txt });
                    notes.push('书信簿备份也已读进“书信簿联动”');
                    continue;
                }
                if (looksLikeBundle(obj)) {
                    st.pendingBundle = mergeBundles(st.pendingBundle, normalizeBundle(obj));
                    notes.push(`${f.name}：整理包已读入预览`);
                    continue;
                }
                notes.push(`${f.name}：认不出这个 JSON（既不是整理包，也不是书信簿备份）`);
                continue;
            }
            const pf = parseFileName(f.name);
            if (pf.date) {
                txtPlan = txtPlan.filter(r => r.fileName !== f.name);
                txtPlan.push({ ...planImport(st, f.name, text), text });
                notes.push(`${f.name}：按作品原文处理`);
                continue;
            }
            materials.push({ id: uid(), label: f.name, kind: /聊天|chat|记录/i.test(f.name) ? '聊天记录' : '文本', text });
        }
    } finally { setBusy(''); }
    commit(notes.length ? notes.join('；') : '');
}

function copyText(text, label) {
    const ok = () => toast('success', `已复制${label}`);
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(ok, () => showText(label, text));
    else showText(label, text);
}

function importTab(st) {
    const order = { penname: 0, outlet: 1, person: 2, work: 3, reaction: 4 };
    const kindName = { penname: '笔名', outlet: '刊物', person: '人物', work: '作品', reaction: '已发生反响' };
    const pend = st.pendingMerge.map((p, i) => ({ p, i })).sort((a, b) => order[a.p.kind] - order[b.p.kind]);
    const epi = epistolaryAvailable();
    const src = archiveSource();
    const binfo = backupInfo();
    const hints = (st.epiHints || []).filter(x => !x.handled);
    const scope = epi ? effectiveScope(st) : '';
    const arts = epi ? listArticles(st) : [];
    const workOpts = sel => `<option value="">（选择作品）</option>${st.works.map(w => `<option value="${h(w.id)}" ${w.id === sel ? 'selected' : ''}>${h(w.title)}</option>`).join('')}`;
    const dirName = { from_user: '主角寄出', to_user: '寄给主角', third_party: '第三方之间' };
    return organizerBlock(st) + `
    <section>
      <h4>书信簿（st-epistolary）联动</h4>
      <p><small>只读取，不会改动书信簿。信里提到作品的地方只作为<b>辅助线索</b>，默认不算已发生的反响，由你逐条决定。</small></p>
      <div class="pe-row">
        <span>档案来源：${src === 'backup' ? `备份文件 <b>${h(binfo.fileName || '')}</b>` : src === 'live' ? '书信簿插件（实时）' : '无'}</span>
        <label class="menu_button pe-file">读取书信簿备份（.json）<input type="file" id="pe-epi-file" accept=".json,application/json" hidden></label>
        ${src === 'backup' ? '<button class="pe-mini" data-act="epi-unload">卸下备份</button>' : ''}
      </div>
      ${binfo ? `<p><small>备份：信 ${binfo.letters} 封，便条/文章 ${binfo.notes} 篇，人物档案 ${binfo.people} 人；日期 ${h(binfo.from || '?')} – ${h(binfo.to || '?')}${binfo.exportedAt ? `；导出于 ${h(binfo.exportedAt.slice(0, 10))}` : ''}。备份只放在内存里，刷新页面后要重新读取（已处理的线索和已导入的原文会保留）。</small></p>` : ''}
      ${binfo && binfo.scopes.length > 1 ? `<div class="pe-row"><span>角色卡范围：</span><select id="pe-epi-scope">
          <option value="*" ${scope === '*' ? 'selected' : ''}>全部</option>
          ${binfo.scopes.map(x => `<option value="${h(x.key)}" ${x.key === scope ? 'selected' : ''}>${h(x.name)}（${x.count}）</option>`).join('')}</select></div>` : ''}
      ${epi ? `<div class="pe-row"><button class="pe-primary" data-act="epi-scan">扫描信件中的作品线索</button><button data-act="epi-people">把书信簿人物和通信对象加入待合并</button>
        <small>书信簿剧情日期：${h(epistolaryStoryDate() || '未设定')}</small></div>
        <p><small>只扫描日期不晚于当前故事日期（${h(st.currentDate || '未设定')}）的信。日期取写信日期，没有就取书信簿事件里的寄出日期；主角寄出的信按对方读到的日期算。</small></p>
        <ul class="pe-list">${hints.map(x => `<li><b>${h(x.date || '日期不详')}</b> ${h(x.code)} ${h(x.author)} → ${h((x.recipients || []).join('、') || '—')} <small class="pe-tag">${dirName[x.direction] || ''}</small>
          · ${x.workTitle ? bt(x.workTitle) : '笔名 ' + h(x.penname)}
          <div class="pe-evi">${h(x.excerpt)}</div><small>${h(x.suggestion)}${x.personId || !x.personName ? '' : '（此人还不在人物列表里）'}</small>
          <div class="pe-row">
            ${x.workId && x.personId && /^\d{4}-\d{2}-\d{2}$/.test(x.date) ? `<button class="pe-mini" data-act="epi-hint-read" data-id="${h(x.id)}">${x.direction === 'from_user' ? '记为对方经书信得知并读过' : '记为此人已读过'}</button>` : ''}
            ${x.workId && x.personId && x.direction === 'to_user' && /^\d{4}-\d{2}-\d{2}$/.test(x.date) ? `<button class="pe-mini" data-act="epi-hint-letter" data-id="${h(x.id)}">记为一封已发生的私信反响</button>` : ''}
            <button class="pe-mini" data-act="epi-hint-extract" data-id="${h(x.id)}" title="把整封信放进下面的抽取文本框，例如剪报、长篇评论信">送去抽取</button>
            <button class="pe-mini" data-act="epi-hint-ignore" data-id="${h(x.id)}">忽略</button>
          </div></li>`).join('') || '<li>暂无线索。</li>'}</ul>` : ''}
    </section>
    ${arts.length ? `<section>
      <h4>书信簿里的文章稿（${arts.length} 篇）</h4>
      <p><small>放在“文章”文件夹里的稿子。可以导入为作品原文，用来生成证据卡；同一作品分了几篇的（上半/下半、各回连载），按顺序“追加”即可。已有原文的作品选“设为原文”会覆盖。</small></p>
      <ul class="pe-list">${arts.map(a => {
          const w = byId(st.works, a.matchWorkId);
          const imported = st.works.some(x => (x.sourceFrom || []).includes(a.id));
          return `<li><b>${h(a.code || a.id)}</b> <small>${h(a.date || '日期不详')} · ${a.length} 字 · ${a.status === 'sent' ? '已发出' : '未发出'}</small>${imported ? ' <small class="pe-tag">已导入</small>' : ''}
          <div class="pe-evi">${h(a.head)}</div>
          <div class="pe-row"><select class="pe-art-work" data-id="${h(a.id)}">${workOpts(w?.id || '')}</select>
            <button class="pe-mini" data-act="art-set" data-id="${h(a.id)}">设为原文</button>
            <button class="pe-mini" data-act="art-append" data-id="${h(a.id)}">追加到原文</button>
            <button class="pe-mini" data-act="art-new" data-id="${h(a.id)}">新建作品</button></div></li>`;
      }).join('')}</ul>
    </section>` : ''}
    ${pend.length ? `<section>
      <h4>待合并（${pend.length}）</h4>
      ${pend.length ? `<div class="pe-row"><button class="pe-primary" data-act="merge-selected">合并选中</button><button data-act="merge-selall">全选</button><button data-act="merge-clear">清空列表</button></div>
        <small>会按 笔名 → 刊物 → 人物 → 作品 → 已发生反响 的顺序合并，这样人物的供稿刊物、作品的署名能对上。</small>` : ''}
      <ul class="pe-list">${pend.map(({ p, i }) => `<li><label><input type="checkbox" class="pe-merge-cb" value="${i}">
        <span class="pe-tag">${kindName[p.kind] || p.kind}</span> <b>${h(p.data.name || p.data.title || `${p.data.date || ''} ${p.data.person || ''}`)}</b></label>
        <small>${h(truncate(JSON.stringify(p.data), 220))}</small>
        ${p.evidence ? `<div class="pe-evi">依据：${h(p.evidence)}</div>` : '<div class="pe-evi pe-warn">无原文依据</div>'}
        <small>来源：${h(p.source || '')}</small></li>`).join('')}</ul>
    </section>` : ''}`;
}

const SETTINGS_SPEC = [
    { key: 'enabled', label: '启用', type: 'checkbox' },
    { key: 'autoDetectDate', label: '自动从消息识别故事日期', type: 'checkbox' },
    { key: 'autoAdvance', label: '识别到新日期后自动推演候选', type: 'checkbox', hint: '推演本身不调用模型，不耗 token' },
    { key: 'autoApprove', label: '自动通过', type: 'select', options: { minor: '次要事件自动通过（转载提及、读者来信、短讯、书讯、虚构人物私信）', none: '全部手动审核' }, hint: '正式书评、论战、真实人物私信始终需要你确认' },
    { key: 'epiSyncDate', label: '书信簿推算出更晚的剧情日期时一并采用', type: 'checkbox' },
    { key: 'maxJumpDays', label: '单次最多前进天数', type: 'number', hint: '超过此跨度的日期视为回忆或引述，忽略' },
    { key: 'headChars', label: '消息开头多少字内的日期优先', type: 'number' },
    { key: 'intensity', label: '公开发表意愿（0–1）', type: 'number', step: 0.05, hint: '默认 0.5。只影响“读了、有看法之后愿不愿意公开写”，接触和阅读不受影响' },
    { key: 'rumorHalfLife', label: '传闻半衰期（天）', type: 'number' },
    { key: 'injectEnabled', label: '向主对话注入报刊现状', type: 'checkbox' },
    { key: 'injectPosition', label: '注入位置', type: 'select', options: { 0: '系统提示词内', 1: '聊天内（按深度）', 2: '最前面' }, numeric: true },
    { key: 'injectDepth', label: '注入深度', type: 'number' },
    { key: 'injectMaxItems', label: '注入最近几条反响', type: 'number' },
    { key: 'injectEraNotes', label: '注入时附带时代约束', type: 'checkbox' },
    { key: 'apiMode', label: '写稿/检索用的模型', type: 'select', options: { st: '酒馆当前连接', custom: '独立 OpenAI 兼容 API' } },
    { key: 'apiUrl', label: '独立 API 地址', placeholder: 'https://…/v1' },
    { key: 'apiKey', label: '独立 API 密钥', type: 'password' },
    { key: 'apiModel', label: '模型名' },
    { key: 'temperature', label: '温度', type: 'number', step: 0.05 },
    { key: 'maxTokens', label: '写稿最大输出', type: 'number' },
    { key: 'realPersonPolicy', label: '真实人物', type: 'select', options: { stance: '只写立场摘要（推荐）', full: '允许拟写全文' } },
    { key: 'outputLanguage', label: '写稿语言' },
    { key: 'wikiEnabled', label: '允许检索维基百科', type: 'checkbox' },
    { key: 'wikiLangs', label: '检索语言（逗号分隔）', placeholder: 'fr,en,zh' },
];

function settings(st, s) {
    const lm = s.layerMult || {};
    return `
    <section>
      <h4>设置（全局）</h4>
      <div id="pe-settings">${formHtml(SETTINGS_SPEC, s)}</div>
      <h5>各层级倍率（公开发表与私信的意愿）</h5>
      <div class="pe-form" id="pe-layermult">${['review', 'notice', 'echo', 'polemic', 'private_letter'].map(k => `<div class="pe-field"><label>${LAYERS[k].label}</label><input type="number" step="0.1" data-lm="${k}" value="${h(lm[k] ?? 1)}"></div>`).join('')}</div>
      <div class="pe-row"><button class="pe-primary" data-act="settings-save">保存设置</button><button data-act="api-test">测试模型连接</button></div>
    </section>
    <section>
      <h4>本聊天的数据</h4>
      <div class="pe-row">
        <button data-act="state-export">导出 JSON</button>
        <label class="menu_button pe-file" title="只用于恢复本插件导出的存档；整理包请到“导入与整理”页">恢复存档 JSON<input type="file" id="pe-import-file" accept=".json" hidden></label>
        <button data-act="state-reset">清空本聊天数据</button>
      </div>
      <small>数据随聊天文件保存。推演随机种子：${h(st.seed)}（同一存档结果可复现）。</small>
    </section>`;
}

// ———————————— 交互 ————————————

function onChange(e) {
    const t = e.target;
    if (t.id === 'pe-ledger-filter') { ledgerFilter = t.value; refresh(); }
    if (t.id === 'pe-bf-by') { bfForm.by = t.value; bfForm.size = { floors: 100, chars: 30000, days: 14 }[t.value]; bfForm.mode = document.getElementById('pe-bf-mode')?.value || bfForm.mode; refresh(); return; }
    if (t.id === 'pe-txt-files' && t.files?.length) { loadTxtFiles([...t.files]); t.value = ''; return; }
    if (t.id === 'pe-org-files' && t.files?.length) { addOrgFiles([...t.files]); t.value = ''; return; }
    if (t.id === 'pe-txt-overwrite') { txtOverwrite = t.checked; return; }
    if (t.dataset?.txt != null) { syncTxtField(t); return; }
    if (t.id === 'pe-epi-scope') { const st = getState(); if (st) { st.epiScope = t.value; commit(); } }
    if (t.id === 'pe-epi-file' && t.files?.[0]) {
        const f = t.files[0];
        setBusy('读取书信簿备份');
        const r = new FileReader();
        r.onload = () => {
            setBusy('');
            try {
                const info = loadBackup(JSON.parse(r.result), f.name);
                const st = getState();
                if (st) st.epiScope = '';
                commit(`已读取备份：${info.letters} 封信、${info.notes} 篇便条/文章`);
            } catch (err) { toast('error', '读取失败：' + err.message); }
        };
        r.onerror = () => { setBusy(''); toast('error', '读取文件失败'); };
        r.readAsText(f);
    }
    if (t.id === 'pe-import-file' && t.files?.[0]) {
        const r = new FileReader();
        r.onload = () => {
            try {
                const obj = JSON.parse(r.result);
                if (looksLikeBundleData(obj)) {
                    const st = getState();
                    st.pendingBundle = mergeBundles(st.pendingBundle, normalizeBundle(obj));
                    tab = 'import';
                    commit('这是整理包，已放进“导入与整理”的预览，确认后再应用（不会覆盖现有数据）');
                    return;
                }
                if (!confirm('导入会覆盖本聊天的报刊回声数据，确定？')) return;
                replaceState(obj);
                commit('已导入');
            } catch (err) { toast('error', '导入失败：' + err.message); }
        };
        r.readAsText(t.files[0]);
    }
}

async function onClick(e) {
    const btn = e.target.closest('button, [data-tab], [data-tab-go]');
    if (btn?.tagName === 'SUMMARY') return;
    if (!btn) return;
    const go = btn.dataset.tab || btn.dataset.tabGo;
    if (go) { tab = go; editing = null; simView = null; refresh(); const b = document.getElementById('pe-body'); if (b) b.scrollTop = 0; return; }
    const act = btn.dataset.act;
    if (!act) return;
    const st = getState();
    const s = getSettings();
    if (!st && act !== 'close') return;
    const ev = btn.dataset.id ? st?.ledger.find(x => x.id === btn.dataset.id) : null;
    const $ = sel => document.querySelector(sel);
    try {
        switch (act) {
        case 'close': togglePanel(false); break;

        // 一键整理 / 整理包
        case 'org-chat': {
            const c = globalThis.SillyTavern?.getContext?.();
            const n = parseInt(document.getElementById('pe-org-last')?.value, 10);
            const msgs = (c?.chat || []).slice(n > 0 ? -n : 0);
            if (!msgs.length) return toast('warning', '当前聊天是空的');
            materials.push({ id: uid(), label: `当前聊天${n > 0 ? `最近 ${n} 楼` : `全部 ${msgs.length} 楼`}`, kind: '聊天记录', text: chatToText(msgs) });
            refresh(); break;
        }
        case 'org-paste': {
            const t = $('#pe-import-text')?.value.trim();
            if (!t) return toast('warning', '文本框是空的');
            materials.push({ id: uid(), label: `粘贴的文本（${truncate(t.replace(/\s+/g, ' '), 16)}）`, kind: '文本', text: t });
            refresh(); break;
        }
        case 'org-del': materials = materials.filter(m => m.id !== btn.dataset.id); refresh(); break;
        case 'org-clear': materials = []; refresh(); break;
        case 'org-stop': orgAbort?.abort(); toast('info', '当前这一段完成后停止'); break;
        case 'org-run': {
            if (!materials.length) break;
            orgAbort = new AbortController();
            refresh();
            try {
                const b = await organize(st, materials, s, m => setBusy(m), orgAbort.signal);
                st.pendingBundle = mergeBundles(st.pendingBundle, b);
                if (!orgAbort.signal.aborted) materials = [];
                logLine(st, `一键整理：${['persons', 'works', 'reactions'].map(k => `${KIND_LABEL[k]} ${(b[k] || []).length}`).join('，')}`);
            } finally { orgAbort = null; setBusy(''); }
            commit('整理完成，请查看预览');
            break;
        }
        case 'bundle-prompt': copyText(buildExternalPrompt(st), '提示词'); break;
        case 'bundle-spec': download('报刊回声整理包格式.md', `# 报刊回声 · 整理包格式\n\n\`\`\`json\n${FORMAT_SPEC}\n\`\`\`\n\n${FORMAT_RULES}\n\n---\n\n## 给外部 AI 的提示词\n\n${buildExternalPrompt(st)}\n`); break;
        case 'bundle-read': {
            const t = $('#pe-bundle-text')?.value.trim();
            if (!t) return toast('warning', '请先粘贴 JSON');
            let obj;
            try { obj = extractJSON(t); } catch (err) { return toast('error', '读不出 JSON：' + err.message); }
            if (!looksLikeBundle(obj)) return toast('warning', '这不像整理包（至少要有 works、persons、outlets、reactions 中的两项）');
            st.pendingBundle = mergeBundles(st.pendingBundle, normalizeBundle(obj));
            commit('已读入预览');
            break;
        }
        case 'bundle-download': download(`报刊回声整理包_${st.pendingBundle?.storyDate || ''}.json`, JSON.stringify(st.pendingBundle, null, 2)); break;
        case 'bundle-drop': if (confirm('丢弃这份整理结果？')) { st.pendingBundle = null; commit(); } break;
        case 'bundle-apply': {
            const b = st.pendingBundle;
            if (!b) break;
            const kinds = [...document.querySelectorAll('.pe-bundle-kind')].filter(c => c.checked).map(c => c.value);
            const dateMode = $('#pe-bundle-datemode')?.value || 'set';
            const rep = applyBundle(st, b, { kinds, dateMode, settings: s, era: getEra(), sync: !!$('#pe-bundle-sync')?.checked });
            st.pendingBundle = null;
            syncEraYear(st);
            if (txtPlan.length) {
                // 整理包可能刚建好作品：重新匹配一次，免得重复新建
                txtPlan = txtPlan.map(r => (r.action === 'new' ? { ...r, ...pickUpdate(st, r) } : r));
                commitTxt(st);
            }
            logLine(st, `应用整理包：${kinds.map(k => KIND_LABEL[k]).join('、')}；自动新建 ${rep.created.length}，跳过 ${rep.skipped.length}`);
            if (!st.backfilledAt) toast('info', '整理结果已导入。建议先到“人物与刊物”归类标签，再到“概览”点“回溯推演”，补上从首次发表到现在的文学界变化。');
            commit(`已应用整理结果${rep.created.length ? `；自动新建 ${rep.created.length} 项资料空白的条目，请到“人物与刊物”补全` : ''}${rep.skipped.length ? `；跳过 ${rep.skipped.length} 条` : ''}`);
            if (rep.skipped.length || rep.created.length || rep.removed.length) showText('应用报告', [...rep.lines, '', '自动新建：', ...rep.created, '', '跳过：', ...rep.skipped, '', '按新版删除：', ...rep.removed].join('\n'));
            break;
        }

        // 预演
        case 'sim-work': simView = { kind: 'work', workId: btn.dataset.id, runs: 40 }; simView.result = simulate(st, s, getEra(), { workId: simView.workId, runs: 40 }); refresh(); $('#pe-body').scrollTop = 0; break;
        case 'sim-work-run': {
            const outletId = $('#pe-sim-outlet').value;
            const pubDate = normalizeISO($('#pe-sim-date').value);
            if (!pubDate) return toast('warning', '日期格式应为 YYYY-MM-DD');
            const runs = +$('#pe-sim-runs').value || 40;
            const until = normalizeISO($('#pe-sim-until').value) || null;
            setBusy('推演中');
            try { Object.assign(simView, { outletId, pubDate, runs, until, result: simulate(st, s, getEra(), { workId: simView.workId, outletId, pubDate, runs, until }) }); } finally { setBusy(''); }
            refresh(); break;
        }
        case 'sim-person': simView = { kind: 'person', personId: btn.dataset.id, runs: 40 }; refresh(); $('#pe-body').scrollTop = 0; break;
        case 'sim-person-pick': simView.whatIf = { workId: btn.dataset.id, date: $('#pe-sim-pdate')?.value || st.currentDate }; simView.result = null; refresh(); document.getElementById('pe-sim-pwork')?.scrollIntoView?.({ block: 'center' }); break;
        case 'sim-person-odds': {
            setBusy('估算中');
            try {
                simView.odds = {};
                for (const w of st.works.filter(x => x.pubDate)) {
                    const r = simulate(st, s, getEra(), { workId: w.id, personId: simView.personId, runs: 30 }).rows[0];
                    if (r) simView.odds[w.id] = r;
                }
            } finally { setBusy(''); }
            refresh(); break;
        }
        case 'sim-person-run': {
            const date = normalizeISO($('#pe-sim-pdate').value);
            const workId = $('#pe-sim-pwork').value;
            if (!date) return toast('warning', '日期格式应为 YYYY-MM-DD');
            const runs = +$('#pe-sim-runs').value || 40;
            simView.whatIf = { workId, date };
            simView.runs = runs;
            setBusy('推演中');
            try { simView.result = simulate(st, s, getEra(), { workId, personId: simView.personId, readDate: date, runs }); } finally { setBusy(''); }
            refresh(); break;
        }
        case 'sim-person-commit': {
            const wi = simView.whatIf;
            const rec = recordManualReading(st, s, getEra(), { workId: wi.workId, personId: simView.personId, date: wi.date, read: 'finished', note: '在预演中确认' });
            simView.result = null;
            commit(`已记下；按规则推演出 ${rec.eventIds.length} 条后续${rec.seek ? `，他约 ${rec.seek} 起会去找作者的其他作品` : ''}`);
            break;
        }
        case 'sim-close': simView = null; refresh(); break;
        case 'concepts-build':
        case 'concepts-rebuild': {
            setBusy('归类标签');
            try { await buildConcepts(st, s, { full: act === 'concepts-rebuild', onProgress: setBusy }); } finally { setBusy(''); }
            logLine(st, `标签归类：${st.concepts.groups.length} 组`);
            commit(`已归类：${st.concepts.groups.length} 个概念组。之前推演出、尚未入账的内容不会自动改变；需要的话在概览里重新“回溯推演”。`);
            break;
        }
        case 'bf-begin': {
            bfForm = { mode: $('#pe-bf-mode').value, by: $('#pe-bf-by').value, size: Math.max(1, +$('#pe-bf-size').value || 100) };
            const segs = planSegments(st, bfForm.by, bfForm.size);
            if (!segs.length) return toast('warning', '没有可以推演的时间段');
            if (!confirm(`将分 ${segs.length} 段，从 ${st.works.map(w => w.pubDate).filter(Boolean).sort()[0]} 推到 ${st.currentDate}。之前推演出但未入账的内容会清掉重来。开始？`)) break;
            const b = backfillBegin(st, s, getEra(), { mode: bfForm.mode });
            st.backfillRun.segments = segs;
            logLine(st, `开始分段回溯（${bfForm.mode === 'hidden' ? '只补看不见的部分' : '全部'}，${segs.length} 段）：人物 ${b.persons} 位、作品 ${b.works} 部`);
            commit(`已开始：共 ${segs.length} 段。点“推演下一段”逐段推进`);
            break;
        }
        case 'bf-next':
        case 'bf-all': {
            const run = st.backfillRun;
            if (!run) break;
            setBusy('回溯推演');
            try {
                for (const g of run.segments) {
                    if (g.result) continue;
                    const r = backfillStep(st, s, getEra(), g.endDate);
                    g.result = { ...r, reads: (r.reads || []).slice(0, 60) };
                    if (act === 'bf-next') break;
                }
            } finally { setBusy(''); }
            if (run.segments.every(g => g.result)) {
                const r = backfillEnd(st);
                st.backfilledAt = { at: new Date().toISOString(), mode: r.mode, to: r.to };
                logLine(st, `回溯完成 ${r.from} → ${r.to}：读完 ${r.finished}、读了部分 ${r.skimmed}、接触未读 ${r.ignored}；回溯候选 ${r.candidates}，之后的排期 ${r.scheduled}`);
                commit(`回溯完成：${r.finished + r.skimmed} 人次读过作品${r.candidates ? `，${r.candidates} 条回溯反响待审核` : ''}`);
            } else commit();
            break;
        }
        case 'bf-finish': {
            const r = backfillEnd(st);
            if (r) { st.backfilledAt = { at: new Date().toISOString(), mode: r.mode, to: r.to }; logLine(st, `回溯完成 ${r.from} → ${r.to}`); }
            commit('回溯完成');
            break;
        }
        case 'bf-cancel': {
            if (!confirm('放弃这次回溯？已推出的部分会在重新开始时清掉。')) break;
            const run = st.backfillRun;
            if (run) { st.rumors = run.savedRumors; st.currentDate = run.target; for (const r of st.receptions) delete r.pendingRerun; st.backfillRun = null; }
            commit('已放弃。可以重新设定分段再开始');
            break;
        }
        case 'backfill': {
            const mode = btn.dataset.mode || 'hidden';
            if (!confirm(mode === 'hidden'
                ? '从首次发表起回溯推演到当前日期：已导入的记录视为当时的全部公开报道和来信，只补阅读、私下看法和之后的后续反响。之前推演出但未入账的内容会重新生成。继续？'
                : '从首次发表起回溯推演到当前日期，公开报道和私信也补，全部进入待审核。之前推演出但未入账的内容会重新生成。继续？')) break;
            setBusy('回溯推演');
            let r;
            try { r = backfill(st, s, getEra(), { mode }); } finally { setBusy(''); }
            st.backfilledAt = { at: new Date().toISOString(), mode, to: r.to };
            logLine(st, `回溯推演（${mode === 'hidden' ? '只补看不见的部分' : '全部'}）${r.from} → ${r.to}：读完 ${r.finished}、读了部分 ${r.skimmed}、接触未读 ${r.ignored}；回溯候选 ${r.candidates}，之后的排期 ${r.scheduled}`);
            commit(`回溯完成：${r.finished + r.skimmed} 人次读过作品，${r.remarks} 人次私下谈起${r.candidates ? `，${r.candidates} 条回溯反响待审核` : ''}${r.scheduled ? `，${r.scheduled} 条在 ${r.to} 之后陆续出现` : ''}`);
            break;
        }
        case 'txt-commit': commitTxt(st); break;
        case 'txt-clear': txtPlan = []; refresh(); break;
        case 'repair-bundle-state': {
            const raw = JSON.parse(JSON.stringify(st));
            const nb = normalizeBundle(raw);
            if (normalizeISO(raw.currentDate || '') && (!nb.storyDate || cmp(raw.currentDate, nb.storyDate) > 0)) nb.storyDate = raw.currentDate;
            const fresh = resetState();
            fresh.pendingBundle = nb;
            if (raw.seed) fresh.seed = raw.seed;
            tab = 'import';
            logLine(fresh, '修复：把误当作存档导入的整理包转回整理包预览');
            commit('已修复：请在预览里确认后点“应用”');
            break;
        }
        case 'win-reset': { const p = document.getElementById('pe-panel'); getSettings().winRect = null; saveSettings(); applyRect(p, null); break; }

        // 日期
        case 'date-set': {
            const d = normalizeISO($('#pe-date').value);
            if (!d) return toast('warning', '日期格式应为 YYYY-MM-DD');
            st.currentDate = d;
            syncEraYear(st);
            logLine(st, `手动设定日期为 ${d}（未推演）`);
            commit();
            break;
        }
        case 'date-advance': {
            const d = normalizeISO($('#pe-date').value);
            if (!d) return toast('warning', '日期格式应为 YYYY-MM-DD');
            doAdvance(st, s, d);
            break;
        }
        case 'advance-detected': { const d = st.detectedDate; st.detectedDate = null; doAdvance(st, s, d); break; }
        case 'date-detect': app?.detectFromChat?.(true); break;
        case 'clear-wd': st.weekdayWarning = null; commit(); break;

        // 地点
        case 'place-save': st.era.place = $('#pe-place').value.trim(); syncEraYear(st); commit('已保存'); break;
        case 'place-guess': {
            const c = globalThis.SillyTavern.getContext();
            const text = (c.chat || []).slice(-30).map(m => m.mes).join('\n');
            const g = guessPlace(text);
            if (!g) return toast('info', '没能从最近的消息里猜出地点，请手动填写');
            st.era.place = g.label; st.era.country = g.country; st.era.lang = g.lang;
            syncEraYear(st);
            commit(`猜测地点：${g.label}`);
            break;
        }

        // 传闻
        case 'rumor-add': {
            const t = $('#pe-rumor').value.trim();
            if (!t) return;
            st.rumors.push({ id: 'rm_' + Date.now(), kind: 'custom', text: t, strength: 0.6, lastDate: st.currentDate, pinned: false });
            commit();
            break;
        }
        case 'rumor-pin': { const r = st.rumors.find(x => x.id === btn.dataset.id); if (r) r.pinned = !r.pinned; commit(); break; }
        case 'rumor-del': st.rumors = st.rumors.filter(x => x.id !== btn.dataset.id); commit(); break;

        // 审核
        case 'approve': setStatus(st, ev, 'approved'); logLine(st, `批准：${ev.date} ${LAYERS[ev.layer]?.label}`); commit(); break;
        case 'approve-write': setStatus(st, ev, 'approved'); commit(); await doWrite(st, s, ev); break;
        case 'reject': setStatus(st, ev, 'rejected'); commit(); break;
        case 'approve-all': for (const x of st.ledger.filter(y => y.status === 'candidate')) setStatus(st, x, 'approved'); commit('已全部批准'); break;
        case 'reject-all': if (confirm('驳回全部候选？')) { for (const x of st.ledger.filter(y => y.status === 'candidate')) setStatus(st, x, 'rejected'); commit(); } break;
        case 'unapprove': setStatus(st, ev, 'candidate'); commit(); break;
        case 'ev-del': if (confirm('删除这条记录？')) { setStatus(st, ev, 'rejected'); st.ledger = st.ledger.filter(x => x.id !== ev.id); commit(); } break;
        case 'ev-date': {
            const d = normalizeISO(prompt('新日期（YYYY-MM-DD）', ev.date) || '');
            if (!d) return;
            const outlet = byId(st.outlets, ev.outletId);
            if (outlet && outlet.periodicity !== 'daily' && !columnSlots(outlet, d, d).length) {
                if (!confirm(`《${outlet.name}》按设定在 ${d}（${weekdayZh(d)}）不出刊。仍要改？`)) return;
            }
            ev.date = d; commit(); break;
        }
        case 'ev-pol': {
            const v = prompt('褒贬：1 肯定，0 褒贬参半，-1 批评', String(ev.polarity));
            if (v === null) return;
            const was = ev.status;
            if (was === 'approved') setStatus(st, ev, 'candidate');
            ev.polarity = Math.max(-1, Math.min(1, Math.round(Number(v) || 0)));
            if (was === 'approved') setStatus(st, ev, 'approved');
            commit(); break;
        }
        case 'ev-note': { const v = prompt('给写稿模型的补充要求（例如：重点批评第二篇；提到塞弗里娜的文章）', ev.note || ''); if (v !== null) { ev.note = v; commit(); } break; }
        case 'ev-summary': {
            const v = prompt('内容概要（会注入主对话）', ev.text?.summary || '');
            if (v === null) return;
            ev.text = { ...(ev.text || { title: '', body: '', byline: '', section: '' }), summary: v };
            commit(); break;
        }
        case 'ev-reply': {
            const pid = prompt(`谁来回应？输入人物名：\n${st.persons.map(p => p.name).join('、')}`);
            if (!pid) return;
            const person = st.persons.find(p => p.name.includes(pid));
            if (!person) return toast('warning', '找不到这个人物');
            const d = normalizeISO(prompt('回应日期（YYYY-MM-DD）', st.currentDate) || '');
            if (!d) return;
            const r = addManualEvent(st, { date: d, layer: 'polemic', personId: person.id, outletId: person.outletIds?.[0], workId: ev.workId, polarity: 0 });
            r.reactsTo = ev.id;
            commit('已加入候选，请到“候选审核”调整褒贬后批准'); break;
        }
        case 'write': await doWrite(st, s, ev); break;
        case 'write-all': {
            const list = st.ledger.filter(x => x.status === 'approved' && !x.text?.body && x.layer !== 'reader_letters' && x.layer !== 'mentions');
            for (const x of list) { await doWrite(st, s, x, true); }
            commit(`写稿完成 ${list.length} 条`);
            break;
        }
        case 'preview-prompt': {
            const { system, user } = buildWriterPrompt(st, ev, getEra(), s);
            showText('写稿提示词预览', `【系统】\n${system}\n\n【用户】\n${user}`);
            break;
        }
        case 'manual-add': {
            const root = $('#pe-manual');
            const f = readForm(root, [
                { key: 'date' }, { key: 'layer', type: 'select' }, { key: 'personId', type: 'select' }, { key: 'outletId', type: 'select' },
                { key: 'workId', type: 'select' }, { key: 'polarity', type: 'select' }, { key: 'count', type: 'number' },
                { key: 'summary', type: 'textarea' }, { key: 'approved', type: 'checkbox' },
            ]);
            if (!normalizeISO(f.date)) return toast('warning', '日期格式应为 YYYY-MM-DD');
            addManualEvent(st, f);
            commit('已录入');
            break;
        }
        case 'export-ledger': {
            const lines = st.ledger.filter(x => x.status === 'approved' && (!ledgerFilter || x.workId === ledgerFilter)).map(x => {
                const p = byId(st.persons, x.personId); const o = byId(st.outlets, x.outletId); const w = byId(st.works, x.workId);
                return `${x.date}（${weekdayZh(x.date)}）${o ? '《' + o.name + '》' : ''}${p?.name || x.personName || ''}｜${LAYERS[x.layer]?.label}｜${w ? '《' + w.title + '》' : ''}｜${x.layer === 'reader_letters' ? '约' + x.count + '封' : x.layer === 'mentions' ? '约' + x.count + '条' : POLS[x.polarity]}\n${x.text?.title ? '标题：' + x.text.title + '\n' : ''}${x.text?.body || x.text?.summary || ''}\n`;
            });
            download(`报刊回声账本_${st.currentDate || ''}.txt`, lines.join('\n'));
            break;
        }

        // 列表编辑
        case 'new-item': {
            const kind = btn.dataset.kind;
            const draft = { penname: blankPenname, outlet: blankOutlet, person: blankPerson, work: blankWork }[kind]();
            editing = { kind, id: draft.id, draft };
            refresh(); document.querySelector('#pe-body .pe-editor')?.scrollIntoView?.({ block: 'start', behavior: 'smooth' }); break;
        }
        case 'edit-item': editing = { kind: btn.dataset.kind, id: btn.dataset.id }; refresh(); document.querySelector('#pe-body .pe-editor')?.scrollIntoView?.({ block: 'start', behavior: 'smooth' }); break;
        case 'cancel-edit': editing = null; refresh(); break;
        case 'rel-add': {
            const list = document.querySelector('.pe-editor .pe-rel-list');
            const self = st.persons.find(p => p.id === list?.dataset.self) || editing?.draft || {};
            list?.insertAdjacentHTML('beforeend', relRow(st, self, {}));
            break;
        }
        case 'rel-del': btn.closest('.pe-rel-row')?.remove(); break;
        case 'leak-yes':
        case 'leak-no': {
            const lk = (st.identityLeaks || []).find(x => x.id === btn.dataset.id);
            if (!lk) break;
            lk.status = act === 'leak-yes' ? 'confirmed' : 'denied';
            if (act === 'leak-yes') {
                const pen = byId(st.pennames, lk.pennameId); const q = byId(st.persons, lk.to);
                if (pen && q) { pen.knownBy = [...new Set([...(pen.knownBy || []), q.id])]; q.knowsIdentity = true; }
                logLine(st, `确认：${byId(st.persons, lk.to)?.name} 从 ${byId(st.persons, lk.from)?.name} 处得知“${byId(st.pennames, lk.pennameId)?.name}”的身份`);
            }
            commit(act === 'leak-yes' ? '已记为知情' : '已否认');
            break;
        }
        case 'save-item': {
            const kind = btn.dataset.kind;
            const spec = { penname: PEN_SPEC, outlet: OUTLET_SPEC, person: PERSON_SPEC, work: WORK_SPEC }[kind];
            const listName = { penname: 'pennames', outlet: 'outlets', person: 'persons', work: 'works' }[kind];
            const root = document.querySelector('.pe-editor');
            const vals = readForm(root, spec);
            const nameKey = kind === 'work' ? 'title' : 'name';
            if (!String(vals[nameKey] || '').trim()) return toast('warning', '名称不能为空');
            let obj = st[listName].find(x => x.id === editing.id);
            if (!obj) { obj = editing.draft; st[listName].push(obj); }
            Object.assign(obj, vals);
            if (kind === 'person') obj.relations = readRelations(root);
            if (kind === 'outlet' && obj.weekday === '') obj.weekday = null;
            editing = null;
            commit('已保存');
            break;
        }
        case 'del-item': {
            const kind = btn.dataset.kind;
            const listName = { penname: 'pennames', outlet: 'outlets', person: 'persons', work: 'works' }[kind];
            if (!confirm('删除？已批准的账本记录会保留。')) return;
            st[listName] = st[listName].filter(x => x.id !== btn.dataset.id);
            if (kind === 'work') rerollWork(st, btn.dataset.id);
            commit(); break;
        }
        case 'reroll-work': {
            const root = document.querySelector('.pe-editor');
            const obj = st.works.find(x => x.id === btn.dataset.id);
            Object.assign(obj, readForm(root, WORK_SPEC));
            rerollWork(st, obj.id);
            editing = null;
            if (!st.currentDate) { commit('已清除旧推演；设定故事日期后会重新推演'); break; }
            lastReport = advanceTo(st, st.currentDate, s, getEra());
            commit(`已按新资料重推：新增候选 ${lastReport.newCandidates.length} 条`);
            break;
        }

        // 年代
        case 'era-build':
        case 'era-build-nowiki': await doEra(st, s, act === 'era-build'); break;
        case 'era-propose': {
            const props = profileToProposals(getEra());
            st.pendingMerge.push(...props);
            tab = 'import';
            commit(`已加入待合并 ${props.length} 条`);
            break;
        }
        case 'era-edit': editing = { kind: 'era' }; refresh(); break;
        case 'era-save-json': {
            const obj = JSON.parse($('#pe-era-json').value);
            st.eraProfile = obj;
            if (st.era.key) s.eraCache[st.era.key] = obj;
            saveSettings();
            editing = null; commit('已保存'); break;
        }
        case 'era-clear': if (confirm('清除本聊天的年代档案？')) { st.eraProfile = null; if (st.era.key) delete s.eraCache[st.era.key]; saveSettings(); commit(); } break;
        case 'wiki-search': {
            const lang = $('#pe-search-lang').value;
            const q = $('#pe-search-q').value.trim();
            if (!q) return;
            setBusy('检索中');
            searchResults = await wikiSearch(lang, q);
            setBusy('');
            refresh(); break;
        }
        case 'wiki-open': {
            const r = searchResults[+btn.dataset.i];
            setBusy('读取摘要');
            const ex = await wikiExtract(r.lang, r.title);
            setBusy('');
            let text = ex?.text || '';
            if (st.currentDate && new RegExp(`\\b${yearOf(st.currentDate)}\\b`).test(r.title)) text = trimFuture(text, st.currentDate);
            r.extract = text;
            refresh(); break;
        }
        case 'wiki-note': {
            const r = searchResults[+btn.dataset.i];
            st.eraNotes.push({ title: `${r.lang}:${r.title}`, text: truncate(r.extract || r.snippet, 2500) });
            commit('已加入年代笔记'); break;
        }
        case 'note-add': {
            const t = $('#pe-note-text').value.trim();
            if (!t) return;
            st.eraNotes.push({ title: $('#pe-note-title').value.trim(), text: t });
            commit(); break;
        }
        case 'note-del': st.eraNotes.splice(+btn.dataset.i, 1); commit(); break;

        // 导入
        case 'wb-load': {
            const name = $('#pe-wb-name').value.trim();
            if (!name) return;
            setBusy('读取世界书');
            try { materials.push({ id: uid(), label: `世界书“${name}”`, kind: '设定', text: await loadWorldbookText(name) }); } finally { setBusy(''); }
            refresh();
            break;
        }
        case 'extract': {
            const text = $('#pe-import-text').value.trim();
            if (!text) return toast('warning', '请先粘贴文本');
            setBusy('抽取中');
            const props = await extractFromText(text, s, m => setBusy(m));
            st.pendingMerge.push(...props);
            setBusy('');
            commit(`抽取完成：${props.length} 条待合并`);
            break;
        }
        case 'merge-selall': document.querySelectorAll('.pe-merge-cb').forEach(c => { c.checked = true; }); break;
        case 'merge-clear': if (confirm('清空待合并列表？')) { st.pendingMerge = []; commit(); } break;
        case 'merge-selected': {
            const idx = [...document.querySelectorAll('.pe-merge-cb:checked')].map(c => +c.value);
            const order = { penname: 0, outlet: 1, person: 2, work: 3, reaction: 4 };
            const chosen = idx.map(i => st.pendingMerge[i]).filter(Boolean).sort((a, b) => order[a.kind] - order[b.kind]);
            const msgs = chosen.map(p => applyProposal(st, p));
            st.pendingMerge = st.pendingMerge.filter((_, i) => !idx.includes(i));
            msgs.forEach(m => logLine(st, m));
            commit(`已合并 ${chosen.length} 条`);
            break;
        }

        // 设置
        case 'settings-save': {
            const vals = readForm(document.getElementById('pe-settings'), SETTINGS_SPEC);
            Object.assign(s, vals);
            s.layerMult = s.layerMult || {};
            document.querySelectorAll('#pe-layermult [data-lm]').forEach(i => { s.layerMult[i.dataset.lm] = Number(i.value) || 0; });
            saveSettings();
            commit('设置已保存');
            break;
        }
        case 'api-test': {
            setBusy('测试中');
            const r = await callLLM({ system: '只回复 OK', user: 'ping', settings: s, maxTokens: 20 });
            setBusy('');
            toast('success', '模型返回：' + truncate(r, 60));
            break;
        }

        // 阅读记录 / 证据卡
        case 'gen-card': {
            const root = document.querySelector('.pe-editor');
            const obj = st.works.find(x => x.id === btn.dataset.id);
            if (root) Object.assign(obj, readForm(root, WORK_SPEC));
            if ((obj.sourceText || '').length < 200) return toast('warning', '请先在“原文”里贴入至少 200 字的作品正文');
            setBusy('生成证据卡');
            try { obj.evidence = await buildEvidenceCard(obj, s); } finally { setBusy(''); }
            logLine(st, `证据卡：《${obj.title}》`);
            commit(`证据卡已生成：${(obj.evidence.keyPoints || []).length} 条要点`);
            break;
        }
        case 'gen-opinion': {
            const rec = st.receptions.find(r => r.id === btn.dataset.id);
            if (!rec) break;
            setBusy('生成私下看法');
            try { await generateOpinion(st, rec, getEra(), s); } finally { setBusy(''); }
            commit('已生成');
            break;
        }
        case 'manual-read': {
            const f = readForm($('#pe-manual-read'), [{ key: 'workId', type: 'select' }, { key: 'personId', type: 'select' }, { key: 'date' }, { key: 'read', type: 'select' }, { key: 'note' }]);
            if (st.currentDate && normalizeISO(f.date) && cmp(normalizeISO(f.date), st.currentDate) > 0) return toast('warning', '只能记录已经发生的阅读（不晚于当前故事日期）');
            const rec = recordManualReading(st, s, getEra(), f);
            commit(`已记录；后续推演出 ${rec.eventIds.length} 条可能的表达`);
            break;
        }

        // 书信簿
        case 'epi-scan': {
            const found = scanLetters(st);
            const handled = (st.epiHints || []).filter(x => x.handled);
            st.epiHints = [...handled, ...found];
            commit(found.length ? `找到 ${found.length} 条线索（仅供参考）` : '没有找到提到作品或笔名的信');
            break;
        }
        case 'epi-hint-read':
        case 'epi-hint-letter':
        case 'epi-hint-ignore': {
            const hint = (st.epiHints || []).find(x => x.id === btn.dataset.id);
            if (!hint) break;
            if (act === 'epi-hint-read') {
                if (st.currentDate && cmp(hint.date, st.currentDate) > 0) return toast('warning', '这封信晚于当前故事日期');
                recordManualReading(st, s, getEra(), { workId: hint.workId, personId: hint.personId, date: hint.date, read: 'finished', note: `书信 ${hint.code || hint.letterId}` });
            } else if (act === 'epi-hint-letter') {
                const ev = addManualEvent(st, { date: hint.date, layer: 'private_letter', personId: hint.personId, workId: hint.workId, polarity: 0, summary: `（据书信簿 ${hint.code || ''}）${hint.excerpt}` });
                ev.flags = ['来自书信簿', '褒贬请自行修改'];
                ev.epiLetterId = hint.letterId;
            }
            hint.handled = act.replace('epi-hint-', '');
            commit(act === 'epi-hint-ignore' ? '已忽略' : act === 'epi-hint-letter' ? '已加入候选（请到候选里确认褒贬后批准）' : '已记为读过');
            break;
        }

        case 'epi-unload': clearBackup(); st.epiScope = ''; commit('已卸下备份'); break;
        case 'epi-hint-extract': {
            const hint = (st.epiHints || []).find(x => x.id === btn.dataset.id);
            const txt = hint && letterText(hint.letterId);
            if (!txt) return toast('warning', '找不到这封信的全文（备份可能已卸下）');
            materials.push({ id: uid(), label: `书信 ${hint.code || hint.letterId}`, kind: '书信', text: txt });
            refresh();
            document.getElementById('pe-org-drop')?.scrollIntoView?.({ block: 'start' });
            toast('success', '已加入整理材料，点“开始整理”交给模型');
            break;
        }
        case 'art-set':
        case 'art-append':
        case 'art-new': {
            const body = articleBody(btn.dataset.id);
            if (!body) return toast('warning', '找不到这篇文章（备份可能已卸下）');
            const MAX = 150000;
            let w;
            if (act === 'art-new') {
                const a = listArticles(st).find(x => x.id === btn.dataset.id);
                w = { ...blankWork(), title: (a?.head || a?.code || '未命名').replace(/^[#*\s]+|[*]+$/g, '').slice(0, 40), pubDate: /^\d{4}-\d{2}-\d{2}$/.test(a?.date || '') ? a.date : '', pennameId: st.pennames[0]?.id || '' };
                st.works.push(w);
            } else {
                w = byId(st.works, [...document.querySelectorAll('.pe-art-work')].find(x => x.dataset.id === btn.dataset.id)?.value);
                if (!w) return toast('warning', '请先选择对应的作品');
            }
            const cur = act === 'art-append' ? String(w.sourceText || '') : '';
            w.sourceText = (cur ? cur + '\n\n' : '') + body;
            if (w.sourceText.length > MAX) { w.sourceText = w.sourceText.slice(0, MAX); toast('warning', `原文超过 ${MAX} 字，已截断`); }
            w.sourceFrom = [...new Set([...(act === 'art-append' ? w.sourceFrom || [] : []), btn.dataset.id])];
            if (w.evidence) w.evidence.stale = true;
            commit(act === 'art-new' ? `已新建作品《${w.title}》，请到“作品”页补充资料` : `已导入《${w.title}》原文（共 ${w.sourceText.length} 字）${w.evidence ? '；证据卡需要重新生成' : ''}`);
            break;
        }
        case 'epi-people': {
            const props = peopleProposals(st);
            st.pendingMerge.push(...props);
            commit(props.length ? `已加入 ${props.length} 位人物到待合并（默认无公开身份，请补上身份和供稿刊物；不需要的不勾选即可）` : '书信簿里没有新人物');
            break;
        }
        case 'epi-date-adopt': {
            const d = epistolaryStoryDate();
            if (!d) break;
            if (st.currentDate && cmp(d, st.currentDate) < 0) return toast('warning', '书信簿日期早于当前日期，不能倒退');
            if (!st.currentDate) { st.currentDate = d; syncEraYear(st); commit('已设为故事日期'); } else doAdvance(st, s, d);
            break;
        }

        case 'state-export': download(`报刊回声_${st.currentDate || 'data'}.json`, JSON.stringify(st, null, 2)); break;
        case 'state-reset': if (confirm('清空本聊天的全部报刊回声数据？此操作不可撤销（建议先导出）。')) { resetState(); commit('已清空'); } break;
        default: break;
        }
    } catch (err) {
        setBusy('');
        console.error('[报刊回声]', err);
        toast('error', String(err.message || err));
    }
}

function syncEraYear(st) {
    if (!st.currentDate) return;
    const y = yearOf(st.currentDate);
    st.era.year = y;
    const key = eraKey(y, st.era.place);
    if (st.era.key !== key) {
        st.era.key = key;
        const cached = getSettings().eraCache?.[key];
        if (cached) st.eraProfile = cached;
        else if (st.eraProfile && st.eraProfile.year !== y) st.eraProfile = null;
    }
}

export function doAdvance(st, s, d) {
    if (st.backfillRun) { toast('warning', '回溯推演进行中，先在“概览”完成或放弃回溯，再推进日期'); return null; }
    if (st.currentDate && cmp(d, st.currentDate) < 0) return toast('warning', '日期不能倒退。若需要更正，请用“设为当前（不推演）”');
    const from = st.currentDate;
    lastReport = advanceTo(st, d, s, getEra());
    syncEraYear(st);
    const auto = lastReport.autoApproved?.length || 0;
    logLine(st, `推进 ${from || '（起点）'} → ${d}：新增候选 ${lastReport.newCandidates.length}，自动通过 ${auto}，新排期 ${lastReport.scheduled}，揭晓 ${lastReport.revealed.length}`);
    commit();
    const pending = lastReport.newCandidates.filter(x => x.status === 'candidate').length;
    if (pending || auto) toast('info', `故事推进到 ${d}：${pending} 条反响待审核${auto ? `，${auto} 条次要反响已自动记入` : ''}${lastReport.reapplied ? `（${lastReport.reapplied} 条沿用了你之前的审核）` : ''}`);
    return lastReport;
}

async function doWrite(st, s, ev, silent) {
    setBusy('写稿中');
    try {
        await writeEvent(st, ev, getEra(), s);
        logLine(st, `写稿：${ev.date} ${ev.text.title || ''}`);
        if (!silent) commit(ev.flags?.length ? '写稿完成（有时代校验提示，请查看）' : '写稿完成');
    } finally { setBusy(''); }
}

async function doEra(st, s, useWiki) {
    if (!st.currentDate) return toast('warning', '请先设定故事日期');
    syncEraYear(st);
    const year = yearOf(st.currentDate);
    let sources = [];
    if (useWiki) {
        const lines = (document.getElementById('pe-wiki-titles')?.value || '').split('\n').map(l => l.trim()).filter(Boolean);
        const titles = lines.map(l => { const i = l.indexOf(':'); return i > 0 ? { lang: l.slice(0, i).trim(), title: l.slice(i + 1).trim() } : null; }).filter(Boolean);
        sources = await gatherSources({ year, country: st.era.country, currentIso: st.currentDate, titles, settings: s, onProgress: setBusy });
        const ok = sources.filter(x => x.text).length;
        if (!ok) toast('warning', '维基百科没有取到内容（可能是网络或页面不存在），将仅用模型知识生成');
    }
    setBusy('生成年代档案');
    try {
        const prof = await buildEraProfile({ year, currentIso: st.currentDate, placeLabel: st.era.place, sources, notes: st.eraNotes, settings: s });
        st.eraProfile = prof;
        s.eraCache = s.eraCache || {};
        s.eraCache[st.era.key] = prof;
        saveSettings();
        logLine(st, `生成年代档案：${st.era.key}`);
        commit('年代档案已生成');
    } finally { setBusy(''); }
}

function showText(title, text) {
    const w = document.createElement('div');
    w.className = 'pe-modal';
    w.innerHTML = `<div class="pe-modal-box"><div class="pe-head"><b>${h(title)}</b><button class="pe-x">✕</button></div><pre>${h(text)}</pre></div>`;
    w.addEventListener('click', ev => { if (ev.target === w || ev.target.classList.contains('pe-x')) w.remove(); });
    document.body.appendChild(w);
}

function download(name, text) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

export { syncEraYear };
