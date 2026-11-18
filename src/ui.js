// ui.js — 面板界面（纯 DOM，不依赖框架）

import { escapeHtml as h, parseTags, tagsToText, truncate, uid, extractJSON, isStoryMessage } from './util.js';
import { weekdayZh, normalizeISO, yearOf, cmp, addDays, diffDays } from './date.js';
import { planFloorSegments } from './segments.js';
import {
    FORMS, PERIODICITY, CIRCLES, LAYERS, ROLES, knownToUser, knownSince, repLabel, fameLabel, esteemLabel, FAME_LEVELS, recomputeReputation, repBreakdown, repOrphans, fixRepOrphans, setStatus, rerollWork, advanceTo, byId, columnSlots,
    rerollPerson, rerollOutlet, approxIssue, READ_STATES, STRENGTH, EXPRESSION, CHANNELS, OPINION_STATUS, REL_TYPES, REL_FREQ, REL_BASIS, isMutual, relationsBetween, edgeFlows, findPaths, relationsOf, opinionStatus, isMajor, recordManualReading, backfill, backfillBegin, backfillStep, backfillEnd, simulate, impressionAt, IMPRESSION_LABEL, seriesKey, READ_DONE } from './engine.js';
import { buildEvidenceCard, cardText, generateOpinion, OPINION_DIMS, STYLE_CHECKLIST, RESPECT, FOLLOW, draftPersonProfile, draftWorkClaims } from './analysis.js';
import {
    epistolaryAvailable, epistolaryStoryDate, sendToEpistolary, epistolaryWritable, scanLetters, peopleProposals, loadBackup, clearBackup, backupInfo, archiveSource,
    effectiveScope, listArticles, articleBody, letterText,
} from './epistolary.js';
import { getSettings, saveSettings, getState, saveState, resetState, replaceState, logLine, looksLikeBundleData, advanceMode } from './store.js';
import { blankOutlet, blankPerson, blankWork, blankPenname, applyProposal, addManualEvent } from './data.js';
import { writeEvent, buildWriterPrompt, translatePaperFr } from './writer.js';
import {
    guessPlace, eraKey, defaultWikiTitles, gatherSources, buildEraProfile, profileToProposals, wikiSearch, wikiExtract, trimFuture, eraDue, periodLabel } from './era.js';
