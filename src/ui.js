// ui.js — 面板界面（纯 DOM，不依赖框架）

import { escapeHtml as h, parseTags, tagsToText, truncate } from './util.js';
import { weekdayZh, normalizeISO, yearOf, cmp } from './date.js';
import {
    FORMS, PERIODICITY, CIRCLES, LAYERS, ROLES, repLabel, setStatus, rerollWork, advanceTo, byId, columnSlots,
    READ_STATES, STRENGTH, EXPRESSION, CHANNELS, isMajor, recordManualReading,
} from './engine.js';
import { buildEvidenceCard, cardText, generateOpinion } from './analysis.js';
import { epistolaryAvailable, epistolaryStoryDate, scanLetters, peopleProposals } from './epistolary.js';
import { getSettings, saveSettings, getState, saveState, resetState, replaceState, logLine } from './store.js';
import { blankOutlet, blankPerson, blankWork, blankPenname, applyProposal, addManualEvent } from './data.js';
import { writeEvent, buildWriterPrompt } from './writer.js';
import {
    guessPlace, eraKey, defaultWikiTitles, gatherSources, buildEraProfile, profileToProposals, wikiSearch, wikiExtract, trimFuture,
} from './era.js';
import { extractFromText, loadWorldbookText } from './extract.js';
import { callLLM } from './llm.js';

let app = null; // { refreshInjection, detectFromChat }
let tab = 'overview';
let editing = null; // { kind, id }
let busy = '';
let searchResults = [];
let ledgerFilter = '';
let lastReport = null;

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
const POLS = { 1: '肯定', 0: '褒贬参半', '-1': '批评' };
const optsOf = (list, label = 'name', blank = true) => state => {
    const o = blank ? { '': '（无）' } : {};
    for (const x of list(state) || []) o[x.id] = x[label] || x.title || '(未命名)';
    return o;
};

const PEN_SPEC = [
    { key: 'name', label: '笔名' },
    { key: 'owner', label: '真实作者' },
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
    { key: 'pennameId', label: '署名', type: 'select', options: optsOf(s => s.pennames) },
    { key: 'form', label: '形式', type: 'select', options: FORMS, hint: '连载很少进正式书评；成书、小册子才进书评栏' },
    { key: 'outletId', label: '发表刊物', type: 'select', options: optsOf(s => s.outlets) },
    { key: 'pubDate', label: '发表日期', type: 'date', placeholder: 'YYYY-MM-DD' },
    { key: 'endDate', label: '连载结束日', type: 'date', placeholder: 'YYYY-MM-DD，可空' },
    { key: 'themes', label: '题材标签', type: 'tags' },
    { key: 'summary', label: '内容摘要', type: 'textarea', rows: 3 },
    { key: 'parentId', label: '同一作品的另一个版本', type: 'select', options: optsOf(s => s.works, 'title'), hint: '如单行本对应的连载版。读过另一版本的人不太会再读一遍' },
    { key: 'sourceText', label: '原文（用于生成证据卡，可粘贴全文）', type: 'textarea', rows: 6 },
];

// ———————————— 外壳 ————————————

export function mountUI(appApi) {
    app = appApi;
    if (document.getElementById('pe-panel')) return;
    const fab = document.createElement('div');
    fab.id = 'pe-fab';
    fab.title = '报刊回声';
    fab.textContent = '📰';
    fab.addEventListener('click', () => togglePanel());
    document.body.appendChild(fab);

    const panel = document.createElement('div');
    panel.id = 'pe-panel';
    panel.className = 'pe-hidden';
    panel.innerHTML = `
      <div class="pe-head">
        <b>📰 报刊回声</b><span id="pe-head-date"></span>
        <span class="pe-busy" id="pe-busy"></span>
        <button class="pe-x" data-act="close">✕</button>
      </div>
      <div class="pe-tabs">
        ${[['overview', '概览'], ['queue', '候选审核'], ['ledger', '账本'], ['reading', '阅读记录'], ['works', '作品与笔名'], ['people', '人物与刊物'], ['era', '年代档案'], ['import', '导入书信簿'], ['settings', '设置']]
        .map(([k, v]) => `<button data-tab="${k}">${v}</button>`).join('')}
      </div>
      <div class="pe-body" id="pe-body"></div>`;
    document.body.appendChild(panel);
    panel.addEventListener('click', onClick);
    panel.addEventListener('change', onChange);
    refresh();
}