import { extractFromText, loadWorldbookText } from './extract.js';
import { callLLM, listModels } from './llm.js';
import { suggestRelations, acceptRelSuggestion, CERTAINTY, checkOutlets, acceptOutletCheck, fmtOutletVal, OUT_FIELDS } from './relsuggest.js';
import { Fab } from './fab.js';
import { PROJECT_STAGES, POINT_KINDS, ADOPT, ME, blankProject, blankTalk, blankPoint, talkPeople, normProject, normTalk } from './ideas.js';
import { FACT_TOPICS, FACT_VIA, PERC_KIND, PERC_TOPICS, factsKnownBy, perceptionsOf, blankFact } from './perception.js';
import { perceptionMatrix, latestImage, publicPieces, activeCircles, generatePublicImage, reviewPerceptions, manualPerception, blankSelf, blankAssumed, SELF_MODE, SPREAD, REVIEW_TYPE } from './image.js';
import { workTimeline, timelineSvg, networkData, visibleNetwork, layoutNetwork, networkSvg, paperHtml, paperDates, PAPER_CSS, outletOriginal, frDate, paperMissingFr, paperItems } from './views.js';
import { syncLore, lorePersons } from './lore.js';
import { pushUndo, popUndo, lastUndo } from './undo.js';
import { rebaseSnapshots } from './rollback.js';
import { srcOf, srcLen, loadSources, sourcesReady, withSources } from './sources.js';
import { buildOffscreen, storeOffscreen, OFF_KINDS } from './offscreen.js';
import { suggestPersons, shouldSuggest, acceptSuggestion } from './suggest.js';
import { clog, taskBegin, taskStep, taskEnd, currentTask, allEntries, clearEntries, subscribe, entriesText, LEVELS } from './console.js';
import { buildConcepts, unclassified, allTags, conceptGroups } from './concepts.js';
import { planImport, readTextFile, parseFileName } from './txtimport.js';
import {
    FORMAT_SPEC, FORMAT_RULES, buildExternalPrompt, normalizeBundle, mergeBundles, previewBundle, applyBundle, organize,
    chatToText, summaryCoverage, parseJsonl, looksLikeBundle, chunk as chunkMaterial, replaceBundleItem,
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
let findQ = {}; // 各页的搜索词
const foldOpen = new Set(); // 阅读记录里展开的作品
let bundleEdit = null; // 预览里正在改的条目 { k, i } 或 { all: true }
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
        else if (f.type === 'number' || f.type === 'range') out[f.key] = el.value === '' ? null : Number(el.value);
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
const ideasHtml = m => [
    m.agree?.length ? `<span class="pe-idea pe-idea-ok" title="议题立场与作品主张一致">赞同 ${m.agree.map(h).join('；')}</span>` : '',
    m.partial?.length ? `<span class="pe-idea pe-idea-mid" title="一方有保留：部分赞同、有分歧">部分赞同 ${m.partial.map(h).join('；')}</span>` : '',
    m.disagree?.length ? `<span class="pe-idea pe-idea-no" title="议题立场与作品主张相反">反对 ${m.disagree.map(h).join('；')}</span>` : '',
].join('');
const UNJ = { technique: '技巧', ideas: '思想', argument: '论证', emotion: '情感' };
function opinionDetail(o) {
    const pts = (list, cls, lab) => list?.length ? `<div class="pe-op-line ${cls}"><b>${lab}</b>${list.map(x => `${x.key ? '<span class="pe-chip pe-chip-major">关键</span>' : ''}${h(x.point)}${x.evidence ? ` <small class="pe-muted">${h(x.evidence)}</small>` : ''}`).join('；')}</div>` : '';
    return `${pts(o.agreedPoints, 'pe-op-ok', '认可')}${pts(o.disagreements, 'pe-op-no', '分歧')}
      ${o.styleNotes?.length ? `<div class="pe-op-line"><b>文字</b>${o.styleNotes.map(x => `${h(x.aspect)}：${h(x.verdict || '')} <q>${h(x.quote)}</q>`).join('；')}</div>` : ''}
      ${o.unjudged?.length ? `<div class="pe-op-line pe-muted"><b>尚未判断</b>${o.unjudged.map(k => UNJ[k]).join('、')}（没有原文证据）</div>` : ''}
      ${(o.beliefs || []).length ? `<div class="pe-op-line"><b>对作者</b>${(st => (st.perceptions || []).filter(x => o.beliefs.includes(x.id)).map(x => `<span class="pe-belief pe-k-${x.kind}">${h(x.belief)} <small>${PERC_KIND[x.kind]}${x.confidence != null ? ' · ' + Math.round(x.confidence * 100) + '%' : ''}</small></span>`).join(''))(getState())}</div>` : ''}
      ${o.respectsAuthor || o.follow ? `<div class="pe-op-line">${o.respectsAuthor ? `<span class="pe-chip">${RESPECT[o.respectsAuthor]}</span>` : ''}${o.follow ? `<span class="pe-chip pe-chip-layer">${FOLLOW[o.follow]}</span>` : ''}</div>` : ''}`;
}
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
    { key: 'originalName', label: '原文刊名', placeholder: '如 L’Écho de Paris', hint: '报纸版面预览的报头用它' },
    { key: 'periodicity', label: '出刊周期', type: 'select', options: PERIODICITY },
    { key: 'weekday', label: '周刊出刊日', type: 'select', options: WEEKDAYS, numeric: true, hint: '仅周刊用' },
    { key: 'monthDays', label: '月刊/半月刊出刊日', type: 'tags', numeric: true, hint: '如：1，15。留空则半月刊=1、15日，月刊=1日' },
    { key: 'issueDates', label: '已知出刊日期（不定期刊物）', type: 'tags', hint: '不定期刊物只在这些日子出刊，如 1890-05-03，1890-06-14。留空：每天都可能出，推演出的评论会标“请核对”，不自动入账' },
    { key: 'politics', label: '政治/宗教倾向', type: 'tags' },
    { key: 'circle', label: '所属圈子', type: 'select', options: CIRCLES, hint: '决定批准后的反响计入哪一类声誉' },
    { key: 'userReads', label: '主角常读', type: 'checkbox', hint: '主角自己订阅或每天翻的报刊：上面登的文章当天就算主角读到。其余公开文章按“设置 · 主角知道什么”的规则（默认靠剪报，几天后才知道）' },
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
    { key: 'datePrecision', label: '发表日期的精度', type: 'select', options: { '': '精确到日', xun: '只知道旬（填该旬第一天）', month: '只知道月份（填该月 1 日）', noLaterThan: '只知道不晚于这一天' }, hint: '不精确时，推演在可能的范围内取一个确定的日子，不把它当成确切的首发日' },
    { key: 'dateFrom', label: '最早可能的日期（只知道“不晚于”时）', placeholder: 'YYYY-MM-DD，可空', hint: '如：只知道交稿日和售罄日。填了就在这两天之间取；不填，往前最多 20 天' },
    { key: 'endDate', label: '连载结束日', type: 'date', placeholder: 'YYYY-MM-DD，可空' },
    { key: 'shelf', label: '发表后是否长期有人读', type: 'select', options: { '': '按形式（成书、单行本、小册子会）', yes: '会：书店、图书馆、沙龙里一直流通', no: '不会：过了发表期就没人再找' }, hint: '长期流通的作品，每个月都给还没碰过它的人一次机会；作者近期有话题作时机会更大' },
    { key: 'shelfUntil', label: '流通到', type: 'date', placeholder: '售罄或绝版日期，可空' },
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
        <span class="pe-busy" id="pe-busy" data-act="con-toggle" title="点开控制台看详细进度"></span>
        <span class="pe-spacer"></span>
        <button class="pe-close pe-undo-btn" id="pe-undo" data-act="undo" hidden>↶</button>
        <button class="pe-close pe-con-btn" data-act="con-toggle" title="控制台：每一步在做什么、调用模型的情况、报错">▤<span class="pe-con-badge" id="pe-con-badge"></span></button>
        <button class="pe-close" data-act="win-reset" title="恢复默认位置和大小">⤢</button>
        <button class="pe-close" data-act="close" title="关闭">✕</button>
      </div>
      <nav class="pe-tabs"></nav>
      <div class="pe-body" id="pe-body"></div>
      <div class="pe-con" id="pe-con" hidden>
        <div class="pe-con-head">
          <b>控制台</b>
          <span class="pe-con-task" id="pe-con-task"><span class="pe-muted">空闲</span></span>
          <span class="pe-spacer"></span>
          <label class="pe-con-opt" title="开始推演、整理、写稿等任务时自动打开控制台"><input type="checkbox" id="pe-con-auto"> 有任务时自动打开</label>
          <button class="pe-con-b" data-act="con-copy" title="复制全部记录（报错时发给开发者）">复制</button>
          <button class="pe-con-b" data-act="con-clear">清空</button>
          <button class="pe-con-b" data-act="con-toggle" title="收起">✕</button>
        </div>
        <div class="pe-con-list" id="pe-con-list"></div>
      </div>
      <div class="pe-resize" title="拖动调整大小"></div>`;
    document.body.appendChild(panel);
    panel.addEventListener('click', onClick);
    bindConsole(panel);
    bindTips(panel);
    panel.addEventListener('change', onChange);
    // 拖动不透明度滑块：立刻生效，数字跟着变（松手时 change 事件照常保存）
    panel.addEventListener('input', e => {
        const t = e.target;
        if (t.type !== 'range' || t.dataset?.k !== 'panelOpacity') return;
        const out = t.parentElement.querySelector('output'); if (out) out.textContent = t.value + '%';
        applyPanelOpacity({ panelOpacity: Number(t.value) });
    });
    panel.addEventListener('input', e => { if (e.target.id === 'pe-find') { findQ[tab] = e.target.value; applyFind(); } });
    panel.addEventListener('keydown', e => { if (e.target.id === 'pe-find' && e.key === 'Escape') { e.stopPropagation(); findQ[tab] = ''; e.target.value = ''; applyFind(); } });
    // 记住阅读记录里哪些作品是展开的（搜索时自动展开的不算）
    panel.addEventListener('toggle', e => { const d = e.target; if (d.dataset?.pcfold && simView?.kind === 'perc') simView.open = { ...simView.open, [d.dataset.pcfold]: d.open }; if (d.dataset?.fold && !findTerms().length) { if (d.open) foldOpen.add(d.dataset.fold); else foldOpen.delete(d.dataset.fold); } }, true);
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
    // 同步到控制台：没有进行中的任务就开一个，有就记成其中一步
    const t = currentTask();
    if (text) {
        if (!t || t.ending) taskBegin(text).auto = true;
        else if (text !== t.label && text !== t.name) { const m = String(text).match(/(\d+)\s*\/\s*(\d+)/); taskStep(text, m ? +m[1] : 0, m ? +m[2] : 0); }
    } else if (t?.auto) taskEnd();
    busy = text || '';
    const b = document.getElementById('pe-busy');
    if (b) { b.textContent = busy ? `${busy}…` : ''; b.classList.toggle('on', !!busy); }
}

// ———— 页内搜索：只隐藏不匹配的条目，不重绘（输入不会被打断） ————
const FIND = {
    queue: { ph: '搜索人物、刊物、作品、概要', items: '.pe-ev' },
    ledger: { ph: '搜索人物、刊物、作品、标题、正文', items: '.pe-ev' },
    reading: { ph: '搜索作品、人物、看法、理由', groups: '.pe-rd-work', items: '.pe-rd-row' },
    works: { ph: '搜索作品名、刊物、笔名、日期', items: '.pe-li-item' },
    people: { ph: '搜索人物、刊物、立场、标签', items: '.pe-li-item, .pe-concepts > div' },
    era: { ph: '搜索刊物、评论家、事件、用语、笔记', groups: '.pe-era-sec', items: '.pe-era-card, .pe-era-tl-row, .pe-chip, .pe-era-ul > li, .pe-era-notes > li' },
};
/** 卡片上没显示、但应该能搜到的资料（兴趣、喜好、别名、关系、题材、概要…） */
function findText(o, st) {
    const out = [];
    const skip = new Set(['id', 'sourceText', 'evidence', 'color', 'pennameId', 'outletId', 'outletIds']);
    const walk = (v, depth) => {
        if (v == null || depth > 3) return;
        if (typeof v === 'string') { if (v.length < 400) out.push(v); return; }
        if (Array.isArray(v)) { v.forEach(x => walk(x, depth + 1)); return; }
        if (typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (k === 'to') out.push(byId(st.persons, x)?.name || ''); else if (!skip.has(k)) walk(x, depth + 1); }
    };
    walk(o, 0);
    if (o.outletId) out.push(byId(st.outlets, o.outletId)?.name || '');
    for (const id of o.outletIds || []) out.push(byId(st.outlets, id)?.name || '');
    if (o.pennameId) out.push(byId(st.pennames, o.pennameId)?.name || '');
    return out.join(' ');
}
const findTerms = () => String(findQ[tab] || '').toLowerCase().split(/\s+/).filter(Boolean);
function findBox() {
    const cfg = FIND[tab];
    if (!cfg) return '';
    return `<div class="pe-find"><label class="pe-find-box">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 21 21"/></svg>
        <input type="search" id="pe-find" placeholder="${h(cfg.ph)}" value="${h(findQ[tab] || '')}" autocomplete="off" spellcheck="false">
        <span class="pe-find-n" id="pe-find-n"></span>
        <button type="button" class="pe-find-x" data-act="find-clear" title="清除（Esc）">×</button></label></div>`;
}
function applyFind() {
    const body = document.getElementById('pe-body');
    const cfg = FIND[tab];
    if (!body || !cfg) return;
    const terms = findTerms();
    body.querySelector('.pe-find')?.classList.toggle('on', !!terms.length);
    const hit = el => { const t = (el.textContent + ' ' + (el.dataset?.find || '')).toLowerCase(); return terms.every(x => t.includes(x)); };
    // 只处理最外层条目（卡片里的标签不单独隐藏）
    const top = (root, el) => { const up = el.parentElement?.closest(cfg.items); return !up || !root.contains(up); };
    let n = 0;
    const groups = cfg.groups ? [...body.querySelectorAll(cfg.groups)] : [];
    for (const g of groups) {
        const items = [...g.querySelectorAll(cfg.items)].filter(i => top(g, i));
        if (!terms.length) {
            items.forEach(i => { i.hidden = false; }); g.hidden = false;
            if (g.dataset.wasOpen != null) { g.open = g.dataset.wasOpen === '1'; delete g.dataset.wasOpen; }
            continue;
        }
        const head = g.querySelector('summary');
        const headHit = head && hit(head);
        let k = 0;
        items.forEach(i => { const ok = headHit || hit(i); i.hidden = !ok; if (ok) k++; });
        const show = headHit || k > 0 || (!items.length && hit(g));
        g.hidden = !show;
        if (show) { if (g.dataset.wasOpen == null) g.dataset.wasOpen = g.open ? '1' : '0'; g.open = true; n += k || 1; }
    }
    for (const i of body.querySelectorAll(cfg.items)) {
        if (groups.some(g => g.contains(i)) || !top(body, i)) continue;
        const ok = !terms.length || hit(i);
        i.hidden = !ok;
        if (ok && terms.length) n++;
    }
    const cnt = document.getElementById('pe-find-n');
    if (cnt) cnt.textContent = terms.length ? (n ? `${n} 处` : '没有找到') : '';
    // 高亮匹配文字（浏览器支持 CSS Highlight 时）
    if (globalThis.CSS?.highlights && globalThis.Highlight) {
        CSS.highlights.delete('pe-find');
        if (!terms.length) return;
        const ranges = [];
        const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node && ranges.length < 400; node = walker.nextNode()) {
            if (node.parentElement?.closest('[hidden], .pe-find, script, style')) continue;
            const t = node.nodeValue.toLowerCase();
            for (const x of terms) {
                let at = t.indexOf(x);
                while (at >= 0 && ranges.length < 400) { const r = new Range(); r.setStart(node, at); r.setEnd(node, at + x.length); ranges.push(r); at = t.indexOf(x, at + x.length); }
            }
        }
        CSS.highlights.set('pe-find', new Highlight(...ranges));
    }
}

export function refresh() {
    const body = document.getElementById('pe-body');
    if (!body) return;
    const st = getState();
    const s = getSettings();
    const pending = st ? st.ledger.filter(e => e.status === 'candidate').length : 0;
    applyPanelOpacity(s);
    const nav = document.querySelector('#pe-panel .pe-tabs');
    if (nav) nav.innerHTML = TABS.map(([k, v]) => `<button data-tab="${k}" class="${k === tab ? 'active' : ''}">${v}${k === 'queue' && pending ? ` <span class="pe-count">${pending}</span>` : ''}</button>`).join('');
    const hd = document.getElementById('pe-head-date');
    if (hd) {
        const pend = st?.detectedDate && st.currentDate && cmp(st.detectedDate, st.currentDate) > 0;
        hd.textContent = st?.currentDate ? `${pend ? st.detectedDate : st.currentDate} · ${weekdayZh(pend ? st.detectedDate : st.currentDate)}${pend ? `（推演到 ${st.currentDate.slice(5)}）` : ''}` : '未设定日期';
        hd.title = pend ? '故事日期已前进，推演还停在括号里的日期；满设定天数会自动推演，或点“一键推演”' : '';
        hd.classList.toggle('pe-unset', !st?.currentDate);
    }
    fab?.setBadge(pending);
    const ub = document.getElementById('pe-undo');
    if (ub) { const u = st && lastUndo(st); ub.hidden = !u; ub.title = u ? `撤销：${u.label}（${new Date(u.at).toLocaleTimeString()}）` : ''; }
    fab?.setVisible(!!s.enabled);
    if (!st) { body.innerHTML = '<div class="pe-empty">请先打开一个聊天。</div>'; return; }
    if (looksLikeBundleData(st)) {
        body.innerHTML = `<div class="pe-callout pe-callout-warn"><div><b>本聊天的数据有问题</b><br>
          看起来是把“整理包”当成存档导入了（设置页的“导入 JSON”），导致笔名、刊物、人物、作品都没有编号：所有作品都会被算到第一个笔名、第一家刊物名下，推演也无法进行。<br>
          点下面的按钮修复：会把这份数据当作整理包重新导入（先给出预览），原来推演出的内容会清掉。</div>
          <button class="menu_button pe-primary" data-act="repair-bundle-state">修复</button></div>`;
        return;
    }
    if (!sourcesReady(st)) { const sid0 = st.storeId, ch0 = st.storeChat; loadSources(st).then(ok => { if (st.storeId !== sid0 || st.storeChat !== ch0) saveState(); if (ok) refresh(); }); }
    const render = simView ? simPage : { overview, queue, ledger, reading, works, people, era, importTab, settings }[tab === 'import' ? 'importTab' : tab];
    const y = body.scrollTop;
    const active = document.activeElement;
    if (active && body.contains(active)) active.blur();
    body.innerHTML = (simView ? '' : findBox()) + render(st, s);
    // 统一成酒馆原生控件样式（与书信簿一致）
    body.querySelectorAll('button:not(.pe-find-x):not(.pe-linkbtn)').forEach(b => b.classList.add('menu_button'));
    body.querySelectorAll('input[type=text], input[type=number], input[type=password], select, textarea').forEach(x => x.classList.add('text_pole'));
    body.scrollTop = y;
    if (!simView) applyFind();
    if (simView?.kind === 'network') bindNetwork();
}

function commit(msg) {
    saveState();
    app?.refreshInjection?.();
    refresh();
    if (msg) toast('success', msg);
    scheduleLore();
}

// 数据有改动后，稍等几秒同步一次世界书（开启了自动同步时）
let loreTimer = null;
function scheduleLore() {
    const s = getSettings();
    if (!s.enabled || !s.loreEnabled || !s.loreAuto) return;
    clearTimeout(loreTimer);
    loreTimer = setTimeout(async () => {
        const st = getState();
        if (!st) return;
        try { await syncLore(st, getSettings()); saveState(); } catch (e) { clog('error', `世界书同步失败：${e.message}`, e.stack || null); }
    }, 4000);
}
export { scheduleLore };

// ———————————— 各页 ————————————

function overview(st, s) {
    const era = getEra();
    const cand = st.ledger.filter(e => e.status === 'candidate').length;
    const sched = st.ledger.filter(e => e.status === 'scheduled').length;
    const appr = st.ledger.filter(e => e.status === 'approved').length;
    const readers = (st.receptions || []).filter(r => READ_DONE.includes(r.read) && (!r.readDate || !st.currentDate || r.readDate <= st.currentDate)).length;
    const d = st.currentDate;
    const bigDate = d ? `${+d.slice(0, 4)} 年 ${+d.slice(5, 7)} 月 ${+d.slice(8, 10)} 日` : '尚未设定故事日期';
    const epiD = s.epiEnabled !== false && s.epiSyncDate && epistolaryAvailable() ? epistolaryStoryDate() : null;
    const recent = st.ledger.filter(e => e.status === 'approved').slice(-4).reverse();
    if (Object.values(st.reputation || {}).some(r => Object.values(r || {}).some(v => typeof v === 'number'))) recomputeReputation(st); // 旧版存的是单一数值
    const pens = st.pennames.map(p => {
        const rep = st.reputation?.[p.id] || {};
        return `<tr><td><b>${h(p.name)}</b>${p.publicIdentityKnown ? ' <span class="pe-chip">身份已公开</span>' : ''}</td>${Object.keys(CIRCLES).map(c => { const r = rep[c]; const f = r?.fame || 0; const lv = FAME_LEVELS.findIndex(([t]) => f < t);
            const inner = `<div>${h(fameLabel(f))}</div>${f >= 0.1 ? `<small class="pe-est pe-est${r.w >= 0.1 ? Math.sign(Math.round((r.mean || 0) * 2)) : 'x'}">${h(esteemLabel(r))}</small>` : ''}`;
            return `<td class="pe-rep pe-fame${lv}" title="${r ? h(`知名度 ${f.toFixed(2)}（${fameLabel(f)}）\n评价：${esteemLabel(r)}${r.w ? `（好评分量 ${r.pos.toFixed(2)}、批评分量 ${r.neg.toFixed(2)}，加权平均 ${(r.mean || 0).toFixed(2)}，共 ${r.n} 篇表态）` : ''}\n点开看由哪些反响构成`) : '没有已入账的公开反响'}">${r ? `<button class="pe-repbtn" data-act="rep-cell" data-pen="${p.id}" data-circle="${c}">${inner}</button>` : inner}</td>`; }).join('')}</tr>`;
    }).join('');
    const orphans = repOrphans(st);
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
        ${!d ? '<div class="pe-muted">聊天里出现日期时会自动识别，也可以在下面手动设定。</div>' : `<button class="menu_button pe-primary pe-big" data-act="sim-now" title="所有作品 × 所有人物，推演到${st.detectedDate && st.detectedDate > d ? '识别到的 ' + h(st.detectedDate) : '当前日期'}；新加的作品和人物、成书的长尾都会补上。之后按设置让 AI 补写幕后（会先告诉你调用几次）">▶ 一键推演到${st.detectedDate && st.detectedDate > d ? ' ' + h(st.detectedDate) : '今天'}</button>`}
        ${st.detectedDate && d && cmp(st.detectedDate, d) > 0 ? `<div class="pe-muted pe-pending">故事已到 <b>${h(st.detectedDate)}</b>，上次推演到 ${h(d)}（相隔 ${diffDays(st.detectedDate, d)} 天）。${advanceMode(s) === 'interval' ? `满 ${h(s.autoAdvanceDays || 14)} 天自动推演，也可以现在点上面的按钮。` : advanceMode(s) === 'off' ? '自动推演已关闭，点上面的按钮推演。' : ''}</div>` : ''}
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
    ${(() => { const due = eraDue(era, st.currentDate, s.eraRefresh || 'quarter'); return due && st.eraDone?.[due.key] !== 'running' ? `<div class="pe-callout">故事进入${h(due.label)}，年代档案还停在 ${h(due.asOf)}。<button class="pe-primary" data-act="era-refresh">刷新年代档案</button></div>` : ''; })()}
    ${(st.personSuggestions || []).some(x => x.status === 'pending') ? `<div class="pe-callout">AI 推荐了 <b>${st.personSuggestions.filter(x => x.status === 'pending').length}</b> 位可能读到作品的人，等你确认。<button class="pe-primary" data-tab-go="people">去看看</button></div>` : ''}
    ${cand ? `<div class="pe-callout pe-callout-accent">有 <b>${cand}</b> 条反响等你确认。<button class="pe-primary" data-tab-go="queue">去审核</button></div>` : ''}

    <h4>最近入账</h4>
    ${recent.length ? recent.map(e => evCard(st, e, '', { compact: true })).join('') + '<div class="pe-more"><a class="pe-link" data-tab-go="ledger">查看全部账本 →</a></div>' : '<div class="pe-empty-sm">还没有入账的反响。</div>'}

    <h4>笔名名声 <small class="pe-muted">只由已入账的公开反响改变。上面一行是知名度（有多少人知道这个署名，批评也会让人知道），下面一行是评价（表态的人整体偏好还是偏坏）。点格子看由哪些反响构成</small></h4>
    ${orphans.length ? `<div class="pe-callout pe-callout-warn">⚠ 有 <b>${orphans.length}</b> 条已入账的反响没算进任何笔名的名声（${h([...new Set(orphans.map(x => x.why))].join('、'))}）。${orphans.some(x => x.want) ? '<button class="pe-primary" data-act="rep-fix">按作品的署名重新关联</button>' : ''}<button class="pe-mini" data-act="rep-orphans">看是哪些</button></div>` : ''}
    ${st.pennames.length ? `<div class="pe-table-wrap"><table class="pe-table pe-rep-table"><tr><th></th>${Object.entries(CIRCLES).map(([k, c]) => `<th title="${h(c)}">${h({ radical: '激进报刊', professional: '专业界', political: '政论界' }[k] || c)}</th>`).join('')}</tr>${pens}</table></div>` : '<div class="pe-empty-sm">还没有笔名。<a class="pe-link" data-tab-go="works">去添加</a></div>'}

    ${offscreenBlock(st)}

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
    if (simView.kind === 'timeline') return timelinePage(st);
    if (simView.kind === 'network') return networkPage(st);
    if (simView.kind === 'paper') return paperPage(st);
    if (simView.kind === 'perc') return percPage(st);
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
    ${personKnowledgeHtml(st, p)}
    ${relationsOf(st, p).length ? `<h5>熟人 <small class="pe-muted">读到东西可能谈起的对象</small></h5><div class="pe-era-chips pe-era-chips-wrap">${relationsOf(st, p).map(r => { const q = byId(st.persons, r.to); return q ? `<span class="pe-chip">${personTag(q)} ${h(REL_TYPES[r.type] || '')} · ${h(REL_FREQ[r.frequency] || '')}${r.implicit ? '（同刊同事）' : ''}${r.since ? ` · ${h(r.since)} 起` : ''}${r.until ? ` · 至 ${h(r.until)}` : ''}${r.discloseIdentity ? ' · 可能说出身份' : ''}</span>` : ''; }).join('')}</div>` : ''}
    <h5>和各部作品的关系（截至 ${h(st.currentDate || '')}）</h5>
    ${works.map(w => { const rc = recOf(w); const future = rc?.readDate && st.currentDate && rc.readDate > st.currentDate; const o = odds[w.id];
      return `<div class="pe-card pe-card-slim pe-colored" style="--c:${penColor(st, w.pennameId) || 'var(--pe-border)'}"><div class="pe-card-main">
        <b>${bt(w.title)}</b> <small class="pe-muted">${h(w.pubDate)}</small>
        ${rc ? `${rc.channel ? ` · ${h(CHANNELS[rc.channel] || '')}` : ''} · <b>${future ? '尚未读到' : h(READ_STATES[rc.read] || rc.read || '未推演')}</b>${rc.readDate && !future ? ` ${h(rc.readDate)}` : ''}${rc.strength && !future ? ` · <span class="pe-chip pe-pol pe-pol${rc.polarity}">${['偏批评', '参半', '偏肯定'][rc.polarity + 1]}</span> ${h(STRENGTH[rc.strength])} ${statusChip(rc)}` : ''}${rc.expression && !future ? ` · ${h(EXPRESSION[rc.expression])}` : ''}${rc.origin === 'manual' ? ' <span class="pe-chip">手动/导入</span>' : ''}${rc.seek ? ' <span class="pe-chip pe-chip-layer">由此开始追读</span>' : ''}`
          : ' · <span class="pe-muted">还没推演</span>'}
        ${rc?.ideas && !future ? `<div class="pe-ideas">${ideasHtml(rc.ideas)}</div>` : ''}${rc?.opinion && !(rc.readDate && st.currentDate && rc.readDate > st.currentDate) ? `<div class="pe-evi">${h(rc.opinion.summary || '')} ${dimsHtml(rc.opinion.dimensions)}${rc.opinion.authorView ? `<div>对作者：${h(rc.opinion.authorView)}</div>` : ''}</div>` : ''}
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
    let out = [];
    planSegments.info = null;
    if (by !== 'days') {
        const chat = globalThis.SillyTavern?.getContext?.()?.chat || [];
        const r = planFloorSegments(chat, { by, size, first, target, headChars: getSettings().headChars, includeHidden: getSettings().includeHidden !== false });
        out = r.segs;
        planSegments.info = { merged: r.merged, rejected: r.rejected };
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
    const chatAll = globalThis.SillyTavern?.getContext?.()?.chat || [];
    const hidN = chatAll.filter(m => m?.is_system && isStoryMessage(m, true)).length;
    const hidLine = hidN ? `<div class="pe-muted">聊天共 ${chatAll.length} 楼，其中隐藏了 ${hidN} 楼：${getSettings().includeHidden !== false ? '隐藏的楼层照样会读（按楼层分段时也算在内）' : '按设置不读隐藏的楼层（设置 · 故事日期 · 读取隐藏的楼层）'}。</div>` : '';
    return `<div class="pe-muted">从最早的作品（${h(pubs[0])}）起，按规则把到 ${h(st.currentDate)} 为止的经过推演一遍。可以按聊天楼层、文本量或故事天数分段，一段一段推，每段推完先看结果再继续。手动录入和导入的记录、已入账的都保留；之前推演出但没入账的会重新生成。</div>${hidLine}
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
    const fl = (st.factLeaks || []).filter(x => x.status === 'pending' && (!st.currentDate || cmp(x.date, st.currentDate) <= 0) && (st.privateFacts || []).some(f => f.id === x.factId));
    const factHtml = fl.length ? `<div class="pe-callout pe-callout-warn"><div><b>主角的私事可能被说出去（${fl.length}）</b> <span class="pe-muted">推演认为知情者可能在谈话里提到了。不会自动生效，由你决定。</span>
      ${fl.map(x => `<div class="pe-row">${h(x.date)} ${personTag(byId(st.persons, x.from))} → ${personTag(byId(st.persons, x.to))}：“${h(truncate((st.privateFacts.find(f => f.id === x.factId) || {}).text || '', 40))}”
        <button class="pe-mini" data-act="fleak-yes" data-id="${x.id}">确有其事</button><button class="pe-mini" data-act="fleak-half" data-id="${x.id}">说了但他不信</button><button class="pe-mini" data-act="fleak-no" data-id="${x.id}">没有</button></div>`).join('')}</div></div>` : '';
    if (!list.length) return factHtml;
    return `<div class="pe-callout pe-callout-warn"><div><b>可能的身份知情扩散（${list.length}）</b> <span class="pe-muted">推演认为有人可能在谈话里说出了作者是谁。不会自动生效，由你决定。</span>
      ${list.map(x => `<div class="pe-row">${h(x.date)} ${personTag(byId(st.persons, x.from))} → ${personTag(byId(st.persons, x.to))}：${penChip(st, x.pennameId)} 的身份（谈起${bt(byId(st.works, x.workId)?.title || '')}时）
        <button class="pe-mini" data-act="leak-yes" data-id="${x.id}">确有其事</button><button class="pe-mini" data-act="leak-no" data-id="${x.id}">没有</button></div>`).join('')}</div></div>` + factHtml;
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
    const who = e.unsigned ? `${outlet ? `《${h(outlet.name)}》` : ''}<span class="pe-muted">（未署名，执笔：</span>${person ? personTag(person) : h(e.personName || '?')}<span class="pe-muted">）</span>` : [outlet ? `《${h(outlet.name)}》` : '', person ? personTag(person) : h(e.personName || '')].filter(Boolean).join(' ');
    const whoText = who || (e.layer === 'mentions' ? '各报' : e.layer === 'reader_letters' ? '读者' : '');
    const sum = e.text?.summary || '';
    return `<div class="pe-card pe-ev ${major ? 'pe-card-major' : ''} pe-edge${agg ? 'n' : e.polarity}">
      <div class="pe-card-main">
        <div class="pe-card-top">
          <span class="pe-card-date">${h(e.date)}</span>${approxIssue(st, e) ? `<span class="pe-chip" title="月刊/半月刊没填出刊日：日期按每月 1 日（半月刊 1、15 日）约略推算。在刊物资料里填“出刊日”就准了">约 ${h(approxIssue(st, e))}</span>` : ''}<span class="pe-muted">${e.datePrecision ? { xun: '（只知道旬）', month: '（只知道月份）', noLaterThan: '（不晚于）' }[e.datePrecision] || '' : weekdayZh(e.date)}</span>
          <span class="pe-chip pe-chip-layer">${h(LAYERS[e.layer]?.label || e.layer)}</span>${pol}
          ${major && e.status === 'candidate' ? '<span class="pe-chip pe-chip-major">需确认</span>' : ''}
          ${e.origin === 'manual' ? '<span class="pe-chip">手动</span>' : ''}${e.auto ? '<span class="pe-chip">自动入账</span>' : ''}${e.reactsTo ? '<span class="pe-chip">回应前文</span>' : ''}${e.epiLetterId ? '<span class="pe-chip">来自书信簿</span>' : ''}${e.backfill ? '<span class="pe-chip" title="回溯推演补出来的，原记录里没有">回溯</span>' : ''}${e.epiSent ? `<span class="pe-chip pe-chip-layer" title="已寄进书信簿">✉ ${h(e.epiSent.code || e.epiSent.id)}</span>` : ''}${e.status === 'approved' && !knownToUser(st, e, getSettings()) && (!st.currentDate || e.date <= st.currentDate) ? (LAYERS[e.layer]?.public ? (ks => `<span class="pe-chip pe-chip-no" title="已经见报，但主角还没读到：不会注入主对话，NPC 也不会当作主角知道。可以在“设置 · 主角知道什么”里改规则，或点“主角已读到”">主角还没读到${ks ? '（约 ' + h(ks) + ' 经剪报得知）' : ''}</span>`)(knownSince(st, e, getSettings())) : `<span class="pe-chip pe-chip-no" title="别人之间的私信：主角不知道内容，也不会注入主对话">主角不知道${e.to && e.to !== 'protagonist' ? '（寄给 ' + h(e.to) + '）' : ''}</span>`) : ''}
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
        ${fieldHtml({ key: 'to', label: '私信的收信人', type: 'select', options: st => ({ protagonist: '主角', ...Object.fromEntries(st.persons.map(p => [p.name, p.name])) }), hint: '别人之间的信，主角不会自动知道' }, 'protagonist', st)}
        ${fieldHtml({ key: 'knownAt', label: '主角哪天得知（别人之间的信）', placeholder: 'YYYY-MM-DD，不知道就空' }, '')}
        ${fieldHtml({ key: 'summary', label: '内容概要', type: 'textarea', rows: 2 }, '')}
        ${fieldHtml({ key: 'approved', label: '直接入账', type: 'checkbox' }, true)}
      </div>
      <div class="pe-actions"><div class="pe-actions-extra"></div><button class="pe-primary" data-act="manual-add">录入</button></div>
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
      <button data-act="paper-open" title="把已入账的文章排成当时报纸文艺栏的样子，可以截图放进剧情">报纸版面</button>
      <button data-act="export-ledger">导出为文本</button>
    </div>
    ${items.map(e => evCard(st, e, `<button ${e.text?.body || ['mentions', 'reader_letters'].includes(e.layer) ? '' : 'class="pe-primary"'} data-act="write" data-id="${e.id}">${e.text?.body ? '重写' : '写稿'}</button>
        <details class="pe-more-acts"><summary>更多</summary>
          <button data-act="ev-summary" data-id="${e.id}">改概要</button>
          ${e.outletId && e.layer !== 'private_letter' ? `<button data-act="paper-open" data-id="${e.id}">在报纸版面上看</button>` : ''}
          <button data-act="ev-reply" data-id="${e.id}">安排一篇回应</button>
          ${e.status === 'approved' && !knownToUser(st, e, getSettings()) ? `<button data-act="ev-known" data-id="${e.id}" title="${LAYERS[e.layer]?.public ? '主角读到了这篇文章（自己看报、别人拿给他、剪报送到……）' : '主角从某个渠道得知了这封信的内容'}">${LAYERS[e.layer]?.public ? '主角已读到' : '主角已得知'}</button>` : ''}
          ${e.layer === 'private_letter' && e.text?.body ? `<button data-act="epi-send" data-id="${e.id}">${e.epiSent ? '在书信簿里：' + h(e.epiSent.code || e.epiSent.id) : '寄进书信簿'}</button>` : ''}
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
        const vis = list.filter(visible);
        const shown = vis.filter(r => r.read !== 'none' || !vis.some(x => x !== r && x.personId === r.personId && x.read !== 'none'));
        const cnt = k => shown.filter(r => r.read === k).length;
        const rows = shown.filter(r => r.read !== 'none').sort((a, b) => cmp(a.readDate || a.contactDate || '9', b.readDate || b.contactDate || '9')).map(r => {
            const p = byId(st.persons, r.personId);
            const future = r.readDate && st.currentDate && r.readDate > st.currentDate;
            return `<li class="pe-rd-row">${personTag(p, '?')} · ${h(CHANNELS[r.channel] || r.channel || '')} ${h(r.contactDate || '')}
              · ${future ? '尚未读到' : h(READ_STATES[r.read] || r.read)}${r.readDate && !future ? ' ' + h(r.readDate) : ''}
              ${!future && r.strength ? `· <span class="pe-pol pe-pol${r.polarity}">${['偏批评', '参半', '偏肯定'][r.polarity + 1]}</span> ${h(STRENGTH[r.strength])} ${statusChip(r)}` : ''}
              ${!future && r.expression ? `· ${h(EXPRESSION[r.expression])}` : ''}
              ${r.origin === 'manual' ? '<small class="pe-tag">手动</small>' : ''}${r.viaEventId ? '<small class="pe-tag">因评论得知</small>' : ''}
              ${!future && r.ideas ? `<div class="pe-ideas">${ideasHtml(r.ideas)}</div>` : ''}
              ${r.opinion ? `<div class="pe-evi">私下看法：${h(r.opinion.summary || '')}${r.opinion.understanding && r.opinion.understanding !== 'full' ? `（${r.opinion.understanding === 'partial' ? '部分理解' : '有误读'}）` : ''} ${dimsHtml(r.opinion.dimensions)}
                ${opinionDetail(r.opinion)}
                ${r.opinion.authorView ? `<div>对作者：${h(r.opinion.authorView)}</div>` : ''}${r.opinion.changeFromBefore ? `<div class="pe-muted">与以前相比：${h(r.opinion.changeFromBefore)}</div>` : ''}</div>` : ''}
              <details class="pe-why"><summary>为什么？</summary><ol>${(r.why || []).map(x => `<li>${h(x)}</li>`).join('')}</ol></details>
              ${!future && READ_DONE.includes(r.read) ? `<button class="pe-mini" data-act="gen-opinion" data-id="${r.id}">${r.opinion ? '重新生成看法' : '生成私下看法'}</button>` : ''}</li>`;
        }).join('');
        const key = 'rd:' + wid;
        const ops = shown.filter(r => r.opinion).length;
        return `<details class="pe-rd-work pe-colored" data-fold="${h(key)}" style="--c:${(w && penColor(st, w.pennameId)) || 'var(--pe-border)'}" ${foldOpen.has(key) || ledgerFilter ? 'open' : ''}>
          <summary><span class="pe-rd-title">${bt(w?.title || '?')} ${w ? penChip(st, w.pennameId) : ''}</span>
            <span class="pe-rd-stats"><span title="读完">读完 <b>${cnt('finished')}</b></span><span title="读了一部分">部分 <b>${cnt('skimmed')}</b></span>${cnt('unknown') ? `<span title="读过，程度不详">不详 <b>${cnt('unknown')}</b></span>` : ''}<span title="接触了但没读">未读 <b>${cnt('ignored')}</b></span>${ops ? `<span title="已生成私下看法">看法 <b>${ops}</b></span>` : ''}</span></summary>
          <div class="pe-muted pe-rd-note">截至今天：未接触 ${cnt('none')} · 接触未读 ${cnt('ignored')} · 读了一部分 ${cnt('skimmed')} · 读完 ${cnt('finished')}（尚未发生的阅读不显示）</div>
          <ul class="pe-list">${rows || '<li>暂无人读过。</li>'}</ul></details>`;
    }).join('');
    return `
    <section>
      <div class="pe-row"><span>筛选：</span><select id="pe-ledger-filter">${Object.entries(wopts).map(([k, v]) => `<option value="${h(k)}" ${k === ledgerFilter ? 'selected' : ''}>${h(v)}</option>`).join('')}</select>
        <span class="pe-spacer"></span><button class="pe-mini" data-act="fold-all" data-open="1">全部展开</button><button class="pe-mini" data-act="fold-all" data-open="0">全部折叠</button></div>
      <p><small>阅读记录是私下的：谁读了、读了多少、怎么看，大多不会公开。只有“表达”一关产生的文章、私信才会进入候选和账本。“生成私下看法”才会调用模型；写稿时也会自动补上。</small></p>
    </section>
    <div class="pe-rd-list">${blocks || '<p>还没有阅读记录。设定故事日期并推进后会产生。</p>'}</div>
    <section>
      <h4>手动记录一次阅读</h4>
      <p><small>例如书信或剧情里已经写明“某人某日读过某作品”。记录后会从这里继续推演他的看法和表达。</small></p>
      <div class="pe-form" id="pe-manual-read">
        ${fieldHtml({ key: 'workId', label: '作品', type: 'select', options: optsOf(x => x.works, 'title') }, '', st)}
        ${fieldHtml({ key: 'personId', label: '人物', type: 'select', options: optsOf(x => x.persons) }, '', st)}
        ${fieldHtml({ key: 'date', label: '日期', placeholder: 'YYYY-MM-DD' }, st.currentDate)}
        ${fieldHtml({ key: 'read', label: '读到什么程度', type: 'select', options: { finished: '读完', skimmed: '读了一部分', unknown: '读过，不知道读了多少' } }, 'finished')}
        ${fieldHtml({ key: 'note', label: '依据' }, '')}
      </div>
      <div class="pe-actions"><div class="pe-actions-extra"></div><button class="pe-primary" data-act="manual-read">记录</button></div>
    </section>`;
}

const TRUST = { 0.3: '低', 0.6: '中', 0.9: '高' };

// ———— 小表格编辑器：议题立场、文体偏好、作品主张 ————
const TABLES = {
    stances: {
        label: '思想立场', key: 'issue',
        hint: '具体议题上支持还是反对、有多在意。推演会拿它和作品的“主张”对照，得出赞同、部分赞同或反对；议题名尽量和作品主张用同一个词',
        cols: [
            { k: 'issue', ph: '议题，如 死刑', w: '9em' },
            { k: 'side', type: 'select', opts: { pro: '支持', con: '反对', mixed: '有保留' } },
            { k: 'strength', type: 'select', opts: { 1: '在意：低', 2: '在意：中', 3: '在意：高' }, num: true, def: 2 },
            { k: 'note', ph: '具体立场', grow: true },
            { k: 'source', ph: '依据（史实/书信/推测）', w: '9em' },
        ],
    },
    stylePrefs: {
        label: '文体偏好', key: 'aspect',
        hint: '读作品时在意的写法。只是倾向，不参与推演计算；生成看法时，必须在原文里找到对应的段落才会提出这方面的评价',
        cols: [
            { k: 'aspect', ph: '项目，如 解释密度', w: '9em', list: 'pe-style-aspects' },
            { k: 'leaning', ph: '倾向，如 不喜欢已说清的观点被反复解释', grow: true },
            { k: 'tolerance', type: 'select', opts: { 1: '难以容忍', 2: '视情况', 3: '宽容' }, num: true, def: 2 },
            { k: 'source', ph: '依据', w: '8em' },
        ],
    },
    claims: {
        label: '作品的主张', key: 'issue',
        hint: '作品在哪些议题上表明了什么立场。“大体反对、但保留例外”选“有保留”。议题名尽量和人物立场用同一个词',
        cols: [
            { k: 'issue', ph: '议题，如 死刑', w: '9em' },
            { k: 'side', type: 'select', opts: { pro: '支持', con: '反对', mixed: '有保留' } },
            { k: 'note', ph: '作品具体怎么说', grow: true },
            { k: 'where', ph: '出处', w: '7em' },
        ],
    },
};
function tblRow(name, r = {}, isNew = false) {
    const T = TABLES[name];
    return `<div class="pe-tbl-row ${isNew ? 'pe-tbl-new' : ''}" style="grid-template-columns:${T.cols.map(c => c.grow ? 'minmax(8em,1fr)' : c.w || 'auto').join(' ')} auto">
      ${T.cols.map(c => c.type === 'select'
        ? `<select class="text_pole" data-c="${c.k}">${Object.entries(c.opts).map(([k, v]) => `<option value="${k}" ${String(r[c.k] ?? c.def ?? '') === String(k) ? 'selected' : ''}>${v}</option>`).join('')}</select>`
        : `<input type="text" class="text_pole" data-c="${c.k}" value="${h(r[c.k] ?? '')}" placeholder="${h(c.ph || '')}" ${c.list ? `list="${c.list}"` : ''}>`).join('')}
      <button class="menu_button pe-mini" data-act="tbl-del" title="删除">✕</button></div>`;
}
function tableEditor(name, list, draftAct = '', draftId = '') {
    const T = TABLES[name];
    return `<div class="pe-field pe-wide pe-tbl" data-tbl="${name}"><label>${T.label} <small class="pe-muted">${T.hint}</small></label>
      <div class="pe-tbl-rows">${(list || []).map(r => tblRow(name, r)).join('')}</div>
      <div class="pe-row"><button class="menu_button" data-act="tbl-add" data-tbl="${name}">＋ 添加一行</button>${draftAct ? `<button class="menu_button" data-act="${draftAct}" data-id="${h(draftId)}" title="调用模型起草，只添加还没有的条目；保存前可以修改或删除">✦ 让 AI 起草</button>` : ''}</div>
      ${name === 'stylePrefs' ? `<datalist id="pe-style-aspects">${STYLE_CHECKLIST.map(([a]) => `<option value="${a}">`).join('')}</datalist>` : ''}</div>`;
}
function readTable(root, name) {
    const T = TABLES[name];
    const box = root.querySelector(`.pe-tbl[data-tbl="${name}"]`);
    if (!box) return null;
    return [...box.querySelectorAll('.pe-tbl-row')].map(row => Object.fromEntries(T.cols.map(c => { const v = row.querySelector(`[data-c="${c.k}"]`)?.value ?? ''; return [c.k, c.num ? Number(v) : String(v).trim()]; })))
        .filter(r => String(r[T.key] || '').trim());
}
/** 把模型起草的条目加进编辑器（已有同名条目的不动） */
function addDrafted(name, rows) {
    const box = document.querySelector(`.pe-editor .pe-tbl[data-tbl="${name}"]`);
    if (!box) return 0;
    const key = TABLES[name].key;
    const have = new Set((readTable(document.querySelector('.pe-editor'), name) || []).map(r => String(r[key]).replace(/\s/g, '').toLowerCase()));
    let n = 0;
    for (const r of rows) {
        if (have.has(String(r[key]).replace(/\s/g, '').toLowerCase())) continue;
        box.querySelector('.pe-tbl-rows').insertAdjacentHTML('beforeend', tblRow(name, r, true)); n++;
    }
    return n;
}
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
      <label title="自己知道笔名背后是谁时，肯不肯告诉他"><input type="checkbox" data-r="discloseIdentity" ${r.discloseIdentity ? 'checked' : ''}> 可能说出作者身份与私事</label>
      <input type="text" data-r="since" class="text_pole" value="${h(r.since || '')}" placeholder="从（可空）" title="关系从哪天开始，例如搬来同住、初次结识" style="width:7.5em">
      <input type="text" data-r="until" class="text_pole" value="${h(r.until || '')}" placeholder="到（可空）" title="哪天起断了往来" style="width:7.5em">
      <label title="双方都算这层关系（家人默认双方都算）。不勾就是单向：只有他把对方当熟人"><input type="checkbox" data-r="mutual" ${isMutual(r) ? 'checked' : ''}> 双方都算</label>
      <select data-r="basis" class="text_pole" title="这层关系有什么依据；推测的在关系图上画虚线">${opt({ '': '依据？', ...REL_BASIS }, r.basis || '')}</select>
      <input type="text" data-r="evidence" class="text_pole" value="${h(r.evidence || '')}" placeholder="依据（如：5-13 茶室同桌；1884 决斗、1888 和解）" style="flex:1 1 16em">
      <button class="menu_button pe-mini" data-act="rel-del" title="删除">✕</button></div>`;
}
function relationsEditor(obj, st) {
    const incoming = st.persons.filter(p => p.id !== obj.id && (p.relations || []).some(r => r.to === obj.id));
    return `<div class="pe-field pe-wide"><label>熟人关系 <small class="pe-muted">有方向：这里写的是“${h(obj.name || '此人')}对别人”；勾“双方都算”就两边都生效。见面越勤、越亲近，读到的东西越可能谈起；同一刊物的同事不填也会按“每周见、一般熟”算</small></label>
      <div class="pe-rel-list" data-self="${obj.id}">${(obj.relations || []).map(r => relRow(st, obj, r)).join('')}</div>
      <div class="pe-row"><button class="menu_button" data-act="rel-add">＋ 添加关系</button>
      ${incoming.length ? `<small class="pe-muted">反过来，把${h(obj.name || '此人')}列为熟人的有：${incoming.map(p => personTag(p)).join('、')}</small>` : ''}</div></div>`;
}
function readRelations(root) {
    return [...root.querySelectorAll('.pe-rel-row')].map(row => {
        const g = k => row.querySelector(`[data-r="${k}"]`);
        return { to: g('to').value, type: g('type').value, closeness: +g('closeness').value, frequency: g('frequency').value, trust: +g('trust').value, discloseOpinions: g('discloseOpinions').checked, discloseIdentity: g('discloseIdentity').checked, since: normalizeISO(g('since').value) || '', until: normalizeISO(g('until').value) || '', mutual: g('mutual').checked, basis: g('basis').value, evidence: g('evidence').value.trim() };
    }).filter(r => r.to);
}

function listBlock(title, kind, list, spec, st, labelFn, styleFn = null, extra = '', actionsFn = null) {
    const isEdit = editing && editing.kind === kind;
    const isNew = isEdit && !list.some(x => x.id === editing.id);
    const editor = o => { if (!o) return ''; const obj = kind === 'penname' && !o.color ? { ...o, color: penColor(st, o.id) || PEN_PALETTE[st.pennames.length % PEN_PALETTE.length] } : kind === 'work' ? { ...o, sourceText: srcOf(st, o) } : o; return `<div class="pe-editor" data-kind="${kind}">
          <div class="pe-editor-head">${isNew ? `新建${title}` : `编辑${title}：<b>${h(obj.title || obj.name || '')}</b>`}</div>
          ${formHtml(spec, obj, st)}
          ${kind === 'person' ? tableEditor('stances', obj.stances, 'draft-person', obj.id) + tableEditor('stylePrefs', obj.stylePrefs) + relationsEditor(obj, st) : ''}
          ${kind === 'work' ? tableEditor('claims', obj.claims, 'draft-claims', obj.id) : ''}
          <div class="pe-actions">
            <div class="pe-actions-extra">${kind === 'work' && !isNew ? `<button data-act="fact-new" data-work="${obj.id}" title="作者为什么这样写——默认谁都不知道，只给你登记的知情者">＋ 创作意图</button>` : ''}${kind === 'person' && !isNew ? `<button data-act="reroll-person" data-id="${obj.id}" title="按编辑框里的新资料（立场、常读刊物、私交、熟人……）重新推演此人还没入账的阅读和反响。不调用 AI">按新资料重推此人</button>` : ''}${kind === 'work' && !isNew ? `<button data-act="reroll-work" data-id="${obj.id}" title="资料改动后，重新推演尚未批准的回应">按新资料重推</button><button data-act="gen-card" data-id="${obj.id}" title="先保存原文，再生成">生成证据卡</button>` : ''}</div>
            <button data-act="cancel-edit">取消</button><button class="pe-primary" data-act="save-item" data-kind="${kind}">保存</button></div>
          ${kind === 'work' && obj?.evidence ? `<details><summary>证据卡（${h(obj.evidence.builtAt?.slice(0, 10) || '')}，${(obj.evidence.keyPoints || []).length} 条${obj.evidence.stale ? '，原文已更新，建议重新生成' : ''}）</summary><div class="pe-text">${h(cardText(obj.evidence, 6000)).replace(/\n/g, '<br>')}</div></details>` : ''}</div>`; };
    return `
    <section>
      <h4>${title} <span class="pe-count pe-count-dim">${list.length}</span><span class="pe-spacer"></span>${isNew ? '' : `<button data-act="new-item" data-kind="${kind}">＋ 新增${title}</button>`}</h4>
      ${extra}
      ${isNew ? editor(editing.draft) : ''}
      ${list.map(x => (isEdit && editing.id === x.id) ? editor(x) : `<div class="pe-card pe-card-slim pe-li-item ${styleFn ? 'pe-colored' : ''}" data-find="${h(findText(x, st))}" ${styleFn ? `style="--c:${styleFn(x)}"` : ''}><div class="pe-card-main">${labelFn(x)}</div><div class="pe-card-actions pe-card-actions-row">${actionsFn ? actionsFn(x) : ''}
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
        ${txtPlan.length ? `<button data-act="txt-clear">清空</button><button class="pe-primary" data-act="txt-commit">导入 ${txtPlan.filter(r => r.action !== 'skip').length} 个</button>
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
        + ideasBlock(st)
        + listBlock('作品', 'work', [...st.works].sort((a, b) => cmp(a.pubDate || '9', b.pubDate || '9')), WORK_SPEC, st, w => `${penChip(st, w.pennameId)} <b>${bt(w.title)}</b> <small>${h(FORMS[w.form] || '')} · ${h(byId(st.outlets, w.outletId)?.name || '')} · ${h(w.pubDate || '未定日期')}${w.datePrecision ? ({ xun: '（只知道旬）', month: '（只知道月份）', noLaterThan: '（不晚于）' }[w.datePrecision] || '') : ''}${srcLen(st, w) ? ` · 原文 ${srcLen(st, w)} 字` : ''}${w.evidence ? ' · 有证据卡' : ''}${(w.claims || []).length ? ` · 主张 ${w.claims.length}` : ''}</small>`, w => penColor(st, w.pennameId) || 'var(--pe-border)', st.pennames.length > 1 ? `<div class="pe-legend">${st.pennames.map(p => penChip(st, p.id)).join('')}</div>` : '', w => `<button data-act="tl-work" data-id="${w.id}" title="这部作品到今天为止的反响：谁哪天读到、哪天见报、哪天来信、在哪里被谈起">时间线</button><button class="pe-primary" data-act="sim-work" data-id="${w.id}" title="谁可能读到、会怎么反应；也可以假设改投别的刊物">推演</button>`)
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
    return factsBlock(st) + `<div class="pe-toolbar"><button class="pe-primary" data-act="nw-open" title="谁和谁相熟、谁把作品推荐给了谁、身份可能从谁那里泄露">人物关系网</button><button class="pe-primary" data-act="pc-open" title="主角怎么看自己、以为别人怎么看他；别人实际怎么看；各读者圈子公开怎么说——哪里对不上">认知对照</button></div>` + suggestBlock(st) + relSuggestBlock(st) + loreBlock(st) + conceptsBlock(st) + outletCheckBlock(st) + listBlock('刊物', 'outlet', st.outlets, OUTLET_SPEC, st, o => `<b>${h(o.name)}</b> <small>${h(PERIODICITY[o.periodicity] || '')}${o.periodicity === 'weekly' && Number.isInteger(o.weekday) ? '·' + WEEKDAYS[o.weekday] : ''} · ${h(CIRCLES[o.circle] || '')} · ${h(tagsToText(o.politics))}</small>`)
        + listBlock('人物', 'person', [...st.persons].sort((a, b) => closeOf(b) - closeOf(a)), PERSON_SPEC, st, p => `${personTag(p)} <span class="pe-chip pe-close-chip" style="--c:${CLOSE_COLOR[closeOf(p)]}">${CLOSE[closeOf(p)]}</span> <small>${(p.roles || []).map(r => ROLES[r]).join('/')} · ${(p.outletIds || []).map(id => byId(st.outlets, id)?.name).filter(Boolean).join('、') || '无供稿刊物'} ${(p.relations || []).length ? ` · 熟人 ${(p.relations || []).length}` : ''}${(p.stances || []).length ? ` · 立场 ${p.stances.length}` : ''}${(p.stylePrefs || []).length ? ` · 文体偏好 ${p.stylePrefs.length}` : ''}${p.knowsIdentity ? ' · 知道笔名身份' : ''}${p.real ? ' · 真实人物' : ''}${p.active === false ? ' · 不参与推演' : ''}</small>`, p => CLOSE_COLOR[closeOf(p)], `<div class="pe-muted">颜色表示与主角的私交，按私交从深到浅排列：</div>${closeLegend()}`, p => `<button class="pe-primary" data-act="sim-person" data-id="${p.id}" title="此人和作者作品的关系；假如他读到某部作品会怎样">推演</button>`);
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
      ${asArr(prof.periodNews).length ? eraBlock(`本期新事${prof.period ? '（' + h(periodLabel(prof.period)) + '）' : ''}`, eraEvents(asArr(prof.periodNews).map(x => (typeof x === 'string' ? { event: x } : { date: x.date, event: `${x.kind ? '［' + x.kind + '］' : ''}${x.text || ''}` }))), { count: asArr(prof.periodNews).length }) : ''}
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
      ${editing?.kind === 'era' ? `<textarea id="pe-era-json" rows="16">${h(JSON.stringify(prof, null, 2))}</textarea><div class="pe-actions"><div class="pe-actions-extra"></div><button data-act="cancel-edit">取消</button><button class="pe-primary" data-act="era-save-json">保存</button></div>` : ''}
      ${prof && editing?.kind !== 'era' ? eraView(prof) : ''}
      ${(st.eraHistory || []).length ? `<details class="pe-fold"><summary>往期档案（${st.eraHistory.length}）</summary>${st.eraHistory.slice().reverse().map(x => `<div class="pe-card pe-card-slim"><div class="pe-card-main"><b>截至 ${h(x.asOf || '')}</b>${x.period ? ` <span class="pe-muted">${h(periodLabel(x.period))}</span>` : ''}<div>${h(x.summary || '')}</div>${(x.periodNews || []).length ? `<div class="pe-muted">${x.periodNews.map(n => `${h(n.date || '')} ${h(n.text || '')}`).join('；')}</div>` : ''}</div></div>`).join('')}</details>` : ''}
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
      <ul class="pe-list pe-era-notes">${st.eraNotes.map((n, i) => `<li><b>${h(n.title || '笔记')}</b>：${h(truncate(n.text, 300))} <button class="pe-mini" data-act="note-del" data-i="${i}">删除</button></li>`).join('')}</ul>
      <div class="pe-row"><input id="pe-note-title" type="text" placeholder="标题" style="width:8em"><input id="pe-note-text" type="text" placeholder="内容" style="flex:1"><button data-act="note-add">添加</button></div>
    </section>`;
}

const KIND_LABEL = { pennames: '笔名', outlets: '刊物', persons: '人物', works: '作品', reactions: '已发生的反响', readings: '阅读记录', rumors: '传闻', eraNotes: '年代笔记', privateFacts: '主角的私人信息', selfImage: '主角的自我认知', assumed: '主角以为别人怎么看他', perceptions: '别人对作者的看法', creativeProjects: '创作构想', ideaDiscussions: '灵感讨论' };
const estCalls = () => materials.reduce((n, m) => n + chunkMaterial(m.text).length, 0);

// ———— 整理指针：记住聊天已经整理到哪一楼（楼号即酒馆的 #编号） ————
const mesHash = m => { const t = String(m?.mes || '').slice(0, 400); let x = 0x811c9dc5; for (let i = 0; i < t.length; i++) { x ^= t.charCodeAt(i); x = Math.imul(x, 0x01000193) >>> 0; } return x.toString(36); };
const chatNow = () => globalThis.SillyTavern?.getContext?.()?.chat || [];
/** 指针现在指向哪一楼：楼层删过、换过回复时，按那一楼的内容在附近找回来 */
function orgPointer(st) {
    const chat = chatNow();
    const mk = st.orgMark;
    if (!mk) return { mes: -1, fresh: chat.length, ok: true, none: true };
    let mes = mk.mes, ok = chat[mes] && mesHash(chat[mes]) === mk.hash;
    if (!ok && mk.hash) for (let d = 1; d <= 80 && !ok; d++) for (const j of [mk.mes - d, mk.mes + d]) if (chat[j] && mesHash(chat[j]) === mk.hash) { mes = j; ok = true; break; }
    if (mes > chat.length - 1) mes = chat.length - 1;
    return { mes, fresh: Math.max(0, chat.length - 1 - mes), ok, moved: ok && mes !== mk.mes };
}
function setOrgMark(st, mes, why = '') {
    const chat = chatNow();
    if (mes < 0) { st.orgMark = null; return; }
    mes = Math.min(mes, chat.length - 1);
    st.orgMark = { mes, hash: mesHash(chat[mes]), at: new Date().toISOString(), story: st.currentDate || '', why };
}
function chatMaterial(from, to, label) {
    const chat = chatNow();
    const inc = getSettings().includeHidden !== false;
    const msgs = chat.slice(from, to + 1);
    const hid = msgs.filter(m => m?.is_system && isStoryMessage(m, true)).length;
    const o = chatOpts();
    const cov = o.source === 'summary' ? summaryCoverage(msgs, inc, o.tags) : null;
    const text = chatToText(msgs, inc, o);
    const sumNote = cov ? (cov.withSummary ? `，${cov.withSummary}/${cov.total} 楼只读摘要，原文 ${(cov.fullChars / 10000).toFixed(1)} 万字 → ${(text.length / 10000).toFixed(1)} 万字` : '，没找到摘要块，读全文') : '';
    return { id: uid(), label: `${label}（#${from}–#${to}，${msgs.length} 楼${hid ? (inc ? `，含隐藏 ${hid} 楼` : `，不含隐藏的 ${hid} 楼`) : ''}${sumNote}）`, kind: '聊天记录', text, range: { from, to } };
}
function pointerBlock(st) {
    const chat = chatNow();
    if (!chat.length) return '';
    const p = orgPointer(st);
    const mk = st.orgMark;
    const when = mk?.at ? new Date(mk.at).toLocaleString('zh-CN', { hour12: false }) : '';
    const status = p.none ? '还没整理过当前聊天（或没记下来）' : `已整理到 <b>#${p.mes}</b>${mk.story ? `（故事日期 ${h(mk.story)}）` : ''}<span class="pe-muted">，${h(when)}${mk.why ? ' · ' + h(mk.why) : ''}</span>${p.moved ? `<span class="pe-muted">（楼层有增删，按内容找回到 #${p.mes}）</span>` : ''}${!p.ok ? '<span class="pe-warn">（原来那一楼的内容变了：删过楼或换过回复，请确认指针位置）</span>' : ''}`;
    return `<div class="pe-callout pe-callout-accent pe-orgptr"><div>📍 整理指针：${status}。之后新增 <b>${p.fresh}</b> 楼（共到 #${chat.length - 1}）。</div>
      <div class="pe-actions"><div class="pe-actions-extra"><input id="pe-org-mark" type="number" min="-1" max="${chat.length - 1}" placeholder="楼号" style="width:7em"><button data-act="org-mark-set" title="把指针设到这一楼：表示这一楼及之前都已经整理过（比如你刚导入了外面整理好的整理包）">设到这一楼</button><button data-act="org-mark-end" title="当前所有楼层都已整理过">设为最新一楼</button>${mk ? '<button data-act="org-mark-clear">清除</button>' : ''}</div>
      <button class="pe-primary" data-act="org-continue" ${p.fresh ? '' : 'disabled'} title="把指针之后的新楼层加入材料；整理结果应用后，指针自动移到最新一楼">从指针处继续（${p.fresh} 楼）</button></div></div>`;
}

function organizerBlock(st) {
    const calls = estCalls();
    const chars = materials.reduce((n, m) => n + m.text.length, 0);
    return `${st.pendingBundle ? bundlePreview(st) : ''}
    <section class="pe-drop" id="pe-org-drop">
      <h4>一键整理 <span class="pe-muted">把材料放进来，交给已连接的模型整理成人物、刊物、作品和已发生的反响</span></h4>
      ${pointerBlock(st)}
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
          ${orgAbort ? '<button data-act="org-stop">停止</button>' : `<button data-act="org-clear">清空材料</button><button class="pe-primary" data-act="org-run">开始整理</button>`}</div>` : ''}
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
      <h4>整理结果预览 <span class="pe-spacer"></span><button data-act="bundle-drop">丢弃</button><button data-act="bundle-download">下载整理包</button><button class="pe-primary" data-act="bundle-apply">应用</button></h4>
      <div class="pe-muted">确认后才会写进数据。按名字合并：已有的只补充和更新，不会删除你填过的内容；导入的反响记为“已发生”，直接入账。</div>
      ${b.storyDate ? `<div class="pe-callout">故事日期 <b class="pe-num">${h(b.storyDate)}</b>${b.place ? ` · ${h(b.place)}` : ''}
        <select id="pe-bundle-datemode"><option value="set">直接设为当前日期（之前的反响以整理包为准，不再推演）</option><option value="none">不改日期</option></select></div>` : ''}
      <div class="pe-stats pe-bundle-stats">${kinds.map(k => `<label class="pe-stat"><span><input type="checkbox" class="pe-bundle-kind" value="${k}" checked> ${KIND_LABEL[k]}</span>
        <b>${pv.counts[k].new + pv.counts[k].update}</b><span>${pv.counts[k].update ? `新建 ${pv.counts[k].new} · 更新 ${pv.counts[k].update}` : k === 'reactions' || k === 'readings' ? '记为已发生' : '新建'}</span></label>`).join('') || '<div class="pe-empty-sm">整理包是空的。</div>'}</div>
      ${pv.stale.length || st.persons.length ? `<div class="pe-callout ${pv.stale.length ? 'pe-callout-warn' : ''}"><div><label class="pe-check-inline"><input type="checkbox" id="pe-bundle-sync" checked> <b>以这份整理包为准</b>（导入新版整理包时用）</label>
        <div class="pe-muted">勾选：人物的关注、欣赏、反感、供稿与常读刊物、熟人关系，刊物的刊期和倾向，作品的题材，都换成新版的写法（不勾选则只补充、不替换，旧标签和旧关系会留着）；以前导入的阅读记录按新版重建${pv.stale.length ? `；并删除以前导入、但新版已经没有的 ${pv.stale.length} 条已发生反响` : ''}。你手动录入的反响不受影响。</div>
        ${pv.stale.length ? `<ul class="pe-era-ul">${pv.stale.slice(0, 20).map(x => `<li>${h(x)}</li>`).join('')}</ul>` : ''}</div></div>` : ''}
      ${pv.warnings.length ? `<div class="pe-callout pe-callout-warn"><div><b>注意（${pv.warnings.length}）</b><ul class="pe-era-ul">${pv.warnings.slice(0, 30).map(w => `<li>${h(w)}</li>`).join('')}</ul></div></div>` : ''}
      <div class="pe-muted">发现错的地方：展开下面的分类，点“改”直接修改这一条，或点 ✕ 删掉。改名字时，整理包里其他地方的引用会一起改；改成和另一条同名会自动合并。<button class="pe-linkbtn" data-act="bundle-edit-all">直接编辑整个整理包的 JSON</button></div>
      ${bundleEdit?.all ? `<div class="pe-editor"><div class="pe-editor-head">编辑整个整理包（JSON）</div><textarea id="pe-bundle-json" class="text_pole" rows="18" spellcheck="false">${h(JSON.stringify(Object.fromEntries(Object.entries(b).filter(([k]) => k !== 'warnings')), null, 2))}</textarea>
        <div class="pe-actions"><div class="pe-actions-extra"></div><button data-act="bitem-cancel">取消</button><button class="pe-primary" data-act="bundle-save-json">保存</button></div></div>` : ''}
      ${kinds.map(k => `<details class="pe-era-sec" ${bundleEdit?.k === k ? 'open' : ''}><summary>${KIND_LABEL[k]} <span class="pe-count pe-count-dim">${(b[k] || []).length}</span></summary>
        <div class="pe-blist">${(b[k] || []).map((x, i) => {
            const info = pv.items[k]?.[i] || { name: x.text || x.title || x.name, exists: false };
            const editingThis = bundleEdit && bundleEdit.k === k && bundleEdit.i === i;
            return `<div class="pe-bitem ${editingThis ? 'pe-bitem-on' : ''}"><span class="pe-chip ${info.exists ? '' : 'pe-chip-layer'}">${info.exists ? (k === 'reactions' ? '已有' : '更新') : '新建'}</span>
              <span class="pe-bitem-name">${h(truncate(info.name || '', 90))}</span>${bitemHint(k, x)}
              <span class="pe-spacer"></span><button class="pe-mini" data-act="bitem-edit" data-k="${k}" data-i="${i}">改</button><button class="pe-mini" data-act="bitem-del" data-k="${k}" data-i="${i}" title="从整理包里删掉这一条">✕</button></div>
              ${editingThis ? bitemEditor(k, x) : ''}`;
        }).join('')}</div></details>`).join('')}
      <div class="pe-toolbar pe-actions"><div class="pe-actions-extra"></div><button class="pe-primary" data-act="bundle-apply">应用整理结果${txtPlan.length ? `（并导入 ${txtPlan.filter(r => r.action !== 'skip').length} 个作品原文）` : ''}</button></div>
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
                materials.push({ id: uid(), label: f.name, kind: '聊天记录', text: chatToText(rows, getSettings().includeHidden !== false, chatOpts()) });
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
            const bundleHit = !pf.date && (st.pendingBundle?.works || []).some(w => planImport({ works: [{ id: 'x', title: w.title }], outlets: [] }, f.name, '').action === 'update');
            if (pf.date || planImport(st, f.name, text).action === 'update' || bundleHit) {
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
    const epiOn = getSettings().epiEnabled !== false;
    const epi = epiOn && epistolaryAvailable();
    const src = archiveSource();
    const binfo = backupInfo();
    const hints = (st.epiHints || []).filter(x => !x.handled);
    const scope = epi ? effectiveScope(st) : '';
    const arts = epi ? listArticles(st) : [];
    const workOpts = sel => `<option value="">（选择作品）</option>${st.works.map(w => `<option value="${h(w.id)}" ${w.id === sel ? 'selected' : ''}>${h(w.title)}</option>`).join('')}`;
    const dirName = { from_user: '主角寄出', to_user: '寄给主角', third_party: '第三方之间' };
    return organizerBlock(st) + `
    ${epiOn ? `<section>
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
    </section>` : ''}` : `<section><h4>书信簿（st-epistolary）联动</h4><div class="pe-muted">已关闭。打开后可以读取书信簿的信件和文章稿、跟随书信簿的剧情日期。<button class="pe-mini" data-act="epi-on">打开</button></div></section>`}
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
    { key: 'autoAdvanceMode', label: '自动推演', type: 'select', options: { interval: '故事时间每过 N 天推演一次', every: '每次识别到新日期都推演', off: '不自动，只在我点“一键推演”时' }, hint: '推演间隔长短不影响谁会读、怎么看，只影响反响多久出现在待审核和主对话里' },
    { key: 'autoAdvanceDays', label: '间隔（故事天数）', type: 'number', hint: '7 = 一周，14 = 半个月，30 = 一个月' },
    { key: 'autoApprove', label: '自动通过', type: 'select', options: { minor: '次要事件自动通过', none: '全部手动审核' }, hint: '次要事件＝转载提及、读者来信、短讯、书讯、虚构人物私信。正式书评、论战、真实人物私信始终需要你确认' },
    { key: 'loreEnabled', label: '写进世界书', type: 'checkbox', hint: '把人物的立场、私交、读过哪些作品和私下看法，以及作品资料，写成世界书条目；聊天里提到此人、此作品时才进入上下文，主对话里的 NPC 就会按推演结果说话' },
    { key: 'loreAuto', label: '数据有变化时自动同步', type: 'checkbox', hint: '推演、审核、改资料之后几秒自动写入；关掉则只在“人物与刊物”页手动同步' },
    { key: 'loreBook', label: '世界书名称', placeholder: '报刊回声', hint: '没有就新建。只改动标题以【报刊回声】开头的条目' },
    { key: 'loreScope', label: '写进哪些人物', type: 'select', options: { involved: '读过作品、登记了立场或与主角相识的人', all: '人物表里的所有人' } },
    { key: 'loreWorks', label: '作品也写进去', type: 'checkbox', hint: '作品条目只写公开信息：署名、刊物、内容和已见报的反响' },
    { key: 'loreMaxChars', label: '每个人物条目最多多少字', type: 'number', hint: '超出时先省略最早读过的作品。0 = 不限。中文约 1–1.5 字一个 token，1500 字大约 1000–1500 token' },
    { key: 'loreBindChat', label: '自动设为本聊天的世界书', type: 'checkbox', hint: '本聊天还没绑定世界书时，把它绑上；已经绑了别的世界书，就请你在酒馆里全局启用它' },
    { key: 'epiEnabled', label: '书信簿（st-epistolary）联动', type: 'checkbox', hint: '关掉后不读书信簿的日期、信件和文章稿，“导入与整理”页的书信簿部分也会收起' },
    { key: 'epiSyncDate', label: '书信簿推算出更晚的剧情日期时一并采用', type: 'checkbox' },
    { key: 'epiSendAuto', label: '私信自动寄进书信簿', type: 'checkbox', hint: '入账并写好正文的私信，作为“寄给主角”的来信放进书信簿（需要书信簿插件正在运行）。真实人物默认只写立场摘要，那种不会寄' },
    { key: 'maxJumpDays', label: '单次最多前进天数', type: 'number', hint: '超过此跨度的日期视为回忆或引述，忽略' },
    { key: 'headChars', label: '消息开头多少字内的日期优先', type: 'number' },
    { key: 'intensity', label: '公开发表意愿（0–1）', type: 'number', step: 0.05, hint: '默认 0.5。只影响“读了、有看法之后愿不愿意公开写”，接触和阅读不受影响' },
    { key: 'rumorHalfLife', label: '传闻半衰期（天）', type: 'number' },
    { key: 'knowPublic', label: '公开见报的文章，主角怎么知道', type: 'select', options: { reads: '常读的当天，其余靠剪报', all: '见报当天就知道（旧）', marked: '只算我标了读到的' }, hint: '见报不等于主角读到。“常读”在刊物资料里勾；不看报的主角选“只算我标了读到的”。剧情里录入的、转到主角手上的读者来信不受影响；整理材料时聊天里提到了推演里的某篇文章，会自动标为读到；也可以在账本里点“主角已读到”' },
    { key: 'clipDays', label: '剪报几天后送到', type: 'number', hint: '0 = 没有剪报服务：不常读的报刊上的文章（包括各报转载汇总），主角要等聊天里提到或你标记才知道' },
    { key: 'panelOpacity', label: '面板不透明度', type: 'range', min: 0, max: 100, step: 5, unit: '%', hint: '拖动时立刻生效。100% 完全挡住后面的聊天文字；0% 完全跟随酒馆主题（主题半透明时会透出后面的字）' },
    { key: 'chatSource', label: '整理聊天时读什么', type: 'select', options: { summary: '有摘要块的楼只读摘要（省 token）', full: '读全文' }, hint: '一键整理、AI 补完参考最近剧情时用。摘要模式下，每楼开头认出的故事日期会标在摘要前面；没有摘要块的楼（主角的发言、旧楼层）照旧读全文。回溯分段认日期始终读全文' },
    { key: 'summaryTags', label: '摘要块的标签名', hint: '如 Narrative_Matrix，就读 <Narrative_Matrix>…</Narrative_Matrix> 里的内容。多个用逗号分隔' },
    { key: 'includeHidden', label: '读取隐藏的楼层', type: 'checkbox', hint: '用“隐藏楼层”省 token 时，被隐藏的楼层仍然是剧情：回溯推演分段、一键整理当前聊天、AI 补完参考的最近剧情都会读它们。关掉就只读没隐藏的' },
    { key: 'injectEnabled', label: '向主对话注入报刊现状', type: 'checkbox' },
    { key: 'injectPosition', label: '注入位置', type: 'select', options: { 0: '系统提示词内', 1: '聊天内（按深度）', 2: '最前面' }, numeric: true },
    { key: 'injectDepth', label: '注入深度', type: 'number' },
    { key: 'injectMaxItems', label: '注入最近几条反响', type: 'number' },
    { key: 'injectMaxRumors', label: '注入几条传闻', type: 'number', hint: '按热度取前几条；0 = 不注入传闻' },
    { key: 'injectEraNotes', label: '注入时附带时代约束', type: 'checkbox' },
    { key: 'aiFill', label: '一键推演后让 AI 补完', type: 'select', options: { off: '不调用 AI，只推演', brief: '补写幕后（1 次）', opinions: '补写幕后 + 新读者的私下看法', all: '再加上给新入账的反响写稿' }, hint: '推演定下谁读了、态度如何；AI 再补写聊天里没写到、主角不知道的事。开始前会告诉你要调用几次' },
    { key: 'aiFillMax', label: '每次最多调用 AI', type: 'number', hint: '看法和写稿按重要程度排序，超出的留到下次或手动点' },
    { key: 'aiFillOnAuto', label: '按日期自动推演时也补完', type: 'checkbox', hint: '每到设定的天数自动推演时，一并调用 AI；不弹确认' },
    { key: 'autoFloorEvery', label: '每聊满多少楼自动推演一次', type: 'number', hint: '0 = 不按楼数。满了就自动跑一次“一键推演到今天”，再按上面的方式让 AI 补完；不弹确认，过程在控制台里看。在 AI 回复完之后才跑。用这个时，建议把“故事日期 · 自动推演”设成“不自动”，否则按日期的自动推演仍会用到最新几楼' },
    { key: 'autoFloorDelay', label: '自动推演延迟几楼', type: 'select', options: { 0: '不延迟（用到最新一楼）', 3: '延迟 3 楼', 5: '延迟 5 楼（推荐）', 10: '延迟 10 楼' }, numeric: true, hint: '只按这几楼之前的剧情推演：最新几楼的日期、正文不算，重roll、改写、删掉它们也不会撤掉这次推演和 AI 补完的结果' },
    { key: 'aiSuggestPersons', label: '补完时推荐可能读到作品的新人物', type: 'checkbox', hint: '按作品的刊物、题材和年代推荐当时真实存在的人，放进“人物与刊物”的待确认，你同意才加入；有新作品或距上次满 30 天才推荐，每次 1 次调用' },
    { key: 'injectOffscreen', label: '幕后内容注入主对话', type: 'select', options: { off: '不注入', known: '只注入主角能知道的', all: '全部注入（标明主角不知道，供叙事作暗线）' } },
    { key: 'apiMode', label: '写稿/检索用的模型', type: 'select', options: { st: '酒馆当前连接', custom: '独立 OpenAI 兼容 API' } },
    { key: 'apiUrl', label: '独立 API 地址', placeholder: 'https://…/v1' },
    { key: 'apiKey', label: '独立 API 密钥', type: 'password' },
    { key: 'apiModel', label: '模型名' },
    { key: 'temperature', label: '温度', type: 'number', step: 0.05 },
    { key: 'maxTokens', label: '写稿最大输出', type: 'number' },
    { key: 'realPersonPolicy', label: '真实人物', type: 'select', options: { stance: '只写立场摘要（推荐）', full: '允许拟写全文' } },
    { key: 'outputLanguage', label: '写稿语言' },
    { key: 'eraRefresh', label: '年代档案多久刷新一次', type: 'select', options: { quarter: '每季度（推荐）', month: '每月', off: '不刷新' }, hint: '故事进入新的季度（或月份）时，按新日期重新生成：当期新出版的书刊、创刊停刊、文坛和社会大事都会补上' },
    { key: 'eraRefreshMode', label: '到期时', type: 'select', options: { auto: '自动刷新（每期调用 1 次 AI，并先检索维基百科）', remind: '只提醒我，我自己点' } },
    { key: 'wikiEnabled', label: '允许检索维基百科', type: 'checkbox' },
    { key: 'wikiLangs', label: '检索语言（逗号分隔）', placeholder: 'fr,en,zh' },
];

// ———— 设置页：分组、左说明右控件、改了就保存 ————

const SET_GROUPS = [
    { title: '基本', desc: '插件开关、审核方式与面板外观', keys: ['enabled', 'autoApprove', 'panelOpacity'] },
    { title: '故事日期', desc: '怎样从聊天里认出故事进行到了哪一天', keys: ['autoDetectDate', 'autoAdvanceMode', 'autoAdvanceDays', 'maxJumpDays', 'headChars', 'includeHidden', 'chatSource', 'summaryTags'] },
    { title: '世界书', desc: '让主对话里的 NPC 知道自己读过什么、怎么看', keys: ['loreEnabled', 'loreAuto', 'loreBook', 'loreScope', 'loreWorks', 'loreMaxChars', 'loreBindChat'] },
    { title: '书信簿联动', desc: '与 st-epistolary 书信簿插件配合', keys: ['epiEnabled', 'epiSyncDate', 'epiSendAuto'] },
    { title: '推演', desc: '只影响概率，不调用模型', keys: ['intensity', 'rumorHalfLife'], extra: 'layerMult' },
    { title: 'AI 补完', desc: '一键推演之后，让 AI 补写聊天里没写到、主角不知道的事', keys: ['aiFill', 'aiFillMax', 'aiFillOnAuto', 'autoFloorEvery', 'autoFloorDelay', 'aiSuggestPersons'] },
    { title: '主角知道什么', desc: '社会上已经见报，不等于主角读到了', keys: ['knowPublic', 'clipDays'] },
    { title: '注入主对话', desc: '让角色“知道”报上登了什么', keys: ['injectEnabled', 'injectPosition', 'injectDepth', 'injectMaxItems', 'injectMaxRumors', 'injectEraNotes', 'injectOffscreen'] },
    { title: '写稿与模型', desc: '写书评正文、生成看法、整理材料、归类标签时用', keys: ['apiMode', 'apiUrl', 'apiKey', 'apiModel', 'temperature', 'maxTokens', 'outputLanguage', 'realPersonPolicy'], extra: 'apiTest' },
    { title: '年代资料', desc: '生成年代档案时检索的资料', keys: ['eraRefresh', 'eraRefreshMode', 'wikiEnabled', 'wikiLangs'] },
];
// 只在某个选项打开时才显示的设置
const SET_DEPS = {
    injectPosition: s => s.injectEnabled, injectDepth: s => s.injectEnabled && Number(s.injectPosition) === 1,
    injectMaxItems: s => s.injectEnabled, injectMaxRumors: s => s.injectEnabled, injectEraNotes: s => s.injectEnabled,
    apiUrl: s => s.apiMode === 'custom', apiKey: s => s.apiMode === 'custom', apiModel: s => s.apiMode === 'custom',
    wikiLangs: s => s.wikiEnabled, autoAdvanceMode: s => s.autoDetectDate, autoAdvanceDays: s => s.autoDetectDate && advanceMode(s) === 'interval',
    epiSyncDate: s => s.epiEnabled !== false, eraRefreshMode: s => s.eraRefresh && s.eraRefresh !== 'off', epiSendAuto: s => s.epiEnabled !== false,
    autoFloorDelay: s => Number(s.autoFloorEvery) > 0, clipDays: s => (s.knowPublic || 'reads') === 'reads',
    loreAuto: s => s.loreEnabled, loreBook: s => s.loreEnabled, loreScope: s => s.loreEnabled, loreWorks: s => s.loreEnabled, loreMaxChars: s => s.loreEnabled, loreBindChat: s => s.loreEnabled,
    aiFillMax: s => s.aiFill && s.aiFill !== 'off', aiFillOnAuto: s => s.aiFill && s.aiFill !== 'off', aiSuggestPersons: s => s.aiFill && s.aiFill !== 'off', injectOffscreen: s => s.injectEnabled,
};

/** 面板不透明度：在主题背景色下面垫一层深色底，0 = 只用主题色 */
export function applyPanelOpacity(s = getSettings()) {
    const v = s.panelOpacity ?? (s.panelBg === 'theme' ? 0 : 90);
    document.getElementById('pe-panel')?.style.setProperty('--pe-opa', String(Math.max(0, Math.min(100, Number(v) || 0)) / 100));
}
function setControl(f, val) {
    const opts = typeof f.options === 'function' ? f.options() : f.options;
    switch (f.type) {
    case 'checkbox': return `<label class="pe-switch"><input type="checkbox" data-k="${f.key}" ${val ? 'checked' : ''}><span></span></label>`;
    case 'select': return `<select class="text_pole" data-k="${f.key}">${Object.entries(opts).map(([k, v]) => `<option value="${h(k)}" ${String(val) === String(k) ? 'selected' : ''}>${h(v)}</option>`).join('')}</select>`;
    case 'number': return `<input class="text_pole pe-num-in" type="number" step="${f.step ?? 1}" data-k="${f.key}" data-num="1" value="${h(val ?? '')}">`;
    case 'range': { const v = val ?? f.max; return `<div class="pe-range"><input type="range" min="${f.min ?? 0}" max="${f.max ?? 100}" step="${f.step ?? 1}" data-k="${f.key}" value="${h(v)}"><output>${h(v)}${f.unit || ''}</output></div>`; }
    // 不用 type=password：浏览器会把保存的登录密码自动填进来（还会把用户名填进上一个输入框）
    case 'password': return `<div class="pe-secret-wrap"><input class="text_pole pe-secret" type="text" data-k="${f.key}" value="${h(val ?? '')}" autocomplete="off" data-lpignore="true" data-1p-ignore data-bwignore spellcheck="false" placeholder="粘贴密钥"><button class="pe-mini" data-act="secret-toggle" title="显示/隐藏">显示</button></div>`;
    default:
        if (f.key === 'apiModel') {
            // 读到模型列表后只留一个下拉框；想填列表里没有的，选“手动输入…”
            if (modelList.length && !modelManual) {
                const opts = val && !modelList.includes(val) ? [val, ...modelList] : modelList;
                return `<div class="pe-model-wrap"><select class="text_pole" data-k="apiModel">${val ? '' : '<option value="">（选择模型）</option>'}${opts.map(m => `<option value="${h(m)}" ${m === val ? 'selected' : ''}>${h(m)}</option>`).join('')}<option value="__manual">手动输入…</option></select><button data-act="api-models" title="重新读取可用的模型">刷新列表</button></div>`;
            }
            return `<div class="pe-model-wrap"><input class="text_pole" type="text" data-k="apiModel" value="${h(val ?? '')}" placeholder="如 deepseek-flash" autocomplete="off" spellcheck="false"><button data-act="api-models" title="向这个地址读取可用的模型（GET /models），之后直接从下拉框选">获取模型列表</button></div>`;
        }
        return `<input class="text_pole" type="text" data-k="${f.key}" value="${h(val ?? '')}" placeholder="${h(f.placeholder || '')}" autocomplete="off">`;
    }
}
let modelList = [];
let modelManual = false;

function settings(st, s) {
    const spec = Object.fromEntries(SETTINGS_SPEC.map(f => [f.key, f]));
    const lm = s.layerMult || {};
    const row = f => `<div class="pe-set-row ${['checkbox', 'number'].includes(f.type) ? 'pe-set-compact' : ''} ${SET_DEPS[f.key] && !SET_DEPS[f.key](s) ? 'pe-hide' : ''}" data-row="${f.key}">
        <div class="pe-set-label"><div>${h(f.label)}</div>${f.hint ? `<small>${h(f.hint)}</small>` : ''}</div>
        <div class="pe-set-ctl">${setControl(f, s[f.key])}</div></div>`;
    const extra = g => g.extra === 'layerMult' ? `<details class="pe-set-more"><summary>各类反响的发表意愿（高级）</summary>
          <div class="pe-muted">在“公开发表意愿”之上再分别乘一个倍数：1 为默认，0 为关掉这一类，2 为加倍。</div>
          <div class="pe-set-grid">${['review', 'notice', 'echo', 'polemic', 'private_letter'].map(k => `<label><span>${LAYERS[k].label}</span><input class="text_pole pe-num-in" type="number" step="0.1" min="0" data-lm="${k}" value="${h(lm[k] ?? 1)}"></label>`).join('')}</div></details>`
        : g.extra === 'apiTest' ? `<div class="pe-set-row"><div class="pe-set-label"><div>测试连接</div><small>发一条很短的请求，看模型能否回应</small></div><div class="pe-set-ctl"><button data-act="api-test">测试</button></div></div>` : '';
    return `
    <div class="pe-set-head"><span class="pe-muted">全局设置，对所有聊天生效。改动会自动保存。</span><span class="pe-saved" id="pe-saved"></span></div>
    <div id="pe-settings">
      ${SET_GROUPS.map(g => `<div class="pe-set-card"><div class="pe-set-title"><b>${g.title}</b><span class="pe-muted">${g.desc}</span></div>
        ${g.keys.map(k => spec[k]).filter(Boolean).map(row).join('')}${extra(g)}</div>`).join('')}
    </div>
    <div class="pe-set-card">
      <div class="pe-set-title"><b>本聊天的数据</b><span class="pe-muted">随聊天文件保存；推演随机种子 ${h(st.seed)}，同一存档结果可复现</span></div>
      <div class="pe-set-row"><div class="pe-set-label"><div>备份</div><small>把本聊天的报刊回声数据存成文件</small></div><div class="pe-set-ctl"><button data-act="state-export">导出存档</button></div></div>
      <div class="pe-set-row"><div class="pe-set-label"><div>恢复</div><small>只用于恢复本插件导出的存档，会覆盖现有数据。整理包请到“导入与整理”页读取</small></div>
        <div class="pe-set-ctl"><label class="menu_button pe-file">恢复存档<input type="file" id="pe-import-file" accept=".json" hidden></label></div></div>
      <div class="pe-set-row pe-danger-row"><div class="pe-set-label"><div>清空</div><small>删除本聊天的全部报刊回声数据，不可撤销，建议先导出</small></div><div class="pe-set-ctl"><button class="pe-danger" data-act="state-reset">清空本聊天数据</button></div></div>
    </div>`;
}

/** 设置页任一控件改动：立即保存，并按依赖显示/隐藏相关项（不重绘，免得打断输入） */
function saveSettingsLive() {
    const root = document.getElementById('pe-settings');
    if (!root) return;
    const s = getSettings();
    Object.assign(s, readForm(root, SETTINGS_SPEC));
    s.layerMult = s.layerMult || {};
    root.querySelectorAll('[data-lm]').forEach(i => { s.layerMult[i.dataset.lm] = Number(i.value) || 0; });
    saveSettings();
    for (const [k, fn] of Object.entries(SET_DEPS)) root.querySelector(`[data-row="${k}"]`)?.classList.toggle('pe-hide', !fn(s));
    const tip = document.getElementById('pe-saved');
    if (tip) { tip.textContent = '已保存'; tip.classList.add('on'); clearTimeout(tip._t); tip._t = setTimeout(() => tip.classList.remove('on'), 1200); }
    app?.refreshInjection?.();
    fab?.setVisible(!!s.enabled);
}

// ———————————— 交互 ————————————

function onChange(e) {
    const t = e.target;
    if (t.id === 'pe-find') return;
    if (t.id === 'pe-tl-work' && simView?.kind === 'timeline') { simView.workId = t.value; refresh(); return; }
    if (simView?.kind === 'paper' && ['pe-pp-outlet', 'pe-pp-date', 'pe-pp-span'].includes(t.id)) {
        const st = getState();
        if (t.id === 'pe-pp-outlet') { simView.outletId = t.value; simView.date = paperDates(st, t.value)[0] || simView.date; }
        if (t.id === 'pe-pp-date') simView.date = t.value;
        if (t.id === 'pe-pp-span') simView.span = t.value;
        refresh(); return;
    }
    if (t.dataset?.pc && simView?.kind === 'perc') {
        const k = t.dataset.pc;
        if (k === 'asOf') { const d = normalizeISO(t.value); if (t.value && !d) return toast('warning', '日期写成 YYYY-MM-DD'); simView.asOf = d || ''; }
        else if (k === 'penId') simView.penId = t.value;
        else simView[k] = t.checked;
        refresh(); return;
    }
    if (t.dataset?.k === 'apiModel' && t.tagName === 'SELECT' && t.value === '__manual') { modelManual = true; refresh(); document.querySelector('#pe-settings input[data-k="apiModel"]')?.focus(); return; }
    if (t.dataset?.nw && simView?.kind === 'network') { simView.show[t.dataset.nw] = t.checked; refresh(); return; }
    if (t.dataset?.nwv && simView?.kind === 'network') {
        const k = t.dataset.nwv;
        if (k === 'asOf') { const d = normalizeISO(t.value); if (t.value && !d) return toast('warning', '日期写成 YYYY-MM-DD'); simView.asOf = d || ''; }
        else if (k === 'pa' || k === 'pb') simView[k] = t.value;
        else simView[k] = t.checked;
        refresh(); return;
    }
    if (t.id === 'pe-ledger-filter') { ledgerFilter = t.value; refresh(); }
    if (t.closest?.('#pe-settings')) { saveSettingsLive(); return; }
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
    if (act.startsWith('con-')) { conAction(act); return; }
    if (act === 'undo') { doUndo(); return; }
    if (act === 'find-clear') { findQ[tab] = ''; const i = document.getElementById('pe-find'); if (i) { i.value = ''; i.focus(); } applyFind(); return; }
    if (act === 'fold-all') {
        const open = btn.dataset.open === '1';
        document.querySelectorAll('#pe-body .pe-rd-work').forEach(d => { if (!d.hidden) { d.open = open; if (open) foldOpen.add(d.dataset.fold); else foldOpen.delete(d.dataset.fold); } });
        return;
    }
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
            const all = c?.chat || [];
            if (!all.length) return toast('warning', '当前聊天是空的');
            const from = n > 0 ? Math.max(0, all.length - n) : 0;
            materials.push(chatMaterial(from, all.length - 1, n > 0 ? `当前聊天最近 ${n} 楼` : '当前聊天全部'));
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
        case 'org-continue': {
            const p = orgPointer(st);
            const chat = chatNow();
            if (!p.fresh) return toast('info', '指针之后没有新楼层');
            if (materials.some(m => m.range)) materials = materials.filter(m => !m.range);
            materials.push(chatMaterial(p.mes + 1, chat.length - 1, '从指针处继续'));
            refresh(); break;
        }
        case 'org-mark-set': {
            const v = parseInt(document.getElementById('pe-org-mark')?.value, 10);
            if (!Number.isFinite(v)) return toast('warning', '填楼号（酒馆消息上的 #编号）');
            setOrgMark(st, v, '手动设定'); commit(v < 0 ? '指针已清除' : `指针设到 #${st.orgMark.mes}`); break;
        }
        case 'org-mark-end': setOrgMark(st, chatNow().length - 1, '手动设为最新'); commit(`指针设到 #${st.orgMark.mes}`); break;
        case 'org-mark-clear': st.orgMark = null; commit('指针已清除'); break;
        case 'org-run': {
            if (!materials.length) break;
            {   // 先说清楚要调用几次：整段几千楼的聊天一次整理，可能是几百次调用
                const n = estCalls();
                const chars = materials.reduce((a, m) => a + m.text.length, 0);
                if (n > 5 && !confirm(`材料共约 ${(chars / 10000).toFixed(1)} 万字，要分 ${n} 块整理，调用 AI ${n} 次。\n\n聊天很长时，建议只整理还没整理过的那段（“当前聊天”旁边填最近多少楼），或者先导入已有的整理包。\n\n确定继续？`)) break;
            }
            orgAbort = new AbortController();
            refresh();
            try {
                const range = materials.filter(m => m.range).map(m => m.range);
                const b = await organize(st, materials, s, m => setBusy(m), orgAbort.signal);
                const prevRange = st.pendingBundle?.chatRange;
                st.pendingBundle = mergeBundles(st.pendingBundle, b);
                if (!orgAbort.signal.aborted && range.length) st.pendingBundle.chatRange = { from: Math.min(...range.map(r => r.from), prevRange?.from ?? Infinity), to: Math.max(...range.map(r => r.to), prevRange?.to ?? -1) };
                else if (prevRange) st.pendingBundle.chatRange = prevRange;
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
        case 'bundle-drop': if (confirm('丢弃这份整理结果？')) { st.pendingBundle = null; bundleEdit = null; commit(); } break;
        case 'bundle-apply': {
            const b = st.pendingBundle;
            if (!b) break;
            pushUndo(st, '应用整理结果');
            bundleEdit = null;
            const kinds = [...document.querySelectorAll('.pe-bundle-kind')].filter(c => c.checked).map(c => c.value);
            const dateMode = $('#pe-bundle-datemode')?.value || 'set';
            const rep = applyBundle(st, b, { kinds, dateMode, settings: s, era: getEra(), sync: !!$('#pe-bundle-sync')?.checked });
            st.pendingBundle = null;
            if (b.chatRange && (!st.orgMark || b.chatRange.to > orgPointer(st).mes)) { setOrgMark(st, b.chatRange.to, `整理了 #${b.chatRange.from}–#${b.chatRange.to}`); rep.lines.push(`整理指针移到 #${b.chatRange.to}`); }
            syncEraYear(st);
            if (rep.rerolled && st.currentDate) advanceTo(st, st.currentDate, s, getEra());
            if (txtPlan.length) {
                // 整理包可能刚建好作品：重新匹配一次，免得重复新建
                txtPlan = txtPlan.map(r => (r.action === 'new' || (r.action === 'skip' && r.isDraft) ? { ...r, ...pickUpdate(st, r) } : r));
                commitTxt(st);
            }
            logLine(st, `应用整理包：${kinds.map(k => KIND_LABEL[k]).join('、')}；自动新建 ${rep.created.length}，跳过 ${rep.skipped.length}`);
            if (!st.backfilledAt) toast('info', '整理结果已导入。建议先到“人物与刊物”归类标签，再到“概览”点“回溯推演”，补上从首次发表到现在的文学界变化。');
            commit(`已应用整理结果${rep.created.length ? `；自动新建 ${rep.created.length} 项资料空白的条目，请到“人物与刊物”补全` : ''}${rep.skipped.length ? `；跳过 ${rep.skipped.length} 条` : ''}`);
            if (rep.skipped.length || rep.created.length || rep.removed.length || rep.outletFix) showText('应用报告', [...rep.lines, '', '自动新建：', ...rep.created, '', '跳过：', ...rep.skipped, '', '按新版删除：', ...rep.removed].join('\n'));
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
        case 'paper-open': {
            const e0 = btn.dataset.id ? st.ledger.find(x => x.id === btn.dataset.id) : null;
            const outlets = st.outlets.filter(o => paperDates(st, o.id).length);
            if (!outlets.length) return toast('info', '还没有登在报刊上、已入账的文章');
            const outletId = e0?.outletId || outlets.sort((a, b) => cmp(paperDates(st, b.id)[0], paperDates(st, a.id)[0]))[0].id;
            simView = { kind: 'paper', outletId, date: e0?.date || paperDates(st, outletId)[0], span: 'day', lang: simView?.lang || 'fr' };
            refresh(); $('#pe-body').scrollTop = 0; break;
        }
        case 'paper-window': case 'paper-download': {
            if (simView?.kind !== 'paper') break;
            const o = byId(st.outlets, simView.outletId);
            const doc = `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><title>${h((outletOriginal(o) || o?.name || '') + ' · ' + simView.date)}</title><style>body{margin:0;padding:24px;background:#d9cfb8}${PAPER_CSS}</style></head><body>${paperHtml(st, simView.outletId, simView.date, simView.span, simView.lang || 'fr')}</body></html>`;
            if (act === 'paper-download') { download(`${o?.name || '报纸'}_${simView.date}.html`, doc); break; }
            const win = window.open('', '_blank');
            if (!win) return toast('warning', '浏览器拦住了新窗口，改用“下载 HTML”');
            win.document.open(); win.document.write(doc); win.document.close();
            break;
        }
        case 'paper-lang': if (simView?.kind === 'paper') { simView.lang = btn.dataset.lang; refresh(); } break;
        case 'paper-fr': {
            if (simView?.kind !== 'paper') break;
            const miss = paperMissingFr(st, simView.outletId, simView.date, simView.span);
            const redo = btn.dataset.redo === '1';
            const list = redo ? paperItems(st, simView.outletId, simView.date, simView.span).filter(e => e.text) : miss;
            if (!list.length) return toast('info', '这一版的文章都已经有法语稿了');
            taskBegin(`法语原文：${list.length} 篇`);
            let n = 0;
            try { n = await translatePaperFr(st, list, getEra(), s); } finally { taskEnd(); }
            commit(`已生成法语稿 ${n} 篇${n < list.length ? `，${list.length - n} 篇没成功（见控制台）` : ''}`);
            break;
        }
        case 'tl-work': simView = { kind: 'timeline', workId: btn.dataset.id }; refresh(); $('#pe-body').scrollTop = 0; break;
        case 'nw-open': simView = { kind: 'network', show: { rel: true, close: true, talk: true, leak: true }, pos: {} }; refresh(); $('#pe-body').scrollTop = 0; break;
        case 'pc-open': simView = { kind: 'perc', only: false, open: {} }; refresh(); $('#pe-body').scrollTop = 0; break;
        case 'si-add': {
            const f = pcForm('pe-si-form');
            if (!f.text) return toast('warning', '写一句内容');
            const d = normalizeISO(f.since) || '';
            const x = { ...blankSelf(f.mode === 'claim' ? 'claim' : 'self'), topic: f.topic || PERC_TOPICS[0], text: f.text, since: d, pennameId: f.pen || '' };
            st.selfImage = [...(st.selfImage || []), x];
            simView.open = { ...simView.open, self: true };
            commit(x.mode === 'claim' ? '已记下：从这天起，读到的人会知道作者这么说过' : '已记下（只是主角自己的看法）');
            break;
        }
        case 'si-del': st.selfImage = (st.selfImage || []).filter(x => x.id !== btn.dataset.id); simView.open = { ...simView.open, self: true }; commit(); break;
        case 'as-add': {
            const f = pcForm('pe-as-form');
            if (!f.who || !f.belief) return toast('warning', '选人物或圈子，并写一句');
            const x = { ...blankAssumed(), topic: f.topic || PERC_TOPICS[0], belief: f.belief, since: normalizeISO(f.since) || '', pennameId: simView.penId || '' };
            if (f.who.startsWith('p:')) x.personId = f.who.slice(2); else x.circle = f.who.slice(2);
            st.assumed = [...(st.assumed || []), x];
            simView.open = { ...simView.open, as: true };
            commit('已记下');
            break;
        }
        case 'as-del': st.assumed = (st.assumed || []).filter(x => x.id !== btn.dataset.id); simView.open = { ...simView.open, as: true }; commit(); break;
        case 'pcm-add': {
            const f = pcForm('pe-pm-form');
            if (!f.person || !f.belief) return toast('warning', '选人物，并写一句');
            const d = normalizeISO(f.date) || st.currentDate || '';
            if (st.currentDate && d && cmp(d, st.currentDate) > 0) return toast('warning', '只能记已经发生的（不晚于当前故事日期）');
            const p = manualPerception(st, { personId: f.person, topic: f.topic, belief: f.belief, kind: f.kind, date: d, pennameId: simView.penId || '' });
            simView.open = { ...simView.open, pm: true };
            commit(p.kind !== f.kind ? `已记下；对不上他知道的事，改标为“${PERC_KIND[p.kind]}”` : '已记下');
            break;
        }
        case 'pcm-del': if (confirm('删除这条认知？')) { st.perceptions = (st.perceptions || []).filter(x => x.id !== btn.dataset.id); commit(); } break;
        case 'pi-gen': {
            if (!simView?.penId) break;
            pushUndo(st, '整理公众形象');
            setBusy('整理公众形象');
            try { await generatePublicImage(st, { penId: simView.penId, circle: btn.dataset.circle, asOf: simView.asOf || st.currentDate, era: getEra(), settings: s }); } finally { setBusy(''); }
            simView.open = { ...simView.open, pi: true };
            commit('已整理');
            break;
        }
        case 'pr-run': {
            pushUndo(st, '认知对照分析');
            setBusy('认知对照分析');
            let rv;
            try { rv = await reviewPerceptions(st, { penId: simView?.penId || '', asOf: simView?.asOf || st.currentDate, settings: s }); } finally { setBusy(''); }
            commit(`找到 ${rv.items.length} 处出入`);
            break;
        }
        case 'nw-unsel': if (simView?.kind === 'network') { simView.sel = null; refresh(); } break;
        case 'nw-pick': if (simView?.kind === 'network') { simView.sel = { kind: 'node', id: btn.dataset.id }; refresh(); } break;
        case 'nw-path-from': if (simView?.kind === 'network') { simView.pa = btn.dataset.id; refresh(); } break;
        case 'rep-cell': {
            const list = repBreakdown(st, btn.dataset.pen, btn.dataset.circle);
            const r = st.reputation?.[btn.dataset.pen]?.[btn.dataset.circle] || {};
            const POL = { 1: '好评', '-1': '批评', 0: '褒贬参半' };
            showText(`${byId(st.pennames, btn.dataset.pen)?.name} · ${CIRCLES[btn.dataset.circle]}：${fameLabel(r.fame)}，${esteemLabel(r)}`, [`知名度 ${(r.fame || 0).toFixed(2)}；评价加权平均 ${(r.mean || 0).toFixed(2)}（好评分量 ${(r.pos || 0).toFixed(2)}、批评分量 ${(r.neg || 0).toFixed(2)}）`, '',
                ...list.map(e => `${e.date} ${byId(st.outlets, e.outletId)?.name ? '《' + byId(st.outlets, e.outletId).name + '》' : ''}${byId(st.persons, e.personId)?.name || e.personName || ''} ${LAYERS[e.layer]?.label || e.layer}${e.count ? ' 约' + e.count : ''} 《${byId(st.works, e.workId)?.title || ''}》：知名度 +${e.repApplied.fame}${e.repApplied.pol != null ? '，' + POL[e.repApplied.pol] : ''}`)].join('\n'));
            break;
        }
        case 'rep-orphans': showText('没算进名声的反响', repOrphans(st).map(x => `${x.ev.date} ${LAYERS[x.ev.layer]?.label} 《${byId(st.works, x.ev.workId)?.title || '?'}》：${x.why}${x.want ? `（作品署名：${byId(st.pennames, x.want)?.name}）` : '（作品也没有署名，请先在作品里选署名）'}`).join('\n')); break;
        case 'rep-fix': { pushUndo(st, '重新关联笔名'); const n = fixRepOrphans(st); commit(`已按作品的署名重新关联 ${n} 条反响`); break; }
        case 'nw-relayout': if (simView?.kind === 'network') { simView.pos = {}; refresh(); } break;
        case 'concepts-build':
        case 'concepts-rebuild': {
            pushUndo(st, '归类标签');
            setBusy('归类标签');
            try { await buildConcepts(st, s, { full: act === 'concepts-rebuild', onProgress: setBusy }); } finally { setBusy(''); }
            logLine(st, `标签归类：${st.concepts.groups.length} 组`);
            commit(`已归类：${st.concepts.groups.length} 个概念组。之前推演出、尚未入账的内容不会自动改变；需要的话在概览里重新“回溯推演”。`);
            break;
        }
        case 'bf-begin': {
            pushUndo(st, '开始回溯推演');
            bfForm = { mode: $('#pe-bf-mode').value, by: $('#pe-bf-by').value, size: Math.max(1, +$('#pe-bf-size').value || 100) };
            const segs = planSegments(st, bfForm.by, bfForm.size);
            if (!segs.length) return toast('warning', '没有可以推演的时间段');
            const inf = planSegments.info;
            const WHY = { 'after-target': '晚于当前日期', backward: '比前面的日期早', 'too-far': '一下跳得太远', unconfirmed: '后面几楼没跟上' };
            const note = inf ? [inf.merged ? `有 ${inf.merged} 段楼层里日期没往前走（同一天的戏），并进了前一段` : '', inf.rejected.length ? `忽略了 ${inf.rejected.length} 处顺口提到的日期，例如：${inf.rejected.slice(0, 4).map(x => `第 ${x.i + 1} 楼 ${x.raw}（${WHY[x.why] || x.why}）`).join('；')}` : ''].filter(Boolean).join('\n') : '';
            if (!confirm(`将分 ${segs.length} 段，从 ${st.works.map(w => w.pubDate).filter(Boolean).sort()[0]} 推到 ${st.currentDate}。${note ? '\n' + note + '\n' : ''}之前推演出但未入账的内容会清掉重来。开始？`)) break;
            const b = backfillBegin(st, s, getEra(), { mode: bfForm.mode });
            st.backfillRun.segments = segs;
            logLine(st, `开始分段回溯（${bfForm.mode === 'hidden' ? '只补看不见的部分' : '全部'}，${segs.length} 段）：人物 ${b.persons} 位、作品 ${b.works} 部`);
            commit(`已开始：共 ${segs.length} 段。点“推演下一段”逐段推进`);
            break;
        }
        case 'sim-now': {
            if (st.backfillRun) { btn.dataset.act = 'bf-all'; return onClick({ target: Object.assign(btn, {}) }).finally(() => { btn.dataset.act = 'sim-now'; }); }
            await runSimNow(st, s, { auto: false });
            break;
        }
        case 'bitem-edit': case 'bitem-del': case 'bitem-save': case 'bitem-cancel': case 'bundle-edit-all': case 'bundle-save-json': bundleItemAction(act, st, btn); break;
        case 'sg-accept': case 'sg-reject': case 'sg-suggest': await suggestAction(act, st, s, btn); break;
        case 'oc-run': case 'oc-accept': case 'oc-reject': await outletCheckAction(act, st, s, btn); break;
        case 'cp-new': case 'cp-edit': case 'cp-del': case 'cp-save': case 'it-new': case 'it-edit': case 'it-del': case 'it-pres-add': case 'it-pt-add': case 'it-row-del': case 'it-save': ideasAction(act, st, btn); break;
        case 'rs-run': case 'rs-accept': case 'rs-guess': case 'rs-reject': case 'rs-accept-doc': await relSuggestAction(act, st, s, btn); break;
        case 'lore-sync': {
            setBusy('同步世界书');
            let r;
            try { r = await syncLore(st, s); } finally { setBusy(''); }
            commit(`世界书“${r.book}”：新增 ${r.added}、更新 ${r.updated}、删除 ${r.removed}${r.created ? '（新建）' : ''}`);
            break;
        }
        case 'lore-on': { s.loreEnabled = true; saveSettings(); commit('已打开世界书同步'); break; }
        case 'os-del': { st.offscreen = (st.offscreen || []).filter(d => d.id !== btn.dataset.id); commit('已删除这期幕后'); break; }
        case 'os-redo': {
            pushUndo(st, '重写幕后');
            const ds = (st.offscreen || []).slice().sort((a, b) => cmp(a.to, b.to));
            const last = ds[ds.length - 1];
            if (!last || !confirm(`重写 ${last.from || '起点'} → ${last.to} 这一期幕后？原来的会被替换。`)) break;
            const oldList = st.offscreen;
            st.offscreen = oldList.filter(d => d !== last);
            const n0 = st.offscreen.length;
            await aiFill(st, { ...s, aiFill: 'brief' }, { from: last.from, to: last.to, fresh: null, force: true, auto: true });
            if (st.offscreen.length === n0) { st.offscreen = oldList; commit('重写失败，保留原来的一期'); }
            break;
        }
        case 'bf-next':
        case 'bf-all': {
            const run = st.backfillRun;
            if (!run) break;
            setBusy('回溯推演');
            try {
                const segs = run.segments;
                for (const [gi, g] of segs.entries()) {
                    if (g.result) continue;
                    taskStep(`回溯第 ${gi + 1} 段：推到 ${g.endDate}`, gi + 1, segs.length);
                    const r = backfillStep(st, s, getEra(), g.endDate);
                    clog('info', `第 ${gi + 1} 段 → ${g.endDate}：读完 ${r.finished}，读了部分 ${r.skimmed}，接触未读 ${r.ignored}${r.candidates ? `，回溯候选 ${r.candidates}` : ''}`, (r.reads || []).map(x => `${byId(st.persons, x.personId)?.name || '?'} ${x.read === 'finished' ? '读完' : '读了部分'}《${byId(st.works, x.workId)?.title || ''}》`).join('\n') || null);
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
            pushUndo(st, '回溯推演');
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
        case 'txt-commit': pushUndo(st, 'txt 导入作品'); commitTxt(st); break;
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
        case 'approve': setStatus(st, ev, 'approved'); logLine(st, `批准：${ev.date} ${LAYERS[ev.layer]?.label}`); await afterWrite(st, s, ev); commit(); break;
        case 'approve-write': setStatus(st, ev, 'approved'); commit(); await doWrite(st, s, ev); break;
        case 'reject': setStatus(st, ev, 'rejected'); commit(); break;
        case 'approve-all': pushUndo(st, '全部入账'); for (const x of st.ledger.filter(y => y.status === 'candidate')) setStatus(st, x, 'approved'); commit('已全部批准'); break;
        case 'reject-all': if (confirm('驳回全部候选？')) { pushUndo(st, '全部驳回'); for (const x of st.ledger.filter(y => y.status === 'candidate')) setStatus(st, x, 'rejected'); commit(); } break;
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
            pushUndo(st, '逐条写稿');
            const list = st.ledger.filter(x => x.status === 'approved' && !x.text?.body && x.layer !== 'reader_letters' && x.layer !== 'mentions');
            taskBegin(`逐条写稿（${list.length} 条）`);
            for (const [i, x] of list.entries()) {
                taskStep(`写稿：${x.date} ${byId(st.persons, x.personId)?.name || x.personName || ''} · ${LAYERS[x.layer]?.label || x.layer}${x.workId ? ` 《${byId(st.works, x.workId)?.title || ''}》` : ''}`, i + 1, list.length);
                await doWrite(st, s, x, true);
            }
            taskEnd();
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
                { key: 'summary', type: 'textarea' }, { key: 'approved', type: 'checkbox' }, { key: 'to', type: 'select' }, { key: 'knownAt' },
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
        case 'tbl-add': btn.closest('.pe-tbl')?.querySelector('.pe-tbl-rows')?.insertAdjacentHTML('beforeend', tblRow(btn.dataset.tbl, {}, true)); break;
        case 'tbl-del': btn.closest('.pe-tbl-row')?.remove(); break;
        case 'draft-person': case 'draft-claims': {
            const root = document.querySelector('.pe-editor');
            if (!root) break;
            const isP = act === 'draft-person';
            const base = (isP ? st.persons : st.works).find(x => x.id === btn.dataset.id) || editing?.draft || {};
            const cur = { ...base, ...readForm(root, isP ? PERSON_SPEC : WORK_SPEC) };
            if (isP) { cur.stances = readTable(root, 'stances') || []; cur.stylePrefs = readTable(root, 'stylePrefs') || []; } else cur.claims = readTable(root, 'claims') || [];
            if (!String(isP ? cur.name : cur.title || '').trim()) return toast('warning', isP ? '先填姓名' : '先填作品名');
            setBusy(isP ? `起草 ${cur.name} 的立场与文体偏好` : `提取《${cur.title}》的主张`);
            let res;
            try { res = isP ? await draftPersonProfile(st, cur, { ...st.era, year: st.era?.year || (st.currentDate || '').slice(0, 4) }, s) : await draftWorkClaims(st, cur, s); } finally { setBusy(''); }
            if (!document.querySelector('.pe-editor')) return toast('warning', '编辑框已关闭，起草结果没有放进去，请重新打开再试');
            const n = isP ? addDrafted('stances', res.stances) + addDrafted('stylePrefs', res.stylePrefs) : addDrafted('claims', res);
            toast(n ? 'success' : 'info', n ? `加了 ${n} 条（高亮显示），检查后点“保存”` : '没有新的条目（已有的同名条目不会覆盖）');
            break;
        }
        case 'fleak-yes': case 'fleak-half': case 'fleak-no': {
            const lk = (st.factLeaks || []).find(x => x.id === btn.dataset.id);
            const f = lk && (st.privateFacts || []).find(x => x.id === lk.factId);
            if (!lk || !f) break;
            lk.status = act === 'fleak-no' ? 'denied' : 'confirmed';
            if (act !== 'fleak-no') {
                f.knownBy = (f.knownBy || []).filter(k => k.personId !== lk.to);
                f.knownBy.push({ personId: lk.to, since: lk.date, via: 'heard', believes: act === 'fleak-yes', from: lk.from });
                logLine(st, `确认：${byId(st.persons, lk.to)?.name} 从 ${byId(st.persons, lk.from)?.name} 处听说“${truncate(f.text, 30)}”${act === 'fleak-half' ? '（不太相信）' : ''}`);
            }
            commit(); break;
        }
        case 'fact-new': { const f = blankFact(); if (btn.dataset.work) { f.workId = btn.dataset.work; f.topic = '创作意图'; } editing = { kind: 'fact', id: f.id, draft: f }; tab = 'people'; simView = null; refresh(); break; }
        case 'fact-edit': editing = { kind: 'fact', id: btn.dataset.id }; refresh(); break;
        case 'fact-del': if (confirm('删除这条私人信息？（知情记录一起删掉）')) { st.privateFacts = (st.privateFacts || []).filter(f => f.id !== btn.dataset.id); commit(); } break;
        case 'fact-kb-add': $('.pe-fact-editor .pe-kb-rows')?.insertAdjacentHTML('beforeend', kbRow(st, {})); break;
        case 'fact-kb-del': btn.closest('.pe-kb-row')?.remove(); break;
        case 'fact-save': {
            const root = $('.pe-fact-editor');
            if (!root) break;
            const g = k => root.querySelector(`[data-f="${k}"]`);
            const text = g('text').value.trim();
            if (!text) return toast('warning', '写一下是什么信息');
            let f = (st.privateFacts || []).find(x => x.id === editing.id);
            if (!f) { f = editing.draft; st.privateFacts = [...(st.privateFacts || []), f]; }
            Object.assign(f, { text, topic: g('topic').value, workId: g('workId').value, public: g('public').checked, publicSince: normalizeISO(g('publicSince').value) || '', secret: g('secret').checked ? 'strict' : '' });
            f.knownBy = [...root.querySelectorAll('.pe-kb-row')].map(r => ({ personId: r.querySelector('[data-k2="personId"]').value, since: normalizeISO(r.querySelector('[data-k2="since"]').value) || '', via: r.querySelector('[data-k2="via"]').value, believes: r.querySelector('[data-k2="believes"]').checked })).filter(k => k.personId);
            editing = null;
            commit('已保存。之后生成看法、写稿、世界书、幕后都只给知情者');
            break;
        }
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
            const schedKey = o => JSON.stringify([o.periodicity, o.weekday ?? null, o.monthDays || [], o.issueDates || [], o.deadlineDays ?? null, o.capacity ?? null]);
            const schedBefore = kind === 'outlet' ? schedKey(obj) : null;
            Object.assign(obj, vals);
            if (kind === 'person') { obj.relations = readRelations(root); obj.stances = readTable(root, 'stances') || obj.stances || []; obj.stylePrefs = readTable(root, 'stylePrefs') || obj.stylePrefs || []; }
            if (kind === 'work') obj.claims = readTable(root, 'claims') || obj.claims || [];
            if (kind === 'outlet' && obj.weekday === '') obj.weekday = null;
            editing = null;
            if (kind === 'outlet' && schedBefore !== schedKey(obj) && (st.ledger || []).some(e => e.outletId === obj.id && e.origin === 'engine' && e.status !== 'approved')) {
                if (confirm(`《${obj.name}》的出刊周期/出刊日改了。要按新周期重排这家刊物上还没入账的推演反响吗？（已入账的不动）`)) {
                    const n = rerollOutlet(st, obj.id);
                    if (st.currentDate) advanceTo(st, st.currentDate, s, getEra());
                    commit(`已保存，并重排了 ${n} 条还没入账的反响`); break;
                }
            }
            commit('已保存');
            break;
        }
        case 'del-item': {
            const kind = btn.dataset.kind;
            const listName = { penname: 'pennames', outlet: 'outlets', person: 'persons', work: 'works' }[kind];
            if (!confirm('删除？已批准的账本记录会保留。')) return;
            pushUndo(st, `删除${{ penname: '笔名', outlet: '刊物', person: '人物', work: '作品' }[kind]}`);
            st[listName] = st[listName].filter(x => x.id !== btn.dataset.id);
            if (kind === 'work') rerollWork(st, btn.dataset.id);
            commit(); break;
        }
        case 'reroll-person': {
            const root = document.querySelector('.pe-editor');
            const obj = st.persons.find(x => x.id === btn.dataset.id);
            if (!root || !obj) break;
            pushUndo(st, `按新资料重推 ${obj.name}`);
            Object.assign(obj, readForm(root, PERSON_SPEC));
            obj.relations = readRelations(root); obj.stances = readTable(root, 'stances') || obj.stances || []; obj.stylePrefs = readTable(root, 'stylePrefs') || obj.stylePrefs || [];
            const n = rerollPerson(st, obj.id);
            editing = null;
            if (st.currentDate) doAdvance(st, s, st.currentDate);
            const got = st.receptions.filter(r => r.personId === obj.id && r.read && r.read !== 'none');
            commit(`已按新资料重推 ${obj.name}：撤掉 ${n} 条旧记录，现在接触到 ${got.length} 部作品（已入账的反响和手动记录保留）`);
            break;
        }
        case 'reroll-work': {
            const root = document.querySelector('.pe-editor');
            const obj = st.works.find(x => x.id === btn.dataset.id);
            Object.assign(obj, readForm(root, WORK_SPEC));
            obj.claims = readTable(root, 'claims') || obj.claims || [];
            rerollWork(st, obj.id);
            editing = null;
            if (!st.currentDate) { commit('已清除旧推演；设定故事日期后会重新推演'); break; }
            lastReport = advanceTo(st, st.currentDate, s, getEra());
            commit(`已按新资料重推：新增候选 ${lastReport.newCandidates.length} 条`);
            break;
        }

        // 年代
        case 'era-refresh': { const due = eraDue(getEra(), st.currentDate, s.eraRefresh || 'quarter'); await doEra(st, s, s.wikiEnabled !== false, { focus: due }); break; }
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
            saveSettingsLive();
            setBusy('测试中');
            let r;
            try { r = await callLLM({ system: '只回复 OK', user: 'ping', settings: getSettings(), maxTokens: 400, label: '测试连接' }); } finally { setBusy(''); }
            toast('success', '连接正常，模型返回：' + truncate(String(r).trim(), 60));
            break;
        }
        case 'api-models': {
            saveSettingsLive();
            setBusy('读取模型列表');
            try { modelList = await listModels(getSettings()); modelManual = false; } finally { setBusy(''); }
            clog('info', `读到 ${modelList.length} 个模型`, modelList.join('\n'));
            refresh();
            toast(modelList.length ? 'success' : 'warning', modelList.length ? `读到 ${modelList.length} 个模型，直接在下拉框里选` : '这个接口没有返回模型列表，只能手动填写');
            break;
        }
        case 'secret-toggle': {
            const inp = btn.parentElement.querySelector('.pe-secret');
            const on = inp.classList.toggle('pe-shown'); btn.textContent = on ? '隐藏' : '显示';
            break;
        }

        // 阅读记录 / 证据卡
        case 'gen-card': {
            const root = document.querySelector('.pe-editor');
            const obj = st.works.find(x => x.id === btn.dataset.id);
            if (root) Object.assign(obj, readForm(root, WORK_SPEC));
            if (srcOf(st, obj).length < 200) return toast('warning', '请先在“原文”里贴入至少 200 字的作品正文');
            setBusy('生成证据卡');
            try { obj.evidence = await buildEvidenceCard(obj, s, st); } finally { setBusy(''); }
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
                const third = hint.direction === 'third_party';
                const ev = addManualEvent(st, { date: hint.date, layer: 'private_letter', personId: hint.personId, workId: hint.workId, polarity: 0, summary: `（据书信簿 ${hint.code || ''}）${hint.excerpt}`,
                    to: hint.direction === 'to_user' ? 'protagonist' : (hint.recipients || []).join('、') || 'protagonist', knownAt: third ? null : hint.date });
                if (third) toast('info', '这是别人之间的信：主角暂时不知道它的内容。主角后来得知时，在账本里点“主角已得知”');
                ev.flags = ['来自书信簿', '褒贬请自行修改'];
                ev.epiLetterId = hint.letterId;
            }
            hint.handled = act.replace('epi-hint-', '');
            commit(act === 'epi-hint-ignore' ? '已忽略' : act === 'epi-hint-letter' ? '已加入候选（请到候选里确认褒贬后批准）' : '已记为读过');
            break;
        }

        case 'ev-known': {
            if (!ev) break;
            const pub = !!LAYERS[ev.layer]?.public;
            const d = normalizeISO(prompt(pub ? '主角哪天读到这篇文章？（YYYY-MM-DD）' : '主角哪天得知这封信的内容？（YYYY-MM-DD）', st.currentDate || ev.date) || '');
            if (!d) break;
            if (cmp(d, ev.date) < 0) return toast('warning', '不能早于见报或寄出的日期');
            if (pub) ev.seenAt = d; else ev.knownAt = d;
            commit(pub ? `主角从 ${d} 起读到这篇` : `主角从 ${d} 起知道这封信`);
            break;
        }
        case 'epi-send': {
            if (!ev) break;
            if (ev.epiSent) { toast('info', `已在书信簿里：${ev.epiSent.code || ev.epiSent.id}`); break; }
            const r = await sendToEpistolary(st, ev, { person: byId(st.persons, ev.personId) });
            clog('info', `私信寄进书信簿：${r.letter.id} ${r.letter.code || ''}${r.existed ? '（之前已寄过）' : ''}`);
            commit(`已寄进书信簿：${r.letter.code || r.letter.id}`);
            break;
        }
        case 'epi-on': { s.epiEnabled = true; saveSettings(); commit('已打开书信簿联动'); break; }
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
            const cur = act === 'art-append' ? String(srcOf(st, w) || '') : '';
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

        case 'state-export': await loadSources(st); download(`报刊回声_${st.currentDate || 'data'}.json`, JSON.stringify(withSources(st), null, 2)); break;
        case 'state-reset': if (confirm('清空本聊天的全部报刊回声数据？（刷新页面前可以用标题栏的 ↶ 撤销；建议先导出）')) { pushUndo(st, '清空本聊天数据'); const sidKeep = st.storeId; const ns = resetState(); if (ns) ns.storeId = sidKeep; commit('已清空'); } break;
        default: break;
        }
    } catch (err) {
        clog('error', String(err.message || err), err.stack || null);
        const t = currentTask(); if (t) { t.failed = true; taskEnd(); }
        setBusy('');
        console.error('[报刊回声]', err);
        toast('error', String(err.message || err) + '（详情见控制台 ▤）');
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
    if (st.detectedDate && cmp(st.detectedDate, d) <= 0) st.detectedDate = null;
    const beforeRecs = new Set((st.receptions || []).map(r => r.id));
    const own = !currentTask();
    if (own) taskBegin(`推演 ${from || '起点'} → ${d}`);
    lastReport = advanceTo(st, d, s, getEra());
    const fresh = (st.receptions || []).filter(r => !beforeRecs.has(r.id));
    const recLine = r => `${byId(st.persons, r.personId)?.name || '?'} · 《${byId(st.works, r.workId)?.title || '?'}》 · ${CHANNELS[r.channel] || '没接触到'}${r.contactDate ? ' ' + r.contactDate : ''} → ${READ_STATES[r.read] || r.read || '—'}${r.readDate ? ' ' + r.readDate : ''}${r.strength ? `，${['偏批评', '参半', '偏肯定'][r.polarity + 1]}，${STRENGTH[r.strength]}` : ''}${r.expression ? `，${EXPRESSION[r.expression] || r.expression}` : ''}`;
    const readNew = fresh.filter(r => r.read && r.read !== 'none');
    clog('info', `推演 ${from || '起点'} → ${d}：新轮到的“人物×作品”${lastReport.diag?.run ?? 0} 组，新增阅读记录 ${fresh.length} 条（其中接触到 ${readNew.length}）${lastReport.shelf ? `，成书长尾 ${lastReport.shelf}` : ''}；新反响 ${lastReport.newCandidates.length}（自动入账 ${lastReport.autoApproved?.length || 0}），新排期 ${lastReport.scheduled}，到期揭晓 ${lastReport.revealed.length}`,
        readNew.length || lastReport.newCandidates.length ? [...readNew.map(recLine), ...(lastReport.newCandidates.length ? ['', '新反响：', ...lastReport.newCandidates.map(e => `${e.date} ${byId(st.persons, e.personId)?.name || e.personName || ''} ${LAYERS[e.layer]?.label || e.layer} 《${byId(st.works, e.workId)?.title || ''}》 ${e.status === 'approved' ? '（自动入账）' : '（待审核）'}`)] : [])].join('\n') : null);
    if (own) taskEnd();
    setTimeout(() => checkEraRefresh(st, s), 0);
    syncEraYear(st);
    const auto = lastReport.autoApproved?.length || 0;
    logLine(st, `推进 ${from || '（起点）'} → ${d}：新增候选 ${lastReport.newCandidates.length}，自动通过 ${auto}，新排期 ${lastReport.scheduled}，揭晓 ${lastReport.revealed.length}${lastReport.shelf ? `，成书长尾新读者 ${lastReport.shelf}` : ''}`);
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
        await afterWrite(st, s, ev);
        if (!silent) commit(ev.flags?.length ? '写稿完成（有时代校验提示，请查看）' : '写稿完成');
    } finally { setBusy(''); }
}

async function doEra(st, s, useWiki, { focus = null, auto = false } = {}) {
    if (!st.currentDate) return toast('warning', '请先设定故事日期');
    syncEraYear(st);
    const year = yearOf(st.currentDate);
    const prev = getEra();
    if (!focus) { const due = eraDue(prev, st.currentDate, s.eraRefresh || 'quarter'); if (due) focus = due; }
    let sources = [];
    if (useWiki) {
        const lines = (document.getElementById('pe-wiki-titles')?.value || defaultWikiTitles(year, st.era?.country || '', s.wikiLangs).map(t => `${t.lang}:${t.title}`).join('\n')).split('\n').map(l => l.trim()).filter(Boolean);
        const titles = lines.map(l => { const i = l.indexOf(':'); return i > 0 ? { lang: l.slice(0, i).trim(), title: l.slice(i + 1).trim() } : null; }).filter(Boolean);
        sources = await gatherSources({ year, country: st.era.country, currentIso: st.currentDate, titles, settings: s, onProgress: setBusy });
        const ok = sources.filter(x => x.text).length;
        if (!ok) toast('warning', '维基百科没有取到内容（可能是网络或页面不存在），将仅用模型知识生成');
    }
    setBusy('生成年代档案');
    try {
        const prof = await buildEraProfile({ year, currentIso: st.currentDate, placeLabel: st.era.place, sources, notes: st.eraNotes, settings: s, focus, prev });
        if (prev && prev.asOf !== prof.asOf) { st.eraHistory = [...(st.eraHistory || []), { asOf: prev.asOf, period: prev.period || '', summary: prev.summary || '', periodNews: prev.periodNews || [], recentEvents: prev.recentEvents || [] }].slice(-12); }
        if (focus) { st.eraDone = st.eraDone || {}; st.eraDone[focus.key] = 'done'; }
        st.eraProfile = prof;
        s.eraCache = s.eraCache || {};
        s.eraCache[st.era.key] = prof;
        saveSettings();
        logLine(st, `生成年代档案：${st.era.key}${focus ? '（' + focus.label + '）' : ''}`);
        clog('info', `年代档案已${prev ? '刷新' : '生成'}：截至 ${prof.asOf}${focus ? '，' + focus.label : ''}${(prof.periodNews || []).length ? `；本期新事 ${prof.periodNews.length} 条` : ''}`, (prof.periodNews || []).map(x => `${x.date || ''} [${x.kind || ''}] ${x.text || ''}`).join('\n') || null);
        commit(auto ? '' : '年代档案已生成');
        if (auto) toast('info', `年代档案已按${focus?.label || '新日期'}刷新`);
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


// ———————————— 控制台 ————————————
let conUnread = 0;
let conTimer = null;
const conTime = t => new Date(t).toLocaleTimeString('zh-CN', { hour12: false });
const conIcon = { task: '▶', step: '·', ai: '✦', ok: '✓', info: 'i', warn: '!', error: '✕' };
function conEntryHtml(e) {
    const head = `<span class="pe-con-time">${conTime(e.t)}</span><span class="pe-con-lv">${conIcon[e.level] || '·'} ${LEVELS[e.level] || e.level}</span><span class="pe-con-text">${h(e.text)}</span>`;
    return e.detail
        ? `<details class="pe-con-e lv-${e.level}"><summary>${head}</summary><pre>${h(e.detail)}</pre></details>`
        : `<div class="pe-con-e lv-${e.level}">${head}</div>`;
}
function conOpen(open) {
    const c = document.getElementById('pe-con');
    if (!c) return;
    c.hidden = !open;
    document.getElementById('pe-panel')?.classList.toggle('pe-con-on', open);
    if (open) { conUnread = 0; conBadge(); const l = document.getElementById('pe-con-list'); if (l) l.scrollTop = l.scrollHeight; }
}
function conBadge() {
    const b = document.getElementById('pe-con-badge');
    if (b) { b.textContent = conUnread ? String(conUnread) : ''; b.classList.toggle('on', !!conUnread); }
}
function conTaskLine() {
    const el = document.getElementById('pe-con-task');
    if (!el) return;
    const t = currentTask();
    if (!t || t.ending) { el.innerHTML = '<span class="pe-muted">空闲</span>'; return; }
    const sec = Math.round((Date.now() - t.start) / 1000);
    el.innerHTML = `<span class="pe-con-spin"></span><b>${h(t.name)}</b>${t.label && t.label !== t.name ? ` <span class="pe-muted">· ${h(t.label)}</span>` : ''}
      ${t.n ? `<span class="pe-con-bar"><i style="width:${Math.round(t.i / t.n * 100)}%"></i></span><span class="pe-muted">${t.i}/${t.n}</span>` : ''}
      <span class="pe-muted">${sec} 秒${t.ai ? ` · 模型 ${t.ai} 次` : ''}</span>`;
}
function bindConsole(panel) {
    const list = panel.querySelector('#pe-con-list');
    list.innerHTML = allEntries().map(conEntryHtml).join('');
    const auto = panel.querySelector('#pe-con-auto');
    auto.checked = getSettings().consoleAuto !== false;
    auto.addEventListener('change', () => { getSettings().consoleAuto = auto.checked; saveSettings(); });
    subscribe((e) => {
        if (!e) { list.innerHTML = ''; conTaskLine(); return; }
        const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
        list.insertAdjacentHTML('beforeend', conEntryHtml(e));
        while (list.children.length > 600) list.firstElementChild.remove();
        if (atBottom) list.scrollTop = list.scrollHeight;
        const closed = document.getElementById('pe-con')?.hidden;
        if (e.level === 'task' && closed && getSettings().consoleAuto !== false && !document.getElementById('pe-panel')?.classList.contains('pe-hidden')) conOpen(true);
        else if (closed && (e.level === 'error' || e.level === 'warn')) { conUnread++; conBadge(); }
        conTaskLine();
        // 有任务时每秒刷新耗时；空闲就停，不留常驻定时器
        if (currentTask() && !conTimer) conTimer = setInterval(() => { conTaskLine(); if (!currentTask()) { clearInterval(conTimer); conTimer = null; } }, 1000);
    });

    // 插件自己的未捕获错误也记下来
    const mine = s => /press-echo|st-press-echo/i.test(String(s || ''));
    window.addEventListener('error', ev => { if (mine(ev.filename) || mine(ev.error?.stack)) clog('error', `未捕获的错误：${ev.message}`, ev.error?.stack || `${ev.filename}:${ev.lineno}`); });
    window.addEventListener('unhandledrejection', ev => { const r = ev.reason; if (mine(r?.stack)) clog('error', `未处理的异常：${r?.message || r}`, r?.stack || null); });
}
function conAction(act) {
    if (act === 'con-toggle') conOpen(document.getElementById('pe-con')?.hidden);
    else if (act === 'con-clear') clearEntries();
    else if (act === 'con-copy') copyText(entriesText() || '（控制台是空的）', '控制台记录');
}


// ———————————— AI 补完：一键推演之后 ————————————

/** 上一期幕后补到哪天（force 时取再上一期，用于“重写最近一期”） */
function lastFillTo(st, prev = false) {
    const ds = (st.offscreen || []).slice().sort((a, b) => cmp(a.to, b.to));
    if (prev) return ds.length >= 2 ? ds[ds.length - 2].to : ds[0]?.from || null;
    return ds.length ? ds[ds.length - 1].to : null;
}
const chatOpts = () => { const g = getSettings(); return { source: g.chatSource || 'summary', tags: g.summaryTags || 'Narrative_Matrix', headChars: g.headChars }; };
function chatTail(n = 8, max = 5000, skip = 0) {
    const c = globalThis.SillyTavern?.getContext?.();
    const all = c?.chat || [];
    const msgs = all.slice(0, Math.max(0, all.length - skip)).filter(m => isStoryMessage(m, getSettings().includeHidden !== false)).slice(-n);
    let t = chatOpts().source === 'summary' ? chatToText(msgs, true, chatOpts()) : msgs.map(m => `${m.name || ''}：${m.mes}`).join('\n\n');
    if (t.length > max) t = '……' + t.slice(-max);
    return t;
}
/** 选出值得生成看法的阅读：想法强烈、真实人物、私交深、读完的优先 */
function opinionQueue(st, fresh, to) {
    return (st.receptions || [])
        .filter(r => (!fresh || fresh.has(r.id)) && READ_DONE.includes(r.read) && !r.opinion && r.strength && r.strength !== 'none'
            && (!r.readDate || cmp(r.readDate, to) <= 0) && byId(st.works, r.workId) && byId(st.persons, r.personId))
        .map(r => { const p = byId(st.persons, r.personId); return { r, score: (r.strength === 'strong' ? 3 : 1) + (p.real ? 1 : 0) + (p.closeness || 0) * 0.7 + (r.read === 'finished' ? 0.5 : 0) + (r.expression && r.expression !== 'silent' ? 1.5 : 0) }; })
        .sort((a, b) => b.score - a.score).map(x => x.r);
}
async function aiFill(st, s, { from, to, fresh, force = false, auto = false, chatSkip = 0 }) {
    const mode = s.aiFill || 'off';
    if (mode === 'off' || !to) return;
    const cap = Math.max(1, Number(s.aiFillMax) || 10);
    const ops = mode === 'opinions' || mode === 'all' ? opinionQueue(st, fresh, to) : [];
    const writes = mode === 'all' ? st.ledger.filter(e => e.status === 'approved' && !e.text?.body && !['reader_letters', 'mentions'].includes(e.layer) && (!from || cmp(e.date, from) > 0) && cmp(e.date, to) <= 0) : [];
    const hasNews = force || (fresh ? fresh.size > 0 : true) || writes.length;
    const brief = hasNews ? 1 : 0;
    const sug = s.aiSuggestPersons !== false && (force ? false : shouldSuggest(st, to)) && cap - brief >= 1 ? 1 : 0;
    let budget = cap - brief - sug;
    const opN = Math.min(ops.length, Math.max(0, budget)); budget -= opN;
    const wrN = Math.min(writes.length, Math.max(0, budget));
    const total = brief + sug + opN + wrN;
    if (!total) { clog('info', `AI 补完：${from || '起点'} → ${to} 没有新的动静，不调用 AI`); return; }
    const plan = [brief ? '幕后补完 1 次' : '', sug ? '推荐新人物 1 次' : '', opN ? `私下看法 ${opN} 次${ops.length > opN ? `（还有 ${ops.length - opN} 人留到下次）` : ''}` : '', wrN ? `写稿 ${wrN} 次${writes.length > wrN ? `（还有 ${writes.length - wrN} 篇）` : ''}` : ''].filter(Boolean).join('、');
    if (!auto && !confirm(`推演完成。接下来让 AI 补完 ${from || '起点'} → ${to}：\n${plan}\n共调用 AI 约 ${total} 次。继续？\n（取消则只保留推演结果，之后可以在“概览·幕后”里补）`)) { clog('info', `跳过 AI 补完（${plan}）`); return; }
    taskBegin(`AI 补完 ${from || '起点'} → ${to}（约 ${total} 次）`);
    let k = 0;
    try {
        // 先生成看法：幕后补完要用到
        for (const r of ops.slice(0, opN)) {
            taskStep(`私下看法：${byId(st.persons, r.personId)?.name} 读《${byId(st.works, r.workId)?.title}》`, ++k, total);
            try { await generateOpinion(st, r, getEra(), s); saveState(); } catch (e) { clog('error', `看法生成失败：${e.message}`); }
        }
        if (brief) {
            taskStep('补写幕后：沙龙、编辑部、熟人之间……', ++k, total);
            const freshIds = fresh && fresh.size ? fresh : null;
            const dg = await buildOffscreen(st, { from, to, freshRecIds: freshIds, era: getEra(), settings: s, chatTail: chatTail(8, 5000, chatSkip) });
            if (dg) { storeOffscreen(st, dg); saveState(); } else clog('info', '这段时间推演里没有可写的事');
        }
        if (sug) {
            taskStep('推荐可能读到作品的新人物', ++k, total);
            try { const got = await suggestPersons(st, { to, era: getEra(), settings: s }); saveState(); if (got.length) toast('info', `AI 推荐了 ${got.length} 位可能读到作品的人，到“人物与刊物”确认`); } catch (e) { clog('error', `推荐新人物失败：${e.message}`); }
        }
        for (const e of writes.slice(0, wrN)) {
            taskStep(`写稿：${e.date} ${byId(st.persons, e.personId)?.name || e.personName || ''} ${LAYERS[e.layer]?.label || ''}`, ++k, total);
            try { await writeEvent(st, e, getEra(), s); await afterWrite(st, s, e); saveState(); } catch (err) { clog('error', `写稿失败：${err.message}`); }
        }
    } finally { taskEnd(); }
    commit('AI 补完结束，详情见“概览·幕后”和控制台');
}
export { aiFill };

function offscreenBlock(st) {
    const ds = (st.offscreen || []).slice().sort((a, b) => cmp(b.to, a.to));
    const KN = { no: '主角不知道', maybe: '主角或许听说', yes: '主角知道' };
    const dg = (d, open) => `<details class="pe-os" ${open ? 'open' : ''}><summary><b>${h(d.from || '起点')} → ${h(d.to)}</b> <span class="pe-muted">${d.items.length} 条 · ${h(d.summary || '')}</span></summary>
      ${d.items.slice().sort((a, b) => cmp(a.date, b.date)).map(i => `<div class="pe-os-item pe-os-${i.knows}">
        <div class="pe-os-top"><span class="pe-card-date">${h(i.date)}</span><span class="pe-chip pe-chip-layer">${h(OFF_KINDS[i.kind] || i.kind)}</span><span class="pe-chip pe-os-k">${KN[i.knows]}</span>${i.work ? ` ${bt(i.work)}` : ''}${i.unknownWho?.length ? ` <span class="pe-chip pe-chip-no" title="不在人物表里">⚠ ${h(i.unknownWho.join('、'))}</span>` : ''}</div>
        <div>${h(i.text)}</div>
        ${i.howCouldLearn && i.knows !== 'yes' ? `<div class="pe-muted">主角可能这样得知：${h(i.howCouldLearn)}</div>` : ''}
        ${i.basis ? `<div class="pe-muted pe-os-basis">依据：${h(i.basis)}</div>` : ''}</div>`).join('')}
      <div class="pe-actions"><div class="pe-actions-extra"></div><button class="pe-mini" data-act="os-del" data-id="${d.id}">删除这期</button></div></details>`;
    return `<h4>幕后 <small class="pe-muted">AI 依据推演补写的、聊天里没写到的事</small><span class="pe-spacer"></span>${ds.length ? '<button class="pe-mini" data-act="os-redo" title="重写最近一期">重写最近一期</button>' : ''}</h4>
      ${ds.length ? ds.slice(0, 2).map((d, i) => dg(d, i === 0)).join('') + (ds.length > 2 ? `<details class="pe-fold"><summary>更早的 ${ds.length - 2} 期</summary>${ds.slice(2).map(d => dg(d, false)).join('')}</details>` : '')
        : `<div class="pe-empty-sm">还没有。点右上角“一键推演到今天”，推演后会让 AI 补写（可在设置里改成不调用）。</div>`}`;
}


// ———————————— 整理包条目的编辑 ————————————
const BF_LABEL = { topic: '类别', knownBy: '知情者（JSON）', public: '已公开', publicSince: '公开日期', name: '名字', title: '作品名', aliases: '别名', owner: '真实作者', publicIdentityKnown: '身份已公开', knownBy: '知道作者身份的人', originalName: '原文名', periodicity: '出刊周期', weekday: '出刊星期（0=周日）', monthDays: '出刊日', circle: '读者圈子', tier: '影响力 1–5', politics: '倾向', real: '真实存在', note: '备注', roles: '身份', outlets: '供稿刊物', reads: '常读刊物', interests: '关注', likes: '欣赏', dislikes: '反感', closeness: '与主角私交', knowsIdentity: '知道主角是作者', monthlyCapacity: '每月公开文章上限', columnWeekday: '专栏星期（0=周日）', notes: '备注', relations: '熟人关系（JSON）', stances: '思想立场（JSON）', stylePrefs: '文体偏好（JSON）', penname: '署名', form: '形式', outlet: '刊物', pubDate: '发表日期', endDate: '连载结束日', datePrecision: '日期精度', themes: '题材', summary: '概要', versionOf: '另一版本的作品名', shelf: '长期流通（yes/no/空）', shelfUntil: '流通到', claims: '主张（JSON）', date: '日期', layer: '类型', person: '人物', work: '作品', polarity: '褒贬', count: '数量', evidence: '依据', read: '读到什么程度', text: '内容', strength: '热度 0–1', mode: '类型', belief: '看法', since: '起始日期', kind: '来源' };
Object.assign(BF_LABEL, { order: '写作顺序', mentions: '顺带提到的构想', stage: '进度', since: '第一次提起', premise: '设定与情节', question: '核心问题', forms: '考虑过的形式', project: '属于哪个构想', time: '时间', place: '地点', ref: '出处', present: '在场的人', points: '各人观点（JSON：by / kind / text / adopted）' });
const BF_SKIP = new Set(['rolesGiven']);
const BF_LONG = new Set(['summary', 'notes', 'note', 'text', 'evidence']);
const BF_ENUM = {
    periodicity: () => ({ '': '（未知）', ...PERIODICITY }), circle: () => ({ '': '（未知）', ...CIRCLES }), form: () => ({ '': '（未知）', ...FORMS }),
    layer: () => Object.fromEntries(Object.entries(LAYERS).map(([k, v]) => [k, v.label])), polarity: () => ({ 1: '肯定', 0: '褒贬参半', '-1': '批评' }),
    read: () => ({ finished: '读完', skimmed: '读了一部分' }), datePrecision: () => ({ '': '精确到日', xun: '只知道旬', month: '只知道月份', noLaterThan: '不晚于' }),
    closeness: () => ({ '': '（不改）', 0: '陌生', 1: '认识', 2: '朋友', 3: '至交' }),
    mode: () => SELF_MODE, kind: () => PERC_KIND, stage: () => PROJECT_STAGES,
    topic: k => Object.fromEntries((k === 'privateFacts' ? FACT_TOPICS : PERC_TOPICS).map(t => [t, t])),
};
function bitemSpec(k, x) {
    return Object.entries(x).filter(([f]) => !BF_SKIP.has(f)).map(([f, v]) => {
        const label = BF_LABEL[f] || f;
        if (f === 'roles') return { key: f, label, type: 'multi', options: ROLES };
        if (BF_ENUM[f]) return { key: f, label, type: 'select', options: BF_ENUM[f](k), numeric: f === 'polarity' || f === 'closeness' };
        if (typeof v === 'boolean' || ['publicIdentityKnown', 'real', 'knowsIdentity'].includes(f)) return { key: f, label, type: 'checkbox' };
        if (Array.isArray(v) && v.some(y => y && typeof y === 'object')) return { key: f, label, type: 'textarea', rows: 4, json: true };
        if (['relations', 'stances', 'stylePrefs', 'claims', 'knownBy', 'points'].includes(f)) return { key: f, label, type: 'textarea', rows: 3, json: true };
        if (Array.isArray(v)) return { key: f, label, type: 'tags', numeric: f === 'monthDays' };
        if (typeof v === 'number' || ['tier', 'count', 'strength', 'weekday', 'columnWeekday', 'monthlyCapacity'].includes(f)) return { key: f, label, type: 'number', step: f === 'strength' ? 0.05 : 1 };
        if (BF_LONG.has(f)) return { key: f, label, type: 'textarea', rows: 2 };
        return { key: f, label };
    });
}
function bitemEditor(k, x) {
    const spec = bitemSpec(k, x);
    const val = Object.fromEntries(spec.map(f => [f.key, f.json ? JSON.stringify(x[f.key] || [], null, 1) : x[f.key]]));
    return `<div class="pe-editor pe-bitem-editor" data-k="${k}">${formHtml(spec, val)}
      <div class="pe-actions"><div class="pe-actions-extra"></div><button data-act="bitem-cancel">取消</button><button class="pe-primary" data-act="bitem-save">保存这一条</button></div></div>`;
}
function bitemHint(k, x) {
    const bits = k === 'persons' ? [x.closeness != null ? ['陌生', '认识', '朋友', '至交'][x.closeness] : '', (x.outlets || []).join('、')]
        : k === 'works' ? [x.penname, x.outlet, FORMS[x.form] || ''] : k === 'outlets' ? [PERIODICITY[x.periodicity] || '', CIRCLES[x.circle] || '']
        : k === 'reactions' ? [x.outlet ? '《' + x.outlet + '》' : '', x.count ? '约 ' + x.count : '', x.summary ? truncate(x.summary, 40) : ''] : [];
    const t = bits.filter(Boolean).join(' · ');
    return t ? `<small class="pe-muted">${h(t)}</small>` : '';
}
function bundleItemAction(act, st, btn) {
    const b = st.pendingBundle;
    if (!b) return;
    if (act === 'bitem-edit') { bundleEdit = { k: btn.dataset.k, i: +btn.dataset.i }; refresh(); return; }
    if (act === 'bitem-cancel') { bundleEdit = null; refresh(); return; }
    if (act === 'bundle-edit-all') { bundleEdit = { all: true }; refresh(); return; }
    if (act === 'bitem-del') {
        const k = btn.dataset.k, i = +btn.dataset.i;
        const x = b[k]?.[i];
        if (!x) return;
        b[k].splice(i, 1);
        bundleEdit = null;
        commit(`已从整理包删掉：${x.name || x.title || x.text || x.date || ''}`);
        return;
    }
    if (act === 'bitem-save') {
        const { k, i } = bundleEdit || {};
        const root = document.querySelector('.pe-bitem-editor');
        if (!root || !b[k]?.[i]) return;
        const spec = bitemSpec(k, b[k][i]);
        const vals = readForm(root, spec);
        for (const f of spec) if (f.json) {
            try { vals[f.key] = JSON.parse(vals[f.key] || '[]'); } catch (e) { toast('warning', `“${f.label}”不是合法的 JSON：${e.message}`); return; }
        }
        for (const f of spec) if (f.type === 'select' && vals[f.key] === '') vals[f.key] = null;
        const r = replaceBundleItem(b, k, i, { ...b[k][i], ...vals });
        st.pendingBundle = r.bundle;
        bundleEdit = null;
        commit(`已修改${r.refs ? `，同步改了 ${r.refs} 处引用` : ''}${r.merged ? '，并与同名条目合并' : ''}`);
        return;
    }
    if (act === 'bundle-save-json') {
        const t = document.getElementById('pe-bundle-json')?.value || '';
        let obj;
        try { obj = JSON.parse(t); } catch (e) { toast('warning', 'JSON 有错：' + e.message); return; }
        st.pendingBundle = normalizeBundle(obj);
        bundleEdit = null;
        commit('整理包已更新');
    }
}


// ———————————— 一键推演（按钮和“每 N 楼”共用） ————————————
let simRunning = false;
export async function runSimNow(st, s, { auto = false, reason = '', until = null, rebaseFrom = null, chatSkip = 0 } = {}) {
    if (simRunning) { if (!auto) toast('info', '上一次推演还在进行，详情见控制台'); return false; }
    if (st.backfillRun) { clog('warn', '回溯推演进行中，跳过自动推演'); return false; }
    simRunning = true;
    pushUndo(st, auto ? `自动推演${reason ? '（' + reason + '）' : ''}` : '一键推演');
    const sigOf = () => [st.ledger.length, (st.receptions || []).length, (st.offscreen || []).length, (st.rumors || []).length, st.currentDate, (st.ledger || []).filter(e => e.text?.body).length, (st.receptions || []).filter(r => r.opinion).length].join('|');
    const sig0 = sigOf();
    try {
        if (auto) taskBegin(`自动推演${reason ? '（' + reason + '）' : ''}`);
        const early = st.works.filter(w => w.pubDate && st.currentDate && cmp(w.pubDate, st.currentDate) < 0);
        const engineRecs = (st.receptions || []).filter(r => r.origin !== 'manual').length;
        if (!st.backfilledAt && early.length && !engineRecs) {
            if (!auto && !confirm(`还没推演过 ${early.length} 部早先作品从发表到 ${st.currentDate} 的经过。现在一次补完（已导入的记录视为当时的全部公开报道和来信，只补阅读、私下看法和后续反响）？`)) return;
            setBusy('一键推演：从首次发表补到今天');
            let r;
            try { r = backfill(st, s, getEra(), { mode: 'hidden' }); } finally { setBusy(''); }
            st.backfilledAt = { at: new Date().toISOString(), mode: 'hidden', to: r.to };
            logLine(st, `一键推演（回溯）${r.from} → ${r.to}：读完 ${r.finished}、读了部分 ${r.skimmed}、接触未读 ${r.ignored}`);
            clog('info', `回溯 ${r.from} → ${r.to}：读完 ${r.finished}、读了部分 ${r.skimmed}、接触未读 ${r.ignored}`);
            commit(auto ? '' : `推演完成：${r.finished + r.skimmed} 人次读过作品${r.candidates ? `，${r.candidates} 条反响待审核` : ''}`);
            await aiFill(st, s, { from: null, to: st.currentDate, fresh: null, auto });
            return;
        }
        // 延迟模式：只推到 until（最新几楼之前的故事日期）
        const target = until ? (cmp(until, st.currentDate) > 0 ? until : st.currentDate)
            : st.detectedDate && cmp(st.detectedDate, st.currentDate) > 0 ? st.detectedDate : st.currentDate;
        const fromDate = lastFillTo(st) || null; // 第一次补完：从头算起
        const beforeRecs = new Set((st.receptions || []).map(x => x.id));
        const before = rebaseFrom != null ? { events: new Set(st.ledger.map(e => e.id)), recs: new Set(beforeRecs), os: new Set((st.offscreen || []).map(d => d.id)), rolls: new Set(Object.keys(st.rolls || {})), q: st.rollSeq || 0 } : null;
        if (until) clog('info', `延迟模式：按第 ${rebaseFrom} 楼之前的剧情推演，故事日期取 ${until}${st.detectedDate && cmp(st.detectedDate, until) > 0 ? `（最新几楼已到 ${st.detectedDate}，这次不算）` : ''}`);
        setBusy('一键推演到 ' + target);
        let r;
        try { r = doAdvance(st, s, target); if (target === st.detectedDate) st.detectedDate = null; } finally { setBusy(''); }
        if (r && !auto) toast(r.receptions ? 'success' : 'info', r.receptions ? `推演到 ${target}：新增 ${r.receptions} 条阅读记录${r.shelf ? `（其中成书长尾 ${r.shelf}）` : ''}${r.newCandidates.length ? `，${r.newCandidates.length} 条新反响` : ''}` : `推演已是最新：到 ${target} 为止没有新的人读到作品`);
        refresh();
        await aiFill(st, s, { from: fromDate, to: target, fresh: new Set((st.receptions || []).filter(x => !beforeRecs.has(x.id)).map(x => x.id)), auto, chatSkip });
        if (before) { const n = rebaseSnapshots(st, rebaseFrom, before, target); if (n) clog('info', `这次推演的结果已并入第 ${rebaseFrom} 楼之后的 ${n} 个回滚点：重roll最新几楼不会撤掉它`); saveState(); }
    } catch (err) {
        clog('error', `推演失败：${err.message || err}`, err.stack || null);
        const t = currentTask(); if (t) t.failed = true;
        if (!auto) throw err;
    } finally {
        if (auto) taskEnd();
        simRunning = false;
        if (sigOf() === sig0) popUndo(st); // 什么都没变：不留还原点
    }
}


// ———————————— 推荐的新人物：待确认 ————————————
function outletCheckBlock(st) {
    const list = (st.outletChecks || []).filter(x => x.status === 'pending');
    const card = x => { const o = byId(st.outlets, x.outletId); return `<div class="pe-card pe-sg pe-sg-${{ documented: 'high', likely: 'medium' }[x.certainty] || 'low'}"><div class="pe-card-main">
        <div><b>《${h(o?.name || '?')}》</b> <span class="pe-chip pe-sg-conf">${h(CERTAINTY[x.certainty])}</span></div>
        ${Object.entries(x.changes).map(([k, v]) => `<div>${h(OUT_FIELDS[k])}：<span class="pe-muted"><s>${h(fmtOutletVal(k, x.before[k]))}</s></span> → <b>${h(fmtOutletVal(k, v))}</b></div>`).join('')}
        ${x.why ? `<div class="pe-muted">依据：${h(x.why)}</div>` : ''}
      </div><div class="pe-card-actions"><button class="pe-primary" data-act="oc-accept" data-id="${x.id}" title="改刊物资料，并按新周期重排这家刊物上还没入账的推演反响">采纳并重排</button><button data-act="oc-reject" data-id="${x.id}">不要</button></div></div>`; };
    return `<details class="pe-fold" ${list.length ? 'open' : ''}><summary>AI 核对刊物资料 <span class="pe-muted">${list.length ? `${list.length} 家待确认` : '出刊周期、出刊日、圈子、倾向'}</span></summary>
      <div class="pe-muted">刊物周期填错了（比如把月刊当成周刊），排出来的见报日期、截稿、每期篇数都会跟着错。让 AI 按当时的实际情况核对一遍（调用 1 次），只列有出入的。<b>模型不联网</b>，依据是它的记忆，采纳前请核对。月刊、半月刊不知道具体出刊日就别填，插件会把日期标成“约 某月号”。</div>
      ${list.map(card).join('')}
      <div class="pe-actions"><div class="pe-actions-extra"></div><button class="pe-primary" data-act="oc-run" title="调用 1 次 AI">✦ AI 核对刊物资料</button></div></details>`;
}
async function outletCheckAction(act, st, s, btn) {
    if (act === 'oc-run') {
        taskBegin('AI 核对刊物资料');
        let r;
        try { r = await checkOutlets(st, { to: st.currentDate || '', era: getEra(), settings: s }); } finally { taskEnd(); }
        commit(r.length ? `${r.length} 家刊物资料有出入，待你确认` : '没发现出入');
        return;
    }
    const x = (st.outletChecks || []).find(y => y.id === btn.dataset.id);
    if (!x) return;
    if (act === 'oc-reject') { x.status = 'rejected'; commit(); return; }
    pushUndo(st, '采纳刊物资料核对');
    const o = acceptOutletCheck(st, x);
    const n = rerollOutlet(st, x.outletId);
    if (st.currentDate) advanceTo(st, st.currentDate, s, getEra());
    commit(`已改《${o?.name}》的资料${n ? `，按新周期重排了 ${n} 条还没入账的反响` : ''}（已入账的不动）`);
}
function relSuggestBlock(st) {
    const list = (st.relSuggestions || []).filter(x => x.status === 'pending');
    const nm = id => byId(st.persons, id)?.name || '?';
    const card = x => `<div class="pe-card pe-sg pe-sg-${{ documented: 'high', likely: 'medium' }[x.certainty] || 'low'}"><div class="pe-card-main">
        <div><b>${h(nm(x.fromId))}</b> ${x.rel.mutual ? '⇄' : '→'} <b>${h(nm(x.toId))}</b>：${h(REL_TYPES[x.rel.type] || x.rel.type)}，${h(CLOSE[x.rel.closeness ?? 1])}，${h(REL_FREQ[x.rel.frequency] || '')}${x.rel.since ? '，自 ' + h(x.rel.since) : ''}${x.rel.until ? ' 至 ' + h(x.rel.until) : ''} <span class="pe-chip pe-sg-conf">${h(CERTAINTY[x.certainty])}</span>${x.rel.mutual ? ' <span class="pe-chip">双方都算</span>' : ''}</div>
        <div class="pe-muted">${h(x.rel.evidence.replace(/^AI 提供，未联网核实：/, ''))}</div>
      </div><div class="pe-card-actions"><button class="pe-primary" data-act="rs-accept" data-id="${x.id}" title="按“${h(REL_BASIS[x.rel.basis])}”写进${h(nm(x.fromId))}的关系">采纳</button>${x.rel.basis === 'history' ? `<button data-act="rs-guess" data-id="${x.id}" title="写进关系，但依据标为“推测”（图上画虚线）">当推测采纳</button>` : ''}<button data-act="rs-reject" data-id="${x.id}" title="不要，以后也不再提">不要</button></div></div>`;
    return `<details class="pe-fold" ${list.length ? 'open' : ''}><summary>AI 查到的人物关系 <span class="pe-muted">${list.length ? `${list.length} 条待确认` : '暂无待确认'}</span></summary>
      <div class="pe-muted">让 AI 按它记得的史料，找出人物表里这些人彼此之间截至今天的真实关系（谁和谁是朋友、通信、决斗后和解、在哪次聚会见过），顺带推荐不在表里、但能把消息从一个圈子带到另一个圈子的人。<b>模型不联网</b>，“有明确史料”也只是它的记忆，可能记错日期或张冠李戴：采纳前请核对，拿不准的用“当推测采纳”。虚构人物之间不查。</div>
      ${list.map(card).join('')}
      <div class="pe-actions"><div class="pe-actions-extra"><label class="pe-check-inline"><input type="checkbox" id="pe-rs-middle" checked> 顺带推荐中转人物</label>${list.length ? `<button data-act="rs-accept-doc" title="把“有明确史料”的全部采纳">采纳全部“有明确史料”的</button>` : ''}</div><button class="pe-primary" data-act="rs-run" title="调用 1 次 AI">✦ AI 查人物关系</button></div></details>`;
}
async function relSuggestAction(act, st, s, btn) {
    if (act === 'rs-run') {
        if (!st.currentDate) return toast('warning', '先设定故事日期');
        const focusIds = btn.dataset.focus ? [btn.dataset.focus] : null;
        const withMiddle = document.getElementById('pe-rs-middle')?.checked ?? !focusIds;
        taskBegin('AI 查人物关系');
        let r;
        try { r = await suggestRelations(st, { to: st.currentDate, era: getEra(), settings: s, focusIds, withMiddle }); } finally { taskEnd(); }
        commit(`查到 ${r.out.length} 条关系待确认${r.mids.length ? `，推荐中转人物 ${r.mids.length} 位（在“AI 推荐的新人物”里）` : ''}${r.skipped.length ? `；跳过 ${r.skipped.length} 条（详见控制台）` : ''}`);
        return;
    }
    if (act === 'rs-accept-doc') {
        const list = (st.relSuggestions || []).filter(x => x.status === 'pending' && x.certainty === 'documented');
        if (!list.length) return toast('info', '没有“有明确史料”的待确认关系');
        pushUndo(st, '采纳 AI 查到的关系');
        for (const x of list) acceptRelSuggestion(st, x);
        commit(`采纳了 ${list.length} 条`);
        return;
    }
    const x = (st.relSuggestions || []).find(y => y.id === btn.dataset.id);
    if (!x) return;
    if (act === 'rs-reject') { x.status = 'rejected'; commit('不要这条，以后不再提'); return; }
    pushUndo(st, '采纳 AI 查到的关系');
    acceptRelSuggestion(st, x, { asGuess: act === 'rs-guess' });
    commit(`已写进 ${byId(st.persons, x.fromId)?.name} 的关系${act === 'rs-guess' ? '（标为推测）' : ''}`);
}
function suggestBlock(st) {
    const list = (st.personSuggestions || []).filter(x => x.status === 'pending');
    const CONF = { high: '把握大', medium: '把握一般', low: '把握小，请核实' };
    const card = x => `<div class="pe-card pe-sg pe-sg-${x.confidence}"><div class="pe-card-main">
        <div><b>${h(x.name)}</b> ${x.originalName ? `<span class="pe-muted">${h(x.originalName)}</span>` : ''} ${x.lifespan ? `<span class="pe-muted">${h(x.lifespan)}</span>` : ''} <span class="pe-chip pe-sg-conf">${CONF[x.confidence]}</span></div>
        <div class="pe-muted">${(x.roles || []).map(r => ROLES[r] || r).join('/')}${x.outlets.length ? ' · 供稿：' + h(x.outlets.join('、')) : ''}${x.reads.length ? ' · 常读：' + h(x.reads.join('、')) : ''}</div>
        ${x.kind === 'intermediary' ? '<div><span class="pe-chip">关系中转人物</span></div>' : ''}<div><b>为什么：</b>${h(x.why)}</div>
        ${x.how ? `<div><b>${x.kind === 'intermediary' ? '往来' : '怎样读到'}：</b>${h(x.kind === 'intermediary' ? x.how.replace(/^关系中转：/, '') : x.how)}</div>` : ''}
        ${x.whichWorks.length ? `<div><b>可能读的作品：</b>${x.whichWorks.map(t => bt(t)).join('、')}</div>` : ''}
        ${x.stances.length ? `<div class="pe-ideas">${x.stances.map(t => `<span class="pe-idea ${t.side === 'pro' ? 'pe-idea-ok' : t.side === 'con' ? 'pe-idea-no' : 'pe-idea-mid'}">${h(t.issue)}：${({ pro: '支持', con: '反对', mixed: '有保留' })[t.side] || ''}${t.note ? '——' + h(t.note) : ''}</span>`).join('')}</div>` : ''}
        ${x.interests.length || x.likes.length || x.dislikes.length ? `<div class="pe-muted">关注：${h(x.interests.join('、') || '—')}；欣赏：${h(x.likes.join('、') || '—')}；反感：${h(x.dislikes.join('、') || '—')}</div>` : ''}
      </div><div class="pe-card-actions"><button class="pe-primary" data-act="sg-accept" data-id="${x.id}">加入人物表</button><button data-act="sg-reject" data-id="${x.id}" title="不加，以后也不再推荐此人">不要</button></div></div>`;
    return `<details class="pe-fold" ${list.length ? 'open' : ''}><summary>AI 推荐的新人物 <span class="pe-muted">${list.length ? `${list.length} 位待确认` : '暂无待确认'}</span></summary>
      <div class="pe-muted">按作品的刊物、读者圈子、题材和主张，推荐当时真实存在、可能读到作品的人。AI 可能记错此人当时是否活跃、在哪家刊物供稿、立场如何，加入前请核对；加入后可以在人物表里改。加入后立即参与推演（不调用 AI）。</div>
      ${list.map(card).join('')}
      <div class="pe-actions"><div class="pe-actions-extra"></div><button data-act="sg-suggest" title="调用 1 次 AI">现在推荐一次</button></div></details>`;
}
async function suggestAction(act, st, s, btn) {
    if (act === 'sg-suggest') {
        if (!st.currentDate) return toast('warning', '先设定故事日期');
        taskBegin('推荐可能读到作品的新人物');
        try { const got = await suggestPersons(st, { to: st.currentDate, era: getEra(), settings: s }); commit(got.length ? `推荐了 ${got.length} 位，待你确认` : '没有新的推荐（可能都已在人物表里）'); } finally { taskEnd(); }
        return;
    }
    const sg = (st.personSuggestions || []).find(x => x.id === btn.dataset.id);
    if (!sg) return;
    if (act === 'sg-reject') { sg.status = 'rejected'; commit(`不加入 ${sg.name}，以后不再推荐`); return; }
    pushUndo(st, `加入推荐人物 ${sg.name}`);
    const { person, createdOutlets } = acceptSuggestion(st, sg);
    clog('info', `加入人物：${person.name}${createdOutlets.length ? `；新建刊物 ${createdOutlets.join('、')}（出刊周期待补）` : ''}`);
    // 立刻让他参与到今天为止的推演（不调用 AI）
    const before = (st.receptions || []).length;
    if (st.currentDate) advanceTo(st, st.currentDate, s, getEra());
    const n = (st.receptions || []).filter(r => r.personId === person.id && r.read && r.read !== 'none').length;
    commit(`已加入 ${person.name}${createdOutlets.length ? `，新建刊物 ${createdOutlets.join('、')}（请补全出刊周期）` : ''}；推演到今天：接触到 ${n} 部作品${(st.receptions || []).length > before ? '' : ''}`);
}


// ———————————— 撤销 ————————————
function doUndo() {
    const st = getState();
    const u = st && popUndo(st);
    if (!u) return toast('info', '没有可以撤销的操作');
    if (!confirm(`撤销“${u.label}”？会回到这一步之前的状态（之后的改动也会一起丢掉）。`)) { pushUndoBack(st, u); return; }
    replaceState(u.state);
    clog('info', `已撤销：${u.label}`);
    commit(`已撤销：${u.label}`);
    app?.refreshInjection?.();
}
function pushUndoBack(st, u) { pushUndo(Object.assign(JSON.parse(JSON.stringify(u.state)), { storeId: st.storeId }), u.label); }


function loreBlock(st) {
    const s = getSettings();
    const c = globalThis.SillyTavern?.getContext?.();
    const bound = c?.chatMetadata?.world_info;
    const name = s.loreBook || '报刊回声';
    const n = lorePersons(st, s.loreScope).length;
    return `<details class="pe-fold"><summary>世界书 <span class="pe-muted">${s.loreEnabled ? `已开启 · ${st.lore?.at ? '上次同步 ' + new Date(st.lore.at).toLocaleString() : '还没同步过'}` : '未开启'}</span></summary>
      <div class="pe-muted">把 ${n} 位人物${s.loreWorks !== false ? '和已发表的作品' : ''}写进世界书“${h(name)}”：人物条目写立场、与主角的私交、是否知道笔名真相、读过哪些作品、私下怎么看；作品条目只写公开信息。聊天里提到名字时才进入上下文。</div>
      ${bound && bound !== name ? `<div class="pe-callout pe-callout-warn"><div>本聊天已绑定世界书“${h(bound)}”，“${h(name)}”需要你在酒馆的世界书设置里全局启用，或者把名称改成“${h(bound)}”写进同一本。</div></div>` : ''}
      <div class="pe-actions"><div class="pe-actions-extra">${s.loreEnabled ? '' : '<button data-act="lore-on">开启（数据变化时自动同步）</button>'}</div><button class="pe-primary" data-act="lore-sync">现在同步到世界书</button></div></details>`;
}


/** 写好或入账之后：私信按设置自动寄进书信簿 */
async function afterWrite(st, s, ev) {
    if (ev?.layer !== 'private_letter' || ev.status !== 'approved' || !ev.text?.body || ev.epiSent) return;
    if (s.epiEnabled === false || !s.epiSendAuto || !epistolaryWritable()) return;
    if (ev.text.stanceOnly) { clog('info', `${byId(st.persons, ev.personId)?.name || ''} 的私信只是立场摘要，没有寄进书信簿`); return; }
    try {
        const r = await sendToEpistolary(st, ev, { person: byId(st.persons, ev.personId) });
        if (!r.existed) { clog('info', `私信寄进书信簿：${r.letter.id} ${r.letter.code || ''}（${r.letter.author} → ${r.letter.recipients.join('、')}）`); toast('info', `${r.letter.author} 的来信已放进书信簿 ${r.letter.code || ''}`); }
    } catch (e) { clog('error', `寄进书信簿失败：${e.message}`); }
}


// ———————————— 时间线与关系网的页面 ————————————
function timelinePage(st) {
    const tl = workTimeline(st, simView.workId);
    if (!tl) return '<div class="pe-toolbar"><button data-act="sim-close">← 返回</button></div><div class="pe-empty">作品不存在。</div>';
    const w = tl.work;
    const cnt = k => tl.items.filter(i => i.lane === k && !i.tick).length;
    const LN = { press: '见报', letter: '私信', agg: '来信·转载', read: '读到', talk: '谈起', off: '幕后' };
    return `<div class="pe-toolbar"><button data-act="sim-close">← 返回</button>
        <select id="pe-tl-work">${[...st.works].filter(x => x.pubDate).sort((a, b) => cmp(a.pubDate, b.pubDate)).map(x => `<option value="${h(x.id)}" ${x.id === w.id ? 'selected' : ''}>${h(x.title)}（${h(x.pubDate)}）</option>`).join('')}</select>
        <span class="pe-muted">只显示到 ${h(st.currentDate || '今天')} 为止发生的事</span></div>
      <h4>${bt(w.title)} ${penChip(st, w.pennameId)} 反响时间线</h4>
      <div class="pe-stats">
        <div class="pe-stat"><b>${cnt('read')}</b><span>人读过</span></div>
        <div class="pe-stat"><b>${cnt('press')}</b><span>篇见报评论</span></div>
        <div class="pe-stat"><b>${cnt('letter')}</b><span>封私信</span></div>
        <div class="pe-stat"><b>${cnt('talk')}</b><span>次熟人谈起</span></div>
      </div>
      <div class="pe-tl-legend"><span><i class="dot" style="background:var(--pe-good)"></i>偏肯定</span><span><i class="dot" style="background:var(--pe-mid)"></i>参半</span><span><i class="dot" style="background:var(--pe-bad)"></i>偏批评</span>
        <span><i class="dot hollow"></i>只读了一部分</span><span><i class="tick"></i>接触到但没读</span><span><i class="dia"></i>幕后</span><span><i class="dot" style="background:var(--pe-accent)"></i>来信/转载（越大越多）</span><span class="pe-muted">鼠标停在点上看详情</span></div>
      <div class="pe-tl-wrap">${timelineSvg(st, tl)}</div>
      <details class="pe-fold"><summary>按时间列出全部 ${tl.items.length} 条</summary>
        <div class="pe-tl-table">${tl.items.map(i => `<div><span class="pe-card-date">${h(i.date)}</span><span class="pe-chip">${LN[i.lane]}</span>${h(i.tip.split('\n').slice(0, 3).join(' · ').replace(/^\S+\s/, ''))}</div>`).join('') || '<div class="pe-empty-sm">还没有任何动静。</div>'}</div></details>`;
}

let nwCache = null;
function networkPage(st) {
    const v = simView;
    const asOf = v.asOf || st.currentDate || '';
    const full = networkData(st, { asOf, implicit: !!v.implicit });
    const data = visibleNetwork(full, v.show, !!v.hideIso);
    const P = layoutNetwork(full, v.pos || {});
    v.pos = P;
    nwCache = data;
    const n = k => full.edges.filter(e => e.kind === k).length;
    const nc = c => full.edges.filter(e => e.kind === 'rel' && e.cat === c).length;
    const box = (k, lab, cls, cnt) => `<label class="pe-check-inline pe-nw-key ${cls}"><input type="checkbox" data-nw="${k}" ${v.show[k] !== false ? 'checked' : ''}><i></i>${lab} <span class="pe-muted">${cnt}</span></label>`;
    const persons = (st.persons || []).filter(p => p.active !== false);
    const popt = sel => `<option value="">（选人物）</option>${persons.map(p => `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${h(p.name)}</option>`).join('')}`;
    return `<div class="pe-toolbar"><button data-act="sim-close">← 返回</button>
        <label class="pe-inline-field">截至 <input type="text" class="text_pole pe-pc-date" data-nwv="asOf" value="${h(asOf)}" placeholder="YYYY-MM-DD"></label>
        <label class="pe-check-inline"><input type="checkbox" data-nwv="hideIso" ${v.hideIso ? 'checked' : ''}> 隐藏没有连线的人</label>
        <label class="pe-check-inline" title="同一刊物的同事，没手填关系时推演也会按“每周见、一般熟”算"><input type="checkbox" data-nwv="implicit" ${v.implicit ? 'checked' : ''}> 显示同刊同事（自动）</label>
        <span class="pe-spacer"></span><button data-act="nw-relayout">重新排布</button></div>
      <h4>人物关系网 <span class="pe-muted">截至 ${h(asOf || '今天')}：只画那天有效的关系和已经发生的传递</span></h4>
      <div class="pe-tl-legend">${box('cat_private', '私人关系', 'k-private', nc('private'))}${box('cat_literary', '文学与工作', 'k-literary', nc('literary'))}${box('cat_social', '社交场合', 'k-social', nc('social'))}${box('close', '与主角的私交', 'k-close', n('close'))}${box('talk', '谈起作品', 'k-talk', n('talk'))}${box('leak', '可能泄露身份/私事', 'k-leak', n('leak'))}</div>
      <div class="pe-tl-legend">${Object.entries({ 0: '陌生', 1: '认识', 2: '朋友', 3: '至交' }).map(([k, l]) => `<span><i class="dot" style="background:${CLOSE_COLOR[k]}"></i>${l}</span>`).join('')}<span class="pe-muted">（人物颜色＝与主角的交情）</span><span><i class="dot ring"></i>知道笔名是主角</span><span class="pe-muted">圆越大，读过主角的作品越多</span></div>
      <div class="pe-tl-legend pe-muted"><span><i class="ln"></i>实线：史料或剧情里有据</span><span><i class="ln dash"></i>虚线：推测</span><span><i class="ln dot2"></i>点线：同刊同事（自动）</span><span>→ 单向：只有一方写了这层关系（A 把 B 当熟人，不等于 B 也这样）；没箭头＝双方都算</span><span>读过作品≠认识作者：只有与主角有私交的人才连到主角</span></div>
      <div class="pe-nw-wrap">${networkSvg(st, data, P, v.show)}</div>
      <div class="pe-muted">点人物看他的一度、二度关系；点连线看两人之间的关系依据和实际传过的话。拖动可以挪位置。</div>
      ${nwDetail(st, v, asOf)}
      <div class="pe-card pe-nw-path"><b>两人之间的信息路径</b> <span class="pe-muted">最多三跳；有路径不等于传过话，每一跳都标出是否真的谈起过</span>
        <div class="pe-row pe-pc-form"><select class="text_pole" data-nwv="pa">${popt(v.pa)}</select> → <select class="text_pole" data-nwv="pb">${popt(v.pb)}</select></div>
        ${v.pa && v.pb && v.pa !== v.pb ? nwPaths(st, v, asOf) : ''}</div>`;
}
function nwRelText(st, r) {
    const nm = id => byId(st.persons, id)?.name || '?';
    return `${h(nm(r.from))} → ${h(nm(r.to))}：${h(REL_TYPES[r.type] || r.type)}，${h(CLOSE[r.closeness ?? 1])}，${h(REL_FREQ[r.frequency] || '')}${r.since ? '，自 ' + h(r.since) : ''}${r.until ? ' 至 ' + h(r.until) : ''}${isMutual(r) ? '（双方都算）' : ''} <span class="pe-chip">${h(REL_BASIS[r.basis] || '依据未注明')}</span>${r.evidence ? `<div class="pe-muted">依据：${h(r.evidence)}</div>` : ''}`;
}
function nwDetail(st, v, asOf) {
    const sel = v.sel;
    if (!sel) return '';
    const nm = id => byId(st.persons, id)?.name || '?';
    if (sel.kind === 'edge') {
        const rels = relationsBetween(st, sel.a, sel.b, asOf);
        const flows = edgeFlows(st, sel.a, sel.b, asOf);
        return `<div class="pe-card pe-nw-detail"><div class="pe-row"><b>${h(nm(sel.a))} — ${h(nm(sel.b))}</b><span class="pe-spacer"></span><button class="pe-mini" data-act="nw-unsel">✕</button></div>
          <h5>关系</h5>${rels.length ? rels.map(r => `<div class="pe-op-line">${nwRelText(st, r)}</div>`).join('') : '<div class="pe-muted">两人之间没有手填的关系（可能是同刊同事自动算的，或只有传话记录）</div>'}
          <h5>实际传过的话</h5>${flows.length ? flows.map(f => `<div class="pe-op-line">${h(f.text)}</div>`).join('') : '<div class="pe-muted">截至此日，推演里两人之间没有谈起主角的作品、也没有泄露过什么</div>'}
          <div class="pe-row"><span class="pe-spacer"></span><button data-act="edit-item" data-kind="person" data-id="${sel.a}">编辑 ${h(nm(sel.a))} 的关系</button></div></div>`;
    }
    const p = byId(st.persons, sel.id); if (!p) return '';
    const one = new Map();
    for (const q of st.persons || []) {
        if (q.id === p.id || q.active === false) continue;
        const rels = relationsBetween(st, p.id, q.id, asOf);
        if (rels.length) one.set(q.id, rels);
    }
    const two = new Map();
    for (const qid of one.keys()) for (const q of st.persons || []) {
        if (q.id === p.id || one.has(q.id) || q.active === false) continue;
        if (relationsBetween(st, qid, q.id, asOf).length) { if (!two.has(q.id)) two.set(q.id, []); two.get(q.id).push(qid); }
    }
    const reads = (st.receptions || []).filter(r => r.personId === p.id && READ_DONE.includes(r.read) && (!asOf || !r.readDate || cmp(r.readDate, asOf) <= 0));
    return `<div class="pe-card pe-nw-detail"><div class="pe-row">${personTag(p)} <span class="pe-muted">与主角：${h(CLOSE[p.closeness || 0])}</span><span class="pe-spacer"></span><button class="pe-mini" data-act="nw-unsel">✕</button></div>
      <h5>一度关系 <span class="pe-muted">${one.size}</span></h5>${[...one.entries()].map(([qid, rels]) => `<div class="pe-op-line"><button class="pe-linkbtn" data-act="nw-pick" data-id="${qid}">${h(nm(qid))}</button>　${rels.map(r => `${r.from === p.id ? '→' : '←'} ${h(REL_TYPES[r.type] || r.type)}${r.basis === 'guess' ? '（推测）' : ''}`).join('；')}</div>`).join('') || '<div class="pe-muted">没有手填的关系</div>'}
      <h5>二度关系 <span class="pe-muted">${two.size}，经由谁</span></h5>${[...two.entries()].map(([qid, via]) => `<div class="pe-op-line"><button class="pe-linkbtn" data-act="nw-pick" data-id="${qid}">${h(nm(qid))}</button>　<span class="pe-muted">经 ${via.map(x => h(nm(x))).join('、')}</span></div>`).join('') || '<div class="pe-muted">无</div>'}
      <h5>他怎么接触到主角的作品</h5>${reads.length ? reads.map(r => `<div class="pe-op-line">《${h(byId(st.works, r.workId)?.title || '?')}》 ${h(r.readDate || '')} · ${h(CHANNELS[r.channel] || r.channel || '')}${r.channel === 'recommend' && st.recommends?.[r.workId]?.[r.personId] ? ' · ' + h(nm(st.recommends[r.workId][r.personId].by)) + ' 谈起' : ''}</div>`).join('') : '<div class="pe-muted">截至此日没有读过</div>'}
      <div class="pe-row"><span class="pe-spacer"></span><button data-act="rs-run" data-focus="${p.id}" title="让 AI 按史料找他和表里其他人的关系（调用 1 次），结果在“人物与刊物”页待确认">✦ AI 查他的关系</button><button data-act="nw-path-from" data-id="${p.id}">从他查信息路径</button><button data-act="edit-item" data-kind="person" data-id="${p.id}">编辑关系</button></div></div>`;
}
function nwPaths(st, v, asOf) {
    const nm = id => byId(st.persons, id)?.name || '?';
    const paths = findPaths(st, v.pa, v.pb, { asOf, implicit: !!v.implicit });
    const own = (st.receptions || []).filter(r => r.personId === v.pb && READ_DONE.includes(r.read) && (!asOf || !r.readDate || cmp(r.readDate, asOf) <= 0));
    const ownHtml = own.length ? `<div class="pe-muted">${h(nm(v.pb))} 自己接触作品的渠道：${own.map(r => `《${h(byId(st.works, r.workId)?.title || '?')}》${h(CHANNELS[r.channel] || r.channel || '')}${r.channel === 'recommend' && st.recommends?.[r.workId]?.[r.personId] ? '（' + h(nm(st.recommends[r.workId][r.personId].by)) + ' 谈起）' : ''}`).join('；')}——不要把他读到归功给路径上的人</div>` : '';
    if (!paths.length) return `<div class="pe-muted">三跳之内没有关系路径：两人之间的消息只能经过报刊、沙龙之类的公开渠道。</div>${ownHtml}`;
    return paths.map(pt => `<div class="pe-nw-pathrow ${pt.realized ? 'done' : ''}">${pt.realized ? '<span class="pe-chip pe-chip-warn">每一跳都真的传过</span> ' : ''}${h(nm(pt.ids[0]))}${pt.hops.map(hp => ` <span class="pe-nw-hop ${hp.flows.length ? 'on' : ''}" data-tip="${h(hp.rels.map(r => `${nm(r.from)}→${nm(r.to)} ${REL_TYPES[r.type] || r.type}${r.basis ? '（' + (REL_BASIS[r.basis] || '') + '）' : ''}`).join('\n') || '同刊同事（自动）')}${hp.flows.length ? '\n' + hp.flows.map(f => f.text).join('\n') : '\n这一跳没有传过话'}">${hp.flows.length ? '⇒' : '→'}</span> ${h(nm(hp.b))}`).join('')}</div>`).join('') + `<div class="pe-muted">⇒ 这一跳在推演里真的谈起过主角的作品或说过主角的事；→ 只是有关系。</div>${ownHtml}`;
}
function bindNetwork() {
    const svg = document.getElementById('pe-nw');
    if (!svg || svg.dataset.bound) return;
    svg.dataset.bound = '1';
    const toSvg = ev => { const pt = svg.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY; return pt.matrixTransform(svg.getScreenCTM().inverse()); };
    let drag = null;
    svg.addEventListener('pointerdown', ev => {
        const g = ev.target.closest('.pe-nw-n'); if (!g) return;
        drag = g.dataset.id; ev.preventDefault();
    });
    svg.addEventListener('pointermove', ev => {
        if (!drag) return;
        const p = toSvg(ev); const P = simView.pos; P[drag] = { x: Math.max(20, Math.min(880, p.x)), y: Math.max(20, Math.min(600, p.y)) };
        svg.querySelector(`.pe-nw-n[data-id="${drag}"]`)?.setAttribute('transform', `translate(${P[drag].x.toFixed(1)},${P[drag].y.toFixed(1)})`);
        svg.querySelectorAll(`line[data-a="${drag}"]`).forEach(l => { l.setAttribute('x1', P[drag].x); l.setAttribute('y1', P[drag].y); });
        svg.querySelectorAll(`line[data-b="${drag}"]`).forEach(l => { l.setAttribute('x2', P[drag].x); l.setAttribute('y2', P[drag].y); });
    });
    let moved = false, downAt = null;
    svg.addEventListener('pointerdown', ev => { moved = false; downAt = { x: ev.clientX, y: ev.clientY }; }, true);
    svg.addEventListener('pointermove', ev => { if (downAt && Math.abs(ev.clientX - downAt.x) + Math.abs(ev.clientY - downAt.y) > 4) moved = true; }, true);
    const end = ev => {
        const wasDrag = drag; drag = null;
        if (moved || !downAt) { downAt = null; return; }
        downAt = null;
        // 点击（没拖动）：选中人物或连线，下方显示详情
        const g = ev.target.closest?.('.pe-nw-n');
        if (g && g.dataset.id !== '__me') { simView.sel = { kind: 'node', id: g.dataset.id }; refresh(); return; }
        const hit = ev.target.closest?.('[data-edge]');
        if (hit && !wasDrag) { const [a, b] = hit.dataset.edge.split('|'); if (a !== '__me' && b !== '__me') { simView.sel = { kind: 'edge', a, b }; refresh(); } }
    };
    svg.addEventListener('pointerup', end); svg.addEventListener('pointercancel', () => { drag = null; downAt = null; });
    svg.addEventListener('mouseover', ev => {
        const g = ev.target.closest('.pe-nw-n'); if (!g || drag) return;
        const id = g.dataset.id;
        svg.classList.add('focus');
        const near = new Set([id]);
        svg.querySelectorAll('line.pe-nw-e').forEach(l => { const on = l.dataset.a === id || l.dataset.b === id; l.classList.toggle('hi', on); if (on) { near.add(l.dataset.a); near.add(l.dataset.b); } });
        svg.querySelectorAll('.pe-nw-n').forEach(n => n.classList.toggle('hi', near.has(n.dataset.id)));
    });
    svg.addEventListener('mouseout', ev => { if (!ev.relatedTarget || !ev.relatedTarget.closest?.('.pe-nw-n')) { svg.classList.remove('focus'); svg.querySelectorAll('.hi').forEach(x => x.classList.remove('hi')); } });
}

// 悬停提示：图上带 data-tip 的元素
function bindTips(panel) {
    let tip = null;
    panel.addEventListener('mousemove', ev => {
        const t = ev.target.closest?.('#pe-body [data-tip]');
        if (!t) { if (tip) tip.hidden = true; return; }
        if (!tip) { tip = document.createElement('div'); tip.className = 'pe-tip'; panel.appendChild(tip); }
        tip.textContent = t.dataset.tip; tip.hidden = false;
        const r = panel.getBoundingClientRect();
        let x = ev.clientX - r.left + 14, y = ev.clientY - r.top + 14;
        if (x + 280 > r.width) x = ev.clientX - r.left - 290;
        if (y + tip.offsetHeight > r.height) y = ev.clientY - r.top - tip.offsetHeight - 10;
        tip.style.left = x + 'px'; tip.style.top = y + 'px';
    });
    panel.addEventListener('mouseleave', () => { if (tip) tip.hidden = true; });
}


function paperPage(st) {
    const outlets = st.outlets.filter(o => paperDates(st, o.id).length);
    const dates = paperDates(st, simView.outletId);
    if (!dates.includes(simView.date) && dates.length) simView.date = dates[0];
    return `<style>${PAPER_CSS}</style>
      <div class="pe-toolbar"><button data-act="sim-close">← 返回</button>
        <select id="pe-pp-outlet">${outlets.map(o => `<option value="${h(o.id)}" ${o.id === simView.outletId ? 'selected' : ''}>${h(o.name)}（${paperDates(st, o.id).length} 期）</option>`).join('')}</select>
        <select id="pe-pp-date">${dates.map(d => `<option value="${d}" ${d === simView.date ? 'selected' : ''}>${d} · ${h(frDate(d))}</option>`).join('')}</select>
        <select id="pe-pp-span"><option value="day" ${simView.span === 'day' ? 'selected' : ''}>当天这一期</option><option value="week" ${simView.span === 'week' ? 'selected' : ''}>这一周合在一版</option></select>
        <span class="pe-seg">${[['fr', '法语'], ['both', '法语＋译文'], ['zh', '中文']].map(([k, v]) => `<button class="${(simView.lang || 'fr') === k ? 'on' : ''}" data-act="paper-lang" data-lang="${k}">${v}</button>`).join('')}</span>
        <span class="pe-spacer"></span><button data-act="paper-window" title="在新窗口里打开，方便截图或打印成 PDF">新窗口打开</button><button data-act="paper-download">下载 HTML</button></div>
      ${(() => { const miss = paperMissingFr(st, simView.outletId, simView.date, simView.span); const has = paperItems(st, simView.outletId, simView.date, simView.span).some(e => e.text?.fr);
        return (simView.lang || 'fr') !== 'zh' && miss.length ? `<div class="pe-callout"><div>这一版有 ${miss.length} 篇还没有法语稿，暂时先排中文。</div><button class="pe-primary" data-act="paper-fr">生成法语原文（调用 AI ${Math.max(1, Math.ceil(miss.reduce((n, e) => n + (e.text.body || e.text.summary || '').length, 0) / 7000))} 次）</button></div>`
          : has ? `<div class="pe-actions"><div class="pe-actions-extra"></div><button data-act="paper-fr" data-redo="1" title="中文稿改过、或想换一种译法时">重新生成这一版的法语稿</button></div>` : ''; })()}
      <div class="pe-muted">以法语为主：法语稿由 AI 依据中文稿还原成当时的报刊法语，人名、刊名、作品名用人物和刊物资料里的西文原名（作品的西文名写在作品的“别名”里，刊物的写在“原文刊名”里）。中文稿重写后，法语稿会作废，需要重新生成。只排已入账、主角看得到的文章；真实人物默认只有“立场摘要”。</div>
      <div class="pe-paper-wrap">${paperHtml(st, simView.outletId, simView.date, simView.span, simView.lang || 'fr')}</div>`;
}


// ———————————— 年代档案按季度 / 按月刷新 ————————————
let eraRunning = false;
function checkEraRefresh(st, s) {
    if (!st || st.backfillRun || eraRunning) return;
    const due = eraDue(getEra(), st.currentDate, s.eraRefresh || 'quarter');
    if (!due) return;
    st.eraDone = st.eraDone || {};
    if (st.eraDone[due.key]) return;
    if ((s.eraRefreshMode || 'auto') === 'remind') {
        st.eraDone[due.key] = 'reminded'; saveState();
        toast('info', `故事进入${due.label}，年代档案还停在 ${due.asOf}。到“年代”页刷新，或在概览里点“刷新年代档案”`);
        return;
    }
    st.eraDone[due.key] = 'running'; saveState();
    eraRunning = true;
    taskBegin(`按${due.label}刷新年代档案`);
    doEra(st, s, s.wikiEnabled !== false, { focus: due, auto: true })
        .catch(e => { st.eraDone[due.key] = 'failed'; clog('error', `年代档案刷新失败：${e.message}`, e.stack || null); saveState(); })
        .finally(() => { eraRunning = false; taskEnd(); });
}
export { checkEraRefresh };


// ———————————— 主角的私人信息与知情者 ————————————
function kbRow(st, k) {
    return `<div class="pe-kb-row">
      <select class="text_pole" data-k2="personId"><option value="">（选择人物）</option>${st.persons.map(p => `<option value="${p.id}" ${p.id === k.personId ? 'selected' : ''}>${h(p.name)}</option>`).join('')}</select>
      <input type="text" class="text_pole" data-k2="since" value="${h(k.since || '')}" placeholder="哪天起知道">
      <select class="text_pole" data-k2="via">${Object.entries(FACT_VIA).map(([a, b]) => `<option value="${a}" ${a === (k.via || 'told') ? 'selected' : ''}>${b}</option>`).join('')}</select>
      <label class="pe-check-inline"><input type="checkbox" data-k2="believes" ${k.believes === false ? '' : 'checked'}> 相信</label>
      <button class="menu_button pe-mini" data-act="fact-kb-del">✕</button></div>`;
}
function factEditor(st, f) {
    return `<div class="pe-editor pe-fact-editor"><div class="pe-editor-head">${(st.privateFacts || []).some(x => x.id === f.id) ? '编辑' : '新增'}私人信息</div>
      <div class="pe-form">
        <div class="pe-field pe-wide"><label>是什么</label><textarea class="text_pole" data-f="text" rows="2" placeholder="如：法语不是他的母语，他对自己的法语文章没什么信心">${h(f.text || '')}</textarea></div>
        <div class="pe-field"><label>类别</label><select class="text_pole" data-f="topic">${FACT_TOPICS.map(t => `<option ${t === f.topic ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
        <div class="pe-field"><label>关于哪部作品（创作意图等，可空）</label><select class="text_pole" data-f="workId"><option value="">（不针对作品）</option>${st.works.map(w => `<option value="${w.id}" ${w.id === f.workId ? 'selected' : ''}>${h(w.title)}</option>`).join('')}</select></div>
        <div class="pe-field"><label class="pe-check-inline"><input type="checkbox" data-f="public" ${f.public ? 'checked' : ''}> 已经公开（人人知道）</label><input type="text" class="text_pole" data-f="publicSince" value="${h(f.publicSince || '')}" placeholder="从哪天起公开"></div>
        <div class="pe-field"><label class="pe-check-inline"><input type="checkbox" data-f="secret" ${f.secret === 'strict' ? 'checked' : ''}> 知情者绝不外传（推演不出“可能说出去”的候选）</label></div>
      </div>
      <div class="pe-field pe-wide"><label>谁知道 <small class="pe-muted">只有这里列出的人、在这一天之后，生成看法、写稿、世界书、幕后时才会用到它。知道 A 的事，不等于他的朋友也知道</small></label>
        <div class="pe-kb-rows">${(f.knownBy || []).map(k => kbRow(st, k)).join('')}</div>
        <div class="pe-row"><button class="menu_button" data-act="fact-kb-add">＋ 添加知情者</button></div></div>
      <div class="pe-actions"><div class="pe-actions-extra"></div><button data-act="cancel-edit">取消</button><button class="pe-primary" data-act="fact-save">保存</button></div></div>`;
}
function factsBlock(st) {
    const list = st.privateFacts || [];
    const ed = editing?.kind === 'fact' ? (list.find(x => x.id === editing.id) || editing.draft) : null;
    const card = f => (ed && ed.id === f.id) ? factEditor(st, f) : `<div class="pe-card pe-card-slim pe-li-item" data-find="${h(f.text + ' ' + (f.knownBy || []).map(k => byId(st.persons, k.personId)?.name).join(' '))}"><div class="pe-card-main">
        <div><span class="pe-chip pe-chip-layer">${h(f.topic || '其他')}</span>${f.workId ? ` ${bt(byId(st.works, f.workId)?.title || '')}` : ''} ${h(f.text)}${f.secret === 'strict' ? ' <span class="pe-chip">绝不外传</span>' : ''}</div>
        <div class="pe-muted">知情者：${f.public ? `公开${f.publicSince ? '（' + h(f.publicSince) + ' 起）' : ''}` : (f.knownBy || []).length ? f.knownBy.map(k => `${personTag(byId(st.persons, k.personId), '?')}<small>${k.since ? ' ' + h(k.since) : ''} ${h(FACT_VIA[k.via] || '')}${k.believes === false ? ' · 不太信' : ''}</small>`).join('、') : '只有主角自己'}</div></div>
        <div class="pe-card-actions pe-card-actions-row"><button data-act="fact-edit" data-id="${f.id}">编辑</button><button data-act="fact-del" data-id="${f.id}">删除</button></div></div>`;
    return `<details class="pe-fold" ${list.length || ed ? 'open' : ''}><summary>主角的私人信息与知情者 <span class="pe-muted">${list.length} 条</span></summary>
      <div class="pe-muted">身世、国籍、母语、成长经历、某部作品的创作意图……只给这里登记的知情者。模拟器知道的，不等于角色知道：没登记的人生成看法时不会知道，也不会被要求“猜中”。</div>
      ${ed && !list.some(x => x.id === ed.id) ? factEditor(st, ed) : ''}
      ${list.map(card).join('')}
      <div class="pe-actions"><div class="pe-actions-extra"></div><button data-act="fact-new">＋ 新增一条</button></div></details>`;
}
function personKnowledgeHtml(st, p) {
    const kf = factsKnownBy(st, p.id, st.currentDate);
    const bs = perceptionsOf(st, p.id, {}).filter(b => !st.currentDate || !b.formedAt || b.formedAt <= st.currentDate);
    if (!kf.length && !bs.length) return `<h5>他对主角知道些什么</h5><div class="pe-muted">不知道主角的任何私人情况；还没有形成对作者的具体认知（生成私下看法时会一并形成）。</div>`;
    return `<h5>他对主角知道些什么</h5>
      ${kf.length ? `<div class="pe-op-line"><b>私事</b>${kf.map(x => `${h(x.fact.text)} <small class="pe-muted">${h(FACT_VIA[x.via] || '公开')}${x.since ? ' · ' + h(x.since) : ''}${x.believes ? '' : ' · 不太信'}</small>`).join('；')}</div>` : '<div class="pe-muted">不知道主角的私人情况。</div>'}
      ${bs.length ? `<h5>他对作者的认知 <small class="pe-muted">按时间；“推测”只是他自己的判断，不一定对</small></h5>${bs.map(b => `<div class="pe-op-line"><span class="pe-card-date">${h(b.formedAt || '')}</span> <span class="pe-chip">${h(b.topic)}</span> <span class="pe-belief pe-k-${b.kind}">${h(b.belief)} <small>${PERC_KIND[b.kind]} · ${Math.round((b.confidence ?? 0.5) * 100)}%</small></span>${b.workId ? ` <small class="pe-muted">读${bt(byId(st.works, b.workId)?.title || '')}后</small>` : ''}${b.revises ? `<div class="pe-muted">修正了：${h(b.revises)}</div>` : ''}</div>`).join('')}` : ''}`;
}

// ———————————— 认知对照 ————————————
const PC_SEL = (name, opts, val, extra = '') => `<select class="text_pole" ${extra} data-pcf="${name}">${opts.map(([v, l]) => `<option value="${h(v)}" ${String(v) === String(val ?? '') ? 'selected' : ''}>${h(l)}</option>`).join('')}</select>`;
function percPage(st) {
    const v = simView;
    const pens = st.pennames || [];
    if (v.penId === undefined) v.penId = pens[0]?.id || '';
    const asOf = v.asOf || st.currentDate || '';
    const m = perceptionMatrix(st, { asOf, penId: v.penId });
    const rows = v.only ? m.rows.filter(r => r.conflict) : m.rows;
    const persons = st.persons || [];
    const topics = PERC_TOPICS.map(t => [t, t]);
    const kindChip = b => `<span class="pe-belief pe-k-${b.kind}">${h(b.belief)} <small>${h(PERC_KIND[b.kind] || '')}${b.formedAt ? ' · ' + h(b.formedAt) : ''}${b.origin === 'manual' || (!b.recId && b.origin) ? ' · 手记' : ''}</small></span>`;
    const flagTxt = f => `<span class="pe-pc-flag pe-pc-${f.type}">${h(f.text)}</span>`;
    const line = (lab, body, cls = '') => `<div class="pe-pc-line ${cls}"><span class="pe-pc-lab">${lab}</span><div class="pe-pc-val">${body}</div></div>`;
    const rowHtml = r => {
        const L = [];
        for (const x of r.self) L.push(line('主角自认', `${h(x.text)}`, 'pe-pc-self'));
        for (const x of r.claims) L.push(line('对外说法', `${h(x.text)} <small class="pe-muted">${h(x.since || '')} 公开</small>`, 'pe-pc-self'));
        for (const f of r.facts) L.push(line('私事', `${h(f.fact.text)} <small class="pe-muted">${f.isPublic ? '已公开' : f.knowers.length ? '知情：' + f.knowers.map(k => h(byId(persons, k.personId)?.name || '?')).join('、') : '无人知道'}</small>`));
        for (const x of r.assumed) {
            const who = x.a.personId ? personTag(byId(persons, x.a.personId), '?') : `<b>${h(CIRCLES[x.a.circle] || '?')}</b>`;
            L.push(line('主角以为', `${who}：${h(x.a.belief)}${x.actual ? `<div class="pe-muted">实际：${h(x.actual.belief)}</div>` : ''}${x.flag ? flagTxt(x.flag) : ''}`, x.flag && x.flag.type !== 'assumed_noimg' ? 'pe-pc-hot' : ''));
        }
        for (const x of r.persons) L.push(line(personTag(x.person), `${kindChip(x.belief)}${x.flags.map(flagTxt).join('')}${x.older.length ? `<details class="pe-pc-older"><summary>此前 ${x.older.length} 条</summary>${x.older.map(kindChip).join('')}</details>` : ''}<button class="pe-mini pe-pc-del" data-act="pcm-del" data-id="${x.belief.id}" title="删除这条认知">✕</button>`, x.flags.length ? 'pe-pc-hot' : ''));
        for (const x of r.images) L.push(line(h(CIRCLES[x.circle]), `${h(x.item.belief)} <small class="pe-muted">${h(SPREAD[x.item.spread] || '')} · 公开说法 · ${h(x.img.asOf)}</small>`, 'pe-pc-pub'));
        for (const x of r.review) L.push(line('AI 分析', `<span class="pe-chip">${h(REVIEW_TYPE[x.type] || '')}</span> ${h(x.text)}${x.who.length ? ` <small class="pe-muted">${h(x.who.join('、'))}</small>` : ''}`, `pe-pc-review pe-sev-${x.severity}`));
        return `<div class="pe-card pe-pc-row ${r.conflict ? 'pe-pc-conflict' : ''}" data-find="${h(r.topic)}"><div class="pe-pc-topic">${h(r.topic)}${r.conflict ? ' <span class="pe-chip pe-chip-warn">有出入</span>' : ''}</div>${L.join('')}</div>`;
    };
    const selfList = (st.selfImage || []).map(x => `<div class="pe-row pe-pc-item"><span class="pe-chip">${h(SELF_MODE[x.mode])}</span><span class="pe-chip">${h(x.topic)}</span> ${h(x.text)} <small class="pe-muted">${h(x.since || '')}${x.pennameId ? ' · ' + h(byId(pens, x.pennameId)?.name || '') : ''}</small><span class="pe-spacer"></span><button class="pe-mini" data-act="si-del" data-id="${x.id}">删除</button></div>`).join('');
    const asList = (st.assumed || []).map(x => `<div class="pe-row pe-pc-item"><span class="pe-chip">${h(x.topic)}</span> 以为 ${x.personId ? personTag(byId(persons, x.personId), '?') : '<b>' + h(CIRCLES[x.circle] || '?') + '</b>'}：${h(x.belief)} <small class="pe-muted">${h(x.since || '')}</small><span class="pe-spacer"></span><button class="pe-mini" data-act="as-del" data-id="${x.id}">删除</button></div>`).join('');
    const penOpts = [['', '（不限署名）'], ...pens.map(p => [p.id, p.name])];
    const whoOpts = [['', '（选择人物或圈子）'], ...persons.map(p => ['p:' + p.id, p.name]), ...Object.entries(CIRCLES).map(([k, l]) => ['c:' + k, '圈子：' + l])];
    const circles = v.penId ? Object.keys(CIRCLES) : [];
    const act = v.penId ? new Set(activeCircles(st, v.penId, asOf)) : new Set();
    const imgCards = circles.filter(c => act.has(c) || v.allCircles).map(c => {
        const img = latestImage(st, v.penId, c, asOf);
        const n = publicPieces(st, v.penId, c, asOf);
        const rep = st.reputation?.[v.penId]?.[c];
        return `<div class="pe-card pe-card-slim"><div class="pe-card-main"><div><b>${h(CIRCLES[c])}</b> <small class="pe-muted">公开材料 ${n.evs.length} 篇${n.claims.length ? ' · 作者说法 ' + n.claims.length : ''}${n.rumors.length ? ' · 传闻 ' + n.rumors.length : ''}${rep ? ' · ' + h(repLabel(rep)) : ''}</small></div>
          ${img ? `<div>${h(img.summary || '')} <small class="pe-muted">${h(img.asOf)} 整理</small></div>${img.items.map(i => `<div class="pe-op-line"><span class="pe-chip">${h(i.topic)}</span> ${h(i.belief)} <small class="pe-muted">${h(SPREAD[i.spread] || '')} · 依据 ${i.basis.length} 条</small></div>`).join('')}` : '<div class="pe-muted">还没有整理</div>'}</div>
          <div class="pe-card-actions"><button data-act="pi-gen" data-circle="${c}" ${n.evs.length + n.claims.length + n.rumors.length ? '' : 'disabled'}>${img ? '更新' : '整理'}</button></div></div>`;
    }).join('');
    return `<div class="pe-toolbar"><button data-act="sim-close">← 返回</button>
        <label class="pe-inline-field">截至 <input type="text" class="text_pole pe-pc-date" data-pc="asOf" value="${h(asOf)}" placeholder="YYYY-MM-DD"></label>
        <label class="pe-inline-field">署名 ${PC_SEL('pen', penOpts, v.penId, 'data-pc="penId"')}</label>
        <label class="pe-check-inline"><input type="checkbox" data-pc="only" ${v.only ? 'checked' : ''}> 只看有出入的</label>
        <span class="pe-spacer"></span><button class="pe-primary" data-act="pr-run" title="把下面所有内容交给 AI 找出彼此对不上的地方（调用 1 次）。只是分析，不改动任何人的认知">✦ AI 对照分析</button></div>
      <h4>认知对照 <span class="pe-muted">截至 ${h(asOf || '今天')}</span></h4>
      <div class="pe-muted">同一件事：主角怎么看自己、对外怎么说、以为别人怎么看；别人私下实际怎么看；各读者圈子公开怎么说。程序只标出能确定的出入（误解、传闻、“你以为”和实际对不上）；语义上的矛盾请用“AI 对照分析”。</div>
      ${m.review ? `<div class="pe-muted">AI 对照分析：${h(m.review.asOf)}，${m.review.items.length} 处出入</div>` : ''}
      ${rows.length ? rows.map(rowHtml).join('') : `<div class="pe-empty">${v.only ? '没有发现出入。' : '还没有内容：生成私下看法时会形成各人对作者的认知；也可以在下面登记主角的自我认知、主角以为的看法，或整理公众形象。'}</div>`}
      <details class="pe-fold" ${v.open?.self ? 'open' : ''} data-pcfold="self"><summary>主角的自我认知与对外说法 <span class="pe-muted">${(st.selfImage || []).length} 条</span></summary>
        <div class="pe-muted">“主角自认”只是他自己的看法，谁都不会因此知道；“对外说法”是在文章、序言、访谈里公开说过的话：从那天起，读到的人会把它当作“本人说的”。</div>
        ${selfList}
        <div class="pe-row pe-pc-form" id="pe-si-form">${PC_SEL('mode', Object.entries(SELF_MODE), 'self')}${PC_SEL('topic', topics, '')}<input type="text" class="text_pole pe-grow" data-pcf="text" placeholder="如：我写得直，是因为不想绕弯子"><input type="text" class="text_pole pe-pc-date" data-pcf="since" placeholder="从哪天起" value="${h(st.currentDate || '')}">${PC_SEL('pen', penOpts, v.penId)}<button class="pe-primary" data-act="si-add">添加</button></div></details>
      <details class="pe-fold" ${v.open?.as ? 'open' : ''} data-pcfold="as"><summary>主角以为别人怎么看他 <span class="pe-muted">${(st.assumed || []).length} 条</span></summary>
        <div class="pe-muted">反向的认知差：主角以为米尔博觉得他“太说教”，米尔博实际可能完全没这么想。可以针对某个人，也可以针对一个读者圈子（和公众形象比对）。</div>
        ${asList}
        <div class="pe-row pe-pc-form" id="pe-as-form">${PC_SEL('who', whoOpts, '')}${PC_SEL('topic', topics, '')}<input type="text" class="text_pole pe-grow" data-pcf="belief" placeholder="如：觉得我太爱说教"><input type="text" class="text_pole pe-pc-date" data-pcf="since" placeholder="从哪天起" value="${h(st.currentDate || '')}"><button class="pe-primary" data-act="as-add">添加</button></div></details>
      <details class="pe-fold" ${v.open?.pi ? 'open' : ''} data-pcfold="pi"><summary>各读者圈子的公众形象 <span class="pe-muted">${v.penId ? h(byId(pens, v.penId)?.name || '') : '先选一个署名'}</span></summary>
        <div class="pe-muted">按圈子整理当时公开流传的说法（每个圈子调用 1 次 AI），只依据已见报的文章、读者来信与剪报、作者的公开说法和传闻；私信与私事不会进来。每条都要注明依据，没有依据的不收。</div>
        ${v.penId ? (imgCards || '<div class="pe-muted">这个署名截至此日还没有公开材料。</div>') + `<label class="pe-check-inline"><input type="checkbox" data-pc="allCircles" ${v.allCircles ? 'checked' : ''}> 显示所有圈子</label>` : ''}</details>
      <details class="pe-fold" ${v.open?.pm ? 'open' : ''} data-pcfold="pm"><summary>手记一条别人的认知</summary>
        <div class="pe-muted">剧情里明确出现过的（如某人当面说“我一直以为你是比利时人”）。标“确知/本人说的”却对不上他知道的私事或作者的公开说法，会降为“推测”。</div>
        <div class="pe-row pe-pc-form" id="pe-pm-form">${PC_SEL('person', [['', '（选择人物）'], ...persons.map(p => [p.id, p.name])], '')}${PC_SEL('topic', topics, '')}<input type="text" class="text_pole pe-grow" data-pcf="belief" placeholder="他认为……">${PC_SEL('kind', Object.entries(PERC_KIND), 'inference')}<input type="text" class="text_pole pe-pc-date" data-pcf="date" value="${h(st.currentDate || '')}"><button class="pe-primary" data-act="pcm-add">记下</button></div></details>`;
}
function pcForm(id) {
    const root = document.getElementById(id); const o = {};
    root?.querySelectorAll('[data-pcf]').forEach(el => { o[el.dataset.pcf] = el.value.trim(); });
    return o;
}

// ———————————— 创作构想与灵感讨论 ————————————
const personOpts = (st, sel, me = false) => `${me ? `<option value="${ME}" ${sel === ME ? 'selected' : ''}>主角</option>` : '<option value="">（选择人物）</option>'}${st.persons.map(p => `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${h(p.name)}</option>`).join('')}`;
function presRow(st, id) {
    return `<div class="pe-kb-row pe-pres-row"><select class="text_pole" data-k2="personId">${personOpts(st, id)}</select><button class="menu_button pe-mini" data-act="it-row-del">✕</button></div>`;
}
function pointRow(st, p) {
    return `<div class="pe-kb-row pe-pt-row">
      <select class="text_pole" data-k2="by">${personOpts(st, p.by || ME, true)}</select>
      <select class="text_pole" data-k2="kind">${Object.entries(POINT_KINDS).map(([a, b]) => `<option value="${a}" ${a === p.kind ? 'selected' : ''}>${b}</option>`).join('')}</select>
      <input type="text" class="text_pole pe-pt-text" data-k2="text" value="${h(p.text || '')}" placeholder="说了什么，一句话">
      <select class="text_pole" data-k2="adopted" title="建议：主角采纳没有；答应帮忙：兑现没有（主角自己的话不用填）">${Object.entries(ADOPT).map(([a, b]) => `<option value="${a}" ${a === (p.adopted || 'pending') ? 'selected' : ''}>${b}</option>`).join('')}</select>
      <button class="menu_button pe-mini" data-act="it-row-del">✕</button></div>`;
}
function projectEditor(st, p) {
    return `<div class="pe-editor pe-cp-editor"><div class="pe-editor-head">${(st.projects || []).some(x => x.id === p.id) ? '编辑' : '新增'}创作构想</div>
      <div class="pe-form">
        <div class="pe-field"><label>暂名</label><input type="text" class="text_pole" data-f="title" value="${h(p.title)}" placeholder="如：变性小说（暂名）"></div>
        <div class="pe-field"><label>进度</label><select class="text_pole" data-f="stage">${Object.entries(PROJECT_STAGES).map(([a, b]) => `<option value="${a}" ${a === p.stage ? 'selected' : ''}>${b}</option>`).join('')}</select></div>
        <div class="pe-field"><label>打算用的署名</label><select class="text_pole" data-f="pennameId"><option value="">（未定 / 新笔名）</option>${(st.pennames || []).map(x => `<option value="${x.id}" ${x.id === p.pennameId ? 'selected' : ''}>${h(x.name)}</option>`).join('')}</select></div>
        <div class="pe-field"><label>新笔名的备选</label><input type="text" class="text_pole" data-f="penNote" value="${h(p.penNote || '')}" placeholder="如：Élise / Mademoiselle E."></div>
        <div class="pe-field"><label>第一次提起</label><input type="text" class="text_pole" data-f="since" value="${h(p.since || '')}" placeholder="YYYY-MM-DD"></div>
        <div class="pe-field"><label>题材</label><input type="text" class="text_pole" data-f="themes" value="${h((p.themes || []).join('、'))}" placeholder="用顿号分隔"></div>
        <div class="pe-field pe-wide"><label>设定与情节</label><textarea class="text_pole" data-f="premise" rows="2">${h(p.premise || '')}</textarea></div>
        <div class="pe-field pe-wide"><label>想探讨的核心问题</label><textarea class="text_pole" data-f="question" rows="2">${h(p.question || '')}</textarea></div>
        <div class="pe-field pe-wide"><label>写作顺序 / 排期</label><input type="text" class="text_pole" data-f="order" value="${h(p.order || '')}" placeholder="如：等《共和国的门》写完再写"></div>
        <div class="pe-field pe-wide"><label>考虑过的形式</label><input type="text" class="text_pole" data-f="forms" value="${h(p.forms || '')}" placeholder="如：2100 年医生手记 / 2030 年书信体"></div>
        <div class="pe-field"><label>写成后对应的作品</label><select class="text_pole" data-f="workId"><option value="">（还没写成）</option>${st.works.map(w => `<option value="${w.id}" ${w.id === p.workId ? 'selected' : ''}>${h(w.title)}</option>`).join('')}</select></div>
        <div class="pe-field pe-wide"><label>备注</label><textarea class="text_pole" data-f="notes" rows="2">${h(p.notes || '')}</textarea></div>
      </div>
      <div class="pe-actions"><div class="pe-actions-extra"></div><button data-act="cancel-edit">取消</button><button class="pe-primary" data-act="cp-save">保存</button></div></div>`;
}
function talkEditor(st, t) {
    return `<div class="pe-editor pe-it-editor"><div class="pe-editor-head">${(st.ideaTalks || []).some(x => x.id === t.id) ? '编辑' : '新增'}一次讨论</div>
      <div class="pe-form">
        <div class="pe-field"><label>日期</label><input type="text" class="text_pole" data-f="date" value="${h(t.date || '')}" placeholder="YYYY-MM-DD"></div>
        <div class="pe-field"><label>时间</label><input type="text" class="text_pole" data-f="time" value="${h(t.time || '')}" placeholder="如 21:56–22:12"></div>
        <div class="pe-field"><label>地点</label><input type="text" class="text_pole" data-f="place" value="${h(t.place || '')}"></div>
        <div class="pe-field"><label>出处（楼层 / 编号）</label><input type="text" class="text_pole" data-f="ref" value="${h(t.ref || '')}" placeholder="如 AM0509"></div>
      </div>
      <div class="pe-field pe-wide"><label>在场的人 <small class="pe-muted">只有这里的人（和下面提过观点的人）知道这次聊了什么</small></label>
        <div class="pe-pres-rows">${(t.present || []).map(id => presRow(st, id)).join('')}</div>
        <div class="pe-row"><button class="menu_button" data-act="it-pres-add">＋ 添加在场者</button></div></div>
      ${(st.projects || []).filter(p => p.id !== t.projectId).length ? `<div class="pe-field pe-wide"><label>顺带提到了别的构想 <small class="pe-muted">在场的人只会知道“主角有这么个构想”，不知道具体内容</small></label>
        <div class="pe-row pe-it-mentions">${st.projects.filter(p => p.id !== t.projectId).map(p => `<label class="pe-check-inline"><input type="checkbox" value="${p.id}" ${(t.mentions || []).includes(p.id) ? 'checked' : ''}> ${h(p.title || '未命名')}</label>`).join('')}</div></div>` : ''}
      <div class="pe-field pe-wide"><label>各人说了什么 <small class="pe-muted">最后一栏：建议采纳没有、答应的事兑现没有；聊天里没交代的就留“未定”</small></label>
        <div class="pe-pt-rows">${(t.points || []).map(p => pointRow(st, p)).join('')}</div>
        <div class="pe-row"><button class="menu_button" data-act="it-pt-add">＋ 添加一条</button></div></div>
      <div class="pe-field pe-wide"><label>备注</label><textarea class="text_pole" data-f="notes" rows="2">${h(t.notes || '')}</textarea></div>
      <div class="pe-actions"><div class="pe-actions-extra"></div><button data-act="cancel-edit">取消</button><button class="pe-primary" data-act="it-save">保存</button></div></div>`;
}
function talkCard(st, t, ed) {
    if (ed?.kind === 'talk' && ed.id === t.id) return talkEditor(st, (st.ideaTalks || []).find(x => x.id === t.id) || ed.draft);
    const ppl = talkPeople(t).map(id => personTag(byId(st.persons, id), '?')).join('、');
    return `<div class="pe-it-card"><div class="pe-row"><b>${h(t.date || '日期不详')}</b> <small class="pe-muted">${h([t.time, t.place, t.ref].filter(Boolean).join(' · '))}</small><span class="pe-spacer"></span>
        <button class="pe-mini" data-act="it-edit" data-id="${t.id}">改</button><button class="pe-mini" data-act="it-del" data-id="${t.id}">✕</button></div>
      <div class="pe-muted">在场：${ppl || '只有主角'}</div>
      ${(t.mentions || []).length ? `<div class="pe-muted">顺带提到：${t.mentions.map(id => h(byId(st.projects, id)?.title || '?')).join('、')}</div>` : ''}
      ${(t.points || []).length ? `<ul class="pe-it-points">${t.points.map(p => `<li><b>${p.by === ME ? '主角' : h(byId(st.persons, p.by)?.name || '?')}</b> <span class="pe-chip">${h(POINT_KINDS[p.kind] || '')}</span> ${h(p.text)}${p.by !== ME ? ` <span class="pe-chip ${p.adopted === 'pending' ? '' : 'pe-chip-layer'}">${h(ADOPT[p.adopted] || '未定')}</span>` : ''}</li>`).join('')}</ul>` : ''}</div>`;
}
function ideasBlock(st) {
    const ps = st.projects || [], ts = st.ideaTalks || [];
    const ed = ['project', 'talk'].includes(editing?.kind) ? editing : null;
    const newProj = ed?.kind === 'project' && !ps.some(x => x.id === ed.id) ? projectEditor(st, ed.draft) : '';
    const card = p => {
        if (ed?.kind === 'project' && ed.id === p.id) return projectEditor(st, p);
        const mine = ts.filter(t => t.projectId === p.id).sort((a, b) => cmp(a.date || '', b.date || ''));
        const pen = byId(st.pennames, p.pennameId);
        const w = byId(st.works, p.workId);
        const newTalk = ed?.kind === 'talk' && ed.draft?.projectId === p.id && !ts.some(x => x.id === ed.id) ? talkEditor(st, ed.draft) : '';
        const heard = [...new Set(mine.flatMap(talkPeople))].map(id => byId(st.persons, id)?.name).filter(Boolean);
        const heardOf = [...new Set(ts.filter(t => (t.mentions || []).includes(p.id)).flatMap(talkPeople))].map(id => byId(st.persons, id)?.name).filter(n => n && !heard.includes(n));
        return `<div class="pe-cp-card pe-li-item" data-find="${h([p.title, p.premise, ...heard].join(' '))}">
          <div class="pe-row"><b>${h(p.title || '未命名构想')}</b> <span class="pe-chip pe-chip-layer">${h(PROJECT_STAGES[p.stage] || '')}</span>${pen ? ' ' + penChip(st, pen.id) : p.penNote ? ` <small class="pe-muted">署名备选：${h(p.penNote)}</small>` : ''}${w ? ` → ${bt(w.title)}` : ''}<span class="pe-spacer"></span>
            <button class="pe-mini" data-act="cp-edit" data-id="${p.id}">改</button><button class="pe-mini" data-act="cp-del" data-id="${p.id}">✕</button></div>
          ${p.premise ? `<div>${h(p.premise)}</div>` : ''}
          ${p.question ? `<div class="pe-muted">核心问题：${h(p.question)}</div>` : ''}
          ${p.forms ? `<div class="pe-muted">形式：${h(p.forms)}</div>` : ''}
          ${p.order ? `<div class="pe-muted">排期：${h(p.order)}</div>` : ''}
          <div class="pe-muted">听过的人：${heard.length ? heard.map(h).join('、') : '还没跟人聊过'}${heardOf.length ? ` · 只听人提起过：${heardOf.map(h).join('、')}` : ''}${p.since ? ` · ${h(p.since)} 起` : ''}</div>
          <div class="pe-it-list">${mine.map(t => talkCard(st, t, ed)).join('')}${newTalk}</div>
          <div class="pe-actions"><div class="pe-actions-extra"></div><button data-act="it-new" data-project="${p.id}">＋ 记一次讨论</button></div></div>`;
    };
    return `<details class="pe-fold" ${ps.length || ed ? 'open' : ''}><summary>创作构想与灵感讨论 <span class="pe-muted">${ps.length} 个构想 · ${ts.length} 次讨论</span></summary>
      <div class="pe-muted">还没写出来的东西：跟谁聊过、谁提了什么、采纳没有。只有在场的人知道；不算作品，不进阅读、反响和名声。等它写成发表、在这里关联上作品后，参与过讨论的人读到时会把这当背景——不保证评价更好，也可能因为“和当初聊的不一样”更挑剔。</div>
      ${newProj}${ps.map(card).join('')}
      <div class="pe-actions"><div class="pe-actions-extra"></div><button data-act="cp-new">＋ 新增构想</button></div></details>`;
}
function ideasAction(act, st, btn) {
    const root = sel => document.querySelector(sel);
    switch (act) {
        case 'cp-new': { const p = blankProject(); p.since = st.currentDate || ''; editing = { kind: 'project', id: p.id, draft: p }; refresh(); return; }
        case 'cp-edit': editing = { kind: 'project', id: btn.dataset.id }; refresh(); return;
        case 'cp-del': {
            const n = (st.ideaTalks || []).filter(t => t.projectId === btn.dataset.id).length;
            if (!confirm(`删除这个构想？${n ? `（连同 ${n} 次讨论记录）` : ''}`)) return;
            st.projects = (st.projects || []).filter(p => p.id !== btn.dataset.id);
            st.ideaTalks = (st.ideaTalks || []).filter(t => t.projectId !== btn.dataset.id);
            commit(); return;
        }
        case 'cp-save': {
            const r = root('.pe-cp-editor'); if (!r) return;
            const g = k => r.querySelector(`[data-f="${k}"]`).value;
            if (!g('title').trim()) return toast('warning', '给构想起个暂名');
            let p = (st.projects || []).find(x => x.id === editing.id);
            if (!p) { p = editing.draft; st.projects = [...(st.projects || []), p]; }
            Object.assign(p, normProject({ ...p, title: g('title').trim(), stage: g('stage'), pennameId: g('pennameId'), penNote: g('penNote').trim(), since: normalizeISO(g('since')) || '', themes: g('themes'), premise: g('premise').trim(), question: g('question').trim(), forms: g('forms').trim(), order: g('order').trim(), workId: g('workId'), notes: g('notes').trim() }));
            if (p.workId && p.stage !== 'published') p.stage = 'published';
            editing = null; commit('已保存'); return;
        }
        case 'it-new': { const t = blankTalk(btn.dataset.project); t.date = st.currentDate || ''; editing = { kind: 'talk', id: t.id, draft: t }; refresh(); return; }
        case 'it-edit': editing = { kind: 'talk', id: btn.dataset.id }; refresh(); return;
        case 'it-del': if (confirm('删除这次讨论记录？')) { st.ideaTalks = (st.ideaTalks || []).filter(t => t.id !== btn.dataset.id); commit(); } return;
        case 'it-pres-add': root('.pe-it-editor .pe-pres-rows')?.insertAdjacentHTML('beforeend', presRow(st, '')); return;
        case 'it-pt-add': root('.pe-it-editor .pe-pt-rows')?.insertAdjacentHTML('beforeend', pointRow(st, blankPoint())); return;
        case 'it-row-del': btn.closest('.pe-kb-row')?.remove(); return;
        case 'it-save': {
            const r = root('.pe-it-editor'); if (!r) return;
            const g = k => r.querySelector(`[data-f="${k}"]`).value.trim();
            let t = (st.ideaTalks || []).find(x => x.id === editing.id);
            const isNew = !t;
            if (!t) t = editing.draft;
            const v = { ...t, date: normalizeISO(g('date')) || '', time: g('time'), place: g('place'), ref: g('ref'), notes: g('notes'),
                present: [...r.querySelectorAll('.pe-pres-row [data-k2="personId"]')].map(x => x.value).filter(Boolean),
                mentions: [...r.querySelectorAll('.pe-it-mentions input:checked')].map(x => x.value),
                points: [...r.querySelectorAll('.pe-pt-row')].map(x => ({ by: x.querySelector('[data-k2="by"]').value, kind: x.querySelector('[data-k2="kind"]').value, text: x.querySelector('[data-k2="text"]').value.trim(), adopted: x.querySelector('[data-k2="adopted"]').value })) };
            if (!v.date) return toast('warning', '写一下哪天聊的');
            Object.assign(t, normTalk(v));
            if (isNew) st.ideaTalks = [...(st.ideaTalks || []), t];
            const pr = byId(st.projects, t.projectId);
            if (pr && (!pr.since || cmp(t.date, pr.since) < 0)) pr.since = t.date;
            editing = null; commit('已保存。只有在场的人知道这次聊了什么'); return;
        }
    }
}