export function togglePanel(force) {
    const p = document.getElementById('pe-panel');
    if (!p) return;
    const show = force ?? p.classList.contains('pe-hidden');
    p.classList.toggle('pe-hidden', !show);
    if (show) refresh();
}

function setBusy(text) {
    busy = text || '';
    const b = document.getElementById('pe-busy');
    if (b) b.textContent = busy ? `⏳ ${busy}` : '';
}

export function refresh() {
    const body = document.getElementById('pe-body');
    if (!body) return;
    const st = getState();
    const s = getSettings();
    document.querySelectorAll('#pe-panel .pe-tabs button').forEach(b => b.classList.toggle('pe-on', b.dataset.tab === tab));
    const hd = document.getElementById('pe-head-date');
    if (hd) hd.textContent = st?.currentDate ? ` ${st.currentDate}（${weekdayZh(st.currentDate)}）` : '';
    const fab = document.getElementById('pe-fab');
    if (fab) {
        const n = st ? st.ledger.filter(e => e.status === 'candidate').length : 0;
        fab.dataset.badge = n ? String(n) : '';
        fab.style.display = s.enabled ? '' : 'none';
    }
    if (!st) { body.innerHTML = '<p>请先打开一个聊天。</p>'; return; }
    const render = { overview, queue, ledger, reading, works, people, era, importTab, settings }[tab === 'import' ? 'importTab' : tab];
    body.innerHTML = render(st, s);
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
    const pens = st.pennames.map(p => {
        const rep = st.reputation[p.id] || {};
        return `<tr><td>${h(p.name)}</td>${Object.keys(CIRCLES).map(c => `<td title="${(rep[c] || 0).toFixed(2)}">${repLabel(rep[c] || 0)}</td>`).join('')}</tr>`;
    }).join('');
    const rumors = (st.rumors || []).map(r => `<li>${h(r.text)} <small>热度 ${Math.round(r.strength * 100)}%</small>
        <button class="pe-mini" data-act="rumor-pin" data-id="${r.id}">${r.pinned ? '取消固定' : '固定'}</button>
        <button class="pe-mini" data-act="rumor-del" data-id="${r.id}">删除</button></li>`).join('');
    return `
    <section>
      <h4>故事日期</h4>
      <div class="pe-row">
        <input id="pe-date" type="text" value="${h(st.currentDate || '')}" placeholder="YYYY-MM-DD" style="width:9em">
        <button data-act="date-set">设为当前（不推演）</button>
        <button data-act="date-advance">推进到此日期</button>
        <button data-act="date-detect">从最新消息识别</button>
      </div>
      ${st.weekdayWarning ? `<p class="pe-warn">⚠ ${h(st.weekdayWarning)} <button class="pe-mini" data-act="clear-wd">知道了</button></p>` : ''}
      ${st.detectedDate ? `<p class="pe-note">检测到新日期 ${h(st.detectedDate)}（自动推进已关闭）<button class="pe-mini" data-act="advance-detected">推进</button></p>` : ''}
      <small>日期只会向前推进。正文里提到的较早日期（例如回忆往事）不会把时间拨回去。</small>
    </section>
    <section>
      <h4>年代与地点</h4>
      <div class="pe-row">
        <span>年份：<b>${h(st.era?.year ?? '—')}</b></span>
        <input id="pe-place" type="text" value="${h(st.era?.place || '')}" placeholder="如：法国·巴黎" style="width:10em">
        <button data-act="place-save">保存地点</button>
        <button data-act="place-guess">从聊天猜测</button>
        <span>年代档案：${era ? `✅ ${h(era.asOf || era.year)}` : '❌ 未生成'} <button class="pe-mini" data-tab-go="era">去生成</button></span>
      </div>
    </section>
    <section>
      <h4>状态</h4>
      <p>待审核候选 <b>${cand}</b> 条 · 已批准 <b>${appr}</b> 条 · 已排期但未到期 <b>${sched}</b> 条（到期前不显示内容，避免剧透）</p>
      ${lastReport ? `<p class="pe-note">上次推进 ${h(lastReport.from || '')} → ${h(lastReport.to)}：新增阅读记录 ${lastReport.receptions} 条，新排期 ${lastReport.scheduled} 条，到期 ${lastReport.newCandidates.length} 条（其中自动通过 ${lastReport.autoApproved.length} 条）。</p>` : ''}
      ${epistolaryAvailable() ? `<p><small>书信簿剧情日期：${h(epistolaryStoryDate() || '未设定')}${epistolaryStoryDate() && epistolaryStoryDate() !== st.currentDate ? ` <button class="pe-mini" data-act="epi-date-adopt">推进到这一天</button>` : ''}</small></p>` : ''}
    </section>
    <section>
      <h4>笔名声誉（只由“已批准的公开反响”改变）</h4>
      ${st.pennames.length ? `<table class="pe-table"><tr><th>笔名</th>${Object.values(CIRCLES).map(c => `<th>${c}</th>`).join('')}</tr>${pens}</table>` : '<p>还没有笔名。去“作品与笔名”添加。</p>'}
    </section>
    <section>
      <h4>坊间传闻</h4>
      ${rumors ? `<ul class="pe-list">${rumors}</ul>` : '<p>暂无。</p>'}
      <div class="pe-row"><input id="pe-rumor" type="text" placeholder="手动添加一条传闻" style="flex:1"><button data-act="rumor-add">添加</button></div>
    </section>
    <section>
      <h4>日志</h4>
      <ul class="pe-log">${(st.log || []).slice(0, 15).map(l => `<li><small>${h(l.date || '')}</small> ${h(l.text)}</li>`).join('')}</ul>
    </section>`;
}

function evLine(st, e) {
    const person = byId(st.persons, e.personId);
    const outlet = byId(st.outlets, e.outletId);
    const work = byId(st.works, e.workId);
    const pol = e.layer === 'reader_letters' ? `约 ${e.count} 封` : e.layer === 'mentions' ? `约 ${e.count} 条` : `<span class="pe-pol pe-pol${e.polarity}">${POLS[e.polarity]}</span>`;
    return `<b>${h(e.date)}</b> <small>${weekdayZh(e.date)}</small> · <span class="pe-layer">${h(LAYERS[e.layer]?.label || e.layer)}</span>
      · ${outlet ? '《' + h(outlet.name) + '》' : ''}${h(person?.name || e.personName || '')}
      · ${work ? '评《' + h(work.title) + '》' : ''} · ${pol}${e.p != null ? ` <small title="推演概率">p=${e.p}</small>` : ''}
      ${e.origin === 'manual' ? '<small class="pe-tag">手动/已确认</small>' : ''}${e.auto ? '<small class="pe-tag">自动通过</small>' : ''}${isMajor(st, e) ? '<small class="pe-tag pe-major">重要</small>' : ''}${e.reactsTo ? '<small class="pe-tag">回应前文</small>' : ''}
      ${e.why?.length ? `<details class="pe-why"><summary>为什么发生？</summary><ol>${e.why.map(w => `<li>${h(w)}</li>`).join('')}</ol></details>` : ''}
      ${(e.flags || []).map(f => `<div class="pe-flag">⚠ ${h(f)}</div>`).join('')}`;
}

function queue(st) {
    const cands = st.ledger.filter(e => e.status === 'candidate');
    const unwritten = st.ledger.filter(e => e.status === 'approved' && !e.text?.body && e.layer !== 'reader_letters' && e.layer !== 'mentions');
    const sched = st.ledger.filter(e => e.status === 'scheduled').length;
    const LAYER_OPTS = Object.fromEntries(Object.entries(LAYERS).map(([k, v]) => [k, v.label]));
    return `
    <section>
      <h4>待审核候选（${cands.length}）</h4>
      <p><small>候选由规则推演产生：接触 → 阅读 → 看法 → 表达，公开发表还要赶上截稿、有版面。批准后才计入声誉、进入主对话。设置里开了“次要事件自动通过”时，这里主要剩下正式书评、论战和真实人物的私信。</small></p>
      ${cands.length ? `<div class="pe-row"><button data-act="approve-all">全部批准</button><button data-act="reject-all">全部驳回</button></div>` : ''}
      <ul class="pe-list">${cands.map(e => `<li>${evLine(st, e)}
        <div class="pe-row">
          <button class="pe-mini" data-act="approve" data-id="${e.id}">批准</button>
          <button class="pe-mini" data-act="approve-write" data-id="${e.id}">批准并写稿</button>
          <button class="pe-mini" data-act="reject" data-id="${e.id}">驳回</button>
          <button class="pe-mini" data-act="ev-date" data-id="${e.id}">改日期</button>
          <button class="pe-mini" data-act="ev-pol" data-id="${e.id}">改褒贬</button>
          <button class="pe-mini" data-act="ev-note" data-id="${e.id}">写稿要求</button>
        </div></li>`).join('') || '<li>暂无。故事日期推进后会自动产生。</li>'}</ul>
      ${sched ? `<p><small>另有 ${sched} 条已排期，到期后才会出现。</small></p>` : ''}
    </section>
    <section>
      <h4>已批准、尚未写稿（${unwritten.length}）</h4>
      ${unwritten.length ? `<div class="pe-row"><button data-act="write-all">逐条写稿</button></div>` : ''}
      <ul class="pe-list">${unwritten.map(e => `<li>${evLine(st, e)}<div class="pe-row"><button class="pe-mini" data-act="write" data-id="${e.id}">写稿</button><button class="pe-mini" data-act="preview-prompt" data-id="${e.id}">查看提示词</button></div></li>`).join('') || '<li>无</li>'}</ul>
    </section>
    <section>
      <h4>手动录入一条反响</h4>
      <p><small>用于录入模拟中已经确认发生的事（例如某人某日的私信），或你想强制安排的评论。</small></p>
      <div class="pe-form" id="pe-manual">
        ${fieldHtml({ key: 'date', label: '日期', placeholder: 'YYYY-MM-DD' }, st.currentDate)}
        ${fieldHtml({ key: 'layer', label: '层级', type: 'select', options: LAYER_OPTS }, 'notice')}
        ${fieldHtml({ key: 'personId', label: '人物', type: 'select', options: optsOf(x => x.persons) }, '', st)}
        ${fieldHtml({ key: 'outletId', label: '刊物', type: 'select', options: optsOf(x => x.outlets) }, '', st)}
        ${fieldHtml({ key: 'workId', label: '作品', type: 'select', options: optsOf(x => x.works, 'title') }, '', st)}
        ${fieldHtml({ key: 'polarity', label: '褒贬', type: 'select', options: POLS }, 0)}
        ${fieldHtml({ key: 'count', label: '来信数量（仅读者来信）', type: 'number' }, '')}
        ${fieldHtml({ key: 'summary', label: '内容概要', type: 'textarea', rows: 2 }, '')}
        ${fieldHtml({ key: 'approved', label: '直接记为已批准', type: 'checkbox' }, true)}
      </div>
      <button data-act="manual-add">录入</button>
    </section>`;
}

function ledger(st) {
    const items = st.ledger.filter(e => e.status === 'approved' && (!ledgerFilter || e.workId === ledgerFilter));
    const wopts = optsOf(x => x.works, 'title')(st);
    wopts[''] = '（全部作品）';
    return `
    <section>
      <div class="pe-row"><span>筛选：</span><select id="pe-ledger-filter">${Object.entries(wopts).map(([k, v]) => `<option value="${h(k)}" ${k === ledgerFilter ? 'selected' : ''}>${h(v)}</option>`).join('')}</select>
      <button data-act="export-ledger">导出为文本</button></div>
      <ul class="pe-list">${items.map(e => `<li>${evLine(st, e)}
        ${e.text ? `<details><summary>${h(e.text.title || '（无标题）')} <small>${h(e.text.byline || '')} ${e.text.section ? '· ' + h(e.text.section) : ''}</small>${e.text.stanceOnly ? ' <small class="pe-tag">立场摘要</small>' : ''}</summary>
            <div class="pe-text">${h(e.text.body || '').replace(/\n/g, '<br>')}</div>
            <p><small>概要：${h(e.text.summary || '')}</small></p></details>` : ''}
        <div class="pe-row">
          <button class="pe-mini" data-act="write" data-id="${e.id}">${e.text?.body ? '重写' : '写稿'}</button>
          <button class="pe-mini" data-act="ev-summary" data-id="${e.id}">改概要</button>
          <button class="pe-mini" data-act="ev-reply" data-id="${e.id}">安排一篇回应</button>
          <button class="pe-mini" data-act="unapprove" data-id="${e.id}">撤回批准</button>
          <button class="pe-mini" data-act="ev-del" data-id="${e.id}">删除</button>
        </div></li>`).join('') || '<li>还没有已批准的反响。</li>'}</ul>
    </section>`;
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
            return `<li><b>${h(p?.name || '?')}</b> · ${h(CHANNELS[r.channel] || r.channel || '')} ${h(r.contactDate || '')}
              · ${future ? '尚未读到' : h(READ_STATES[r.read] || r.read)}${r.readDate && !future ? ' ' + h(r.readDate) : ''}
              ${!future && r.strength ? `· <span class="pe-pol pe-pol${r.polarity}">${['偏批评', '参半', '偏肯定'][r.polarity + 1]}</span> ${h(STRENGTH[r.strength])}` : ''}
              ${!future && r.expression ? `· ${h(EXPRESSION[r.expression])}` : ''}
              ${r.origin === 'manual' ? '<small class="pe-tag">手动</small>' : ''}${r.viaEventId ? '<small class="pe-tag">因评论得知</small>' : ''}
              ${r.opinion ? `<div class="pe-evi">私下看法：${h(r.opinion.summary || '')}${r.opinion.understanding && r.opinion.understanding !== 'full' ? `（${r.opinion.understanding === 'partial' ? '部分理解' : '有误读'}）` : ''}</div>` : ''}
              <details class="pe-why"><summary>为什么？</summary><ol>${(r.why || []).map(x => `<li>${h(x)}</li>`).join('')}</ol></details>
              ${!future && ['skimmed', 'finished'].includes(r.read) ? `<button class="pe-mini" data-act="gen-opinion" data-id="${r.id}">${r.opinion ? '重新生成看法' : '生成私下看法'}</button>` : ''}</li>`;
        }).join('');
        return `<section><h4>《${h(w?.title || '?')}》</h4>
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
      <button data-act="manual-read">记录</button>
    </section>`;
}

function listBlock(title, kind, list, spec, st, labelFn) {
    const isEdit = editing && editing.kind === kind;
    const obj = isEdit ? (list.find(x => x.id === editing.id) || editing.draft) : null;
    return `
    <section>
      <h4>${title}（${list.length}）</h4>
      ${isEdit ? `<div class="pe-editor" data-kind="${kind}">${formHtml(spec, obj, st)}
          <div class="pe-row"><button data-act="save-item" data-kind="${kind}">保存</button><button data-act="cancel-edit">取消</button>
          ${kind === 'work' && obj && list.some(x => x.id === obj.id) ? `<button data-act="reroll-work" data-id="${obj.id}" title="资料改动后，重新推演尚未批准的回应">按新资料重推</button><button data-act="gen-card" data-id="${obj.id}" title="先保存原文，再生成">生成证据卡</button>` : ''}</div>
          ${kind === 'work' && obj?.evidence ? `<details><summary>证据卡（${h(obj.evidence.builtAt?.slice(0, 10) || '')}，${(obj.evidence.keyPoints || []).length} 条）</summary><div class="pe-text">${h(cardText(obj.evidence, 6000)).replace(/\n/g, '<br>')}</div></details>` : ''}</div>`
        : `<button data-act="new-item" data-kind="${kind}">＋ 新增</button>`}
      <table class="pe-table">${list.map(x => `<tr><td>${labelFn(x)}</td><td class="pe-nowrap">
        <button class="pe-mini" data-act="edit-item" data-kind="${kind}" data-id="${x.id}">编辑</button>
        <button class="pe-mini" data-act="del-item" data-kind="${kind}" data-id="${x.id}">删除</button></td></tr>`).join('')}</table>
    </section>`;
}

function works(st) {
    return listBlock('笔名', 'penname', st.pennames, PEN_SPEC, st, p => `<b>${h(p.name)}</b> ${p.owner ? '<small>（' + h(p.owner) + '）</small>' : ''} ${p.publicIdentityKnown ? '<small class="pe-tag">身份已公开</small>' : ''}`)
        + listBlock('作品', 'work', [...st.works].sort((a, b) => cmp(a.pubDate || '9', b.pubDate || '9')), WORK_SPEC, st, w => `<b>《${h(w.title)}》</b> <small>${h(byId(st.pennames, w.pennameId)?.name || '')} · ${h(FORMS[w.form] || '')} · ${h(byId(st.outlets, w.outletId)?.name || '')} · ${h(w.pubDate || '未定日期')}</small>`);
}

function people(st) {
    return listBlock('刊物', 'outlet', st.outlets, OUTLET_SPEC, st, o => `<b>${h(o.name)}</b> <small>${h(PERIODICITY[o.periodicity] || '')}${o.periodicity === 'weekly' && Number.isInteger(o.weekday) ? '·' + WEEKDAYS[o.weekday] : ''} · ${h(CIRCLES[o.circle] || '')} · ${h(tagsToText(o.politics))}</small>`)
        + listBlock('人物', 'person', st.persons, PERSON_SPEC, st, p => `<b>${h(p.name)}</b> <small>${(p.roles || []).map(r => ROLES[r]).join('/')} · ${(p.outletIds || []).map(id => byId(st.outlets, id)?.name).filter(Boolean).join('、') || '无供稿刊物'} · 私交：${CLOSE[p.closeness || 0]}${p.real ? ' · 真实人物' : ''}${p.active === false ? ' · 不参与推演' : ''}</small>`);
}

function era(st, s) {
    const prof = getEra();
    const year = st.era?.year || (st.currentDate ? yearOf(st.currentDate) : '');
    const titles = defaultWikiTitles(year, st.era?.country || '', s.wikiLangs).map(t => `${t.lang}:${t.title}`).join('\n');
    const sec = (label, v) => v && (Array.isArray(v) ? v.length : true) ? `<p><b>${label}</b>：${h(Array.isArray(v) ? v.map(x => typeof x === 'string' ? x : Object.values(x).filter(Boolean).join(' / ')).join('；') : v)}</p>` : '';
    return `
    <section>
      <h4>年代档案 ${prof ? `<small>（截至 ${h(prof.asOf || prof.year)}，资料：${h((prof.sources || []).join('，') || '模型知识')}）</small>` : ''}</h4>
      ${prof ? `${sec('概况', prof.summary)}${sec('货币', prof.currency)}${sec('报刊格局', prof.pressLandscape)}${sec('活跃评论家', prof.critics)}${sec('潮流', prof.movements)}${sec('近期大事', prof.recentEvents)}${sec('文体', prof.styleNotes)}${sec('时代用语', prof.vocabulary)}${sec('禁止出现', prof.forbiddenAnachronisms)}${sec('待核', prof.uncertain)}` : '<p>尚未生成。生成后，写稿和注入都会按这个年代约束。</p>'}
      <div class="pe-row">
        <button data-act="era-build" ${s.wikiEnabled ? '' : 'disabled'}>检索维基百科并生成</button>
        <button data-act="era-build-nowiki">仅用模型知识生成</button>
        ${prof ? '<button data-act="era-propose">把其中的刊物与评论家加入待合并</button><button data-act="era-edit">编辑 JSON</button><button data-act="era-clear">清除</button>' : ''}
      </div>
      <details><summary>检索的维基页面（每行 语言:标题，可改）</summary><textarea id="pe-wiki-titles" rows="5">${h(titles)}</textarea>
      <small>同年份的页面会自动剪掉当前故事日期之后的月份和条目，避免剧透未来。</small></details>
      ${editing?.kind === 'era' ? `<textarea id="pe-era-json" rows="16">${h(JSON.stringify(prof, null, 2))}</textarea><div class="pe-row"><button data-act="era-save-json">保存</button><button data-act="cancel-edit">取消</button></div>` : ''}
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

function importTab(st) {
    const order = { penname: 0, outlet: 1, person: 2, work: 3, reaction: 4 };
    const kindName = { penname: '笔名', outlet: '刊物', person: '人物', work: '作品', reaction: '已发生反响' };
    const pend = st.pendingMerge.map((p, i) => ({ p, i })).sort((a, b) => order[a.p.kind] - order[b.p.kind]);
    const epi = epistolaryAvailable();
    const hints = (st.epiHints || []).filter(x => !x.handled);
    return `
    <section>
      <h4>书信簿（st-epistolary）联动</h4>
      ${epi ? `<p><small>已检测到书信簿。这里只读取，不会改动书信簿的档案。信里提到作品的地方只作为<b>辅助线索</b>，默认不算已发生的反响，由你逐条决定。</small></p>
        <div class="pe-row"><button data-act="epi-scan">扫描信件中的作品线索</button><button data-act="epi-people">把书信簿人物加入待合并</button>
        <small>书信簿剧情日期：${h(epistolaryStoryDate() || '未设定')}</small></div>
        <ul class="pe-list">${hints.map(x => `<li><b>${h(x.date || '日期不详')}</b> ${h(x.code)} ${h(x.author)} → ${h((x.recipients || []).join('、'))}
          · ${x.workTitle ? '《' + h(x.workTitle) + '》' : '笔名 ' + h(x.penname)}
          <div class="pe-evi">${h(x.excerpt)}</div><small>${h(x.suggestion)}${x.personId ? '' : '（此人还不在人物列表里）'}</small>
          <div class="pe-row">
            ${x.workId && x.personId && /^\d{4}-\d{2}-\d{2}$/.test(x.date) ? `<button class="pe-mini" data-act="epi-hint-read" data-id="${h(x.id)}">${x.direction === 'from_user' ? '记为对方经书信得知并读过' : '记为此人已读过'}</button>` : ''}
            ${x.workId && x.personId && x.direction === 'to_user' && /^\d{4}-\d{2}-\d{2}$/.test(x.date) ? `<button class="pe-mini" data-act="epi-hint-letter" data-id="${h(x.id)}">记为一封已发生的私信反响</button>` : ''}
            <button class="pe-mini" data-act="epi-hint-ignore" data-id="${h(x.id)}">忽略</button>
          </div></li>`).join('') || '<li>暂无线索。</li>'}</ul>`
        : '<p><small>没有检测到书信簿插件。装了书信簿的话，这里可以从信件里找到“谁在信里谈过哪部作品”的线索。</small></p>'}
    </section>
    <section>
      <h4>从书信簿抽取</h4>
      <p><small>把书信簿、设定或剧情记录贴在下面，或者填世界书名称。模型只抽取原文明确写出的内容，每条附原文依据；结果先进待合并列表，由你勾选。</small></p>
      <div class="pe-row"><input id="pe-wb-name" type="text" placeholder="世界书名称" style="width:14em"><button data-act="wb-load">读取世界书到文本框</button></div>
      <textarea id="pe-import-text" rows="8" placeholder="粘贴文本……"></textarea>
      <div class="pe-row"><button data-act="extract">开始抽取</button></div>
    </section>
    <section>
      <h4>待合并（${pend.length}）</h4>
      ${pend.length ? `<div class="pe-row"><button data-act="merge-selected">合并选中</button><button data-act="merge-selall">全选</button><button data-act="merge-clear">清空列表</button></div>
        <small>会按 笔名 → 刊物 → 人物 → 作品 → 已发生反响 的顺序合并，这样人物的供稿刊物、作品的署名能对上。</small>` : ''}
      <ul class="pe-list">${pend.map(({ p, i }) => `<li><label><input type="checkbox" class="pe-merge-cb" value="${i}">
        <span class="pe-tag">${kindName[p.kind] || p.kind}</span> <b>${h(p.data.name || p.data.title || `${p.data.date || ''} ${p.data.person || ''}`)}</b></label>
        <small>${h(truncate(JSON.stringify(p.data), 220))}</small>
        ${p.evidence ? `<div class="pe-evi">依据：${h(p.evidence)}</div>` : '<div class="pe-evi pe-warn">无原文依据</div>'}
        <small>来源：${h(p.source || '')}</small></li>`).join('')}</ul>
    </section>`;
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
      <div class="pe-row"><button data-act="settings-save">保存设置</button><button data-act="api-test">测试模型连接</button></div>
    </section>
    <section>
      <h4>本聊天的数据</h4>
      <div class="pe-row">
        <button data-act="state-export">导出 JSON</button>
        <label class="menu_button pe-file">导入 JSON<input type="file" id="pe-import-file" accept=".json" hidden></label>
        <button data-act="state-reset">清空本聊天数据</button>
      </div>
      <small>数据随聊天文件保存。推演随机种子：${h(st.seed)}（同一存档结果可复现）。</small>
    </section>`;
}

// ———————————— 交互 ————————————

function onChange(e) {
    const t = e.target;
    if (t.id === 'pe-ledger-filter') { ledgerFilter = t.value; refresh(); }
    if (t.id === 'pe-import-file' && t.files?.[0]) {
        const r = new FileReader();
        r.onload = () => {
            try {
                const obj = JSON.parse(r.result);
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
    if (!btn) return;
    if (btn.dataset.tab) { tab = btn.dataset.tab; editing = null; refresh(); return; }
    if (btn.dataset.tabGo) { tab = btn.dataset.tabGo; editing = null; refresh(); return; }
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
            refresh(); break;
        }
        case 'edit-item': editing = { kind: btn.dataset.kind, id: btn.dataset.id }; refresh(); break;
        case 'cancel-edit': editing = null; refresh(); break;
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
            $('#pe-import-text').value = await loadWorldbookText(name);
            setBusy('');
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
        case 'epi-people': {
            const props = peopleProposals(st);
            st.pendingMerge.push(...props);
            commit(props.length ? `已加入 ${props.length} 位人物到待合并（默认无公开身份，请补上身份和供稿刊物）` : '书信簿里没有新人物');
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
