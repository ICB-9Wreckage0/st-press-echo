// 报刊回声 · Press Echo —— 文学/报刊特化的世界推演扩展
// 入口：挂界面、监听消息识别故事日期、推进推演、刷新注入。

import { getSettings, getState, saveState, logLine, advanceMode } from './src/store.js';
import { pickStoryDate, yearOf, weekdayZh, WEEKDAY_ZH } from './src/date.js';
import { applyInjection } from './src/inject.js';
import { guessPlace } from './src/era.js';
import { mountUI, refresh, togglePanel, getEra, doAdvance, syncEraYear, aiFill, runSimNow } from './src/ui.js';
import { takeSnapshot, rollbackFrom, snapshotFor, textSig, sigSim } from './src/rollback.js';
import { epistolaryStoryDate } from './src/epistolary.js';
import { noteMainGeneration } from './src/llm.js';
import { diffDays, cmp } from './src/date.js';

const TAG = '[报刊回声]';

function ctx() { return globalThis.SillyTavern?.getContext?.(); }

function refreshInjection() {
    const st = getState();
    if (!st) return;
    applyInjection(st, getEra(), getSettings());
}

/** 从聊天识别故事日期。manual=true 时从最近几条消息里找，并给出提示 */
/** 按设置决定这次要不要推演：每次 / 满 N 天 / 只手动 */
function shouldAdvance(st, s, d) {
    const mode = advanceMode(s);
    if (mode === 'every') return true;
    if (mode === 'off') return false;
    return diffDays(d, st.currentDate) >= Math.max(1, Number(s.autoAdvanceDays) || 14);
}

function detectFromChat(manual = false, messageId = null) {
    const s = getSettings();
    const st = getState();
    const c = ctx();
    if (!st || !c?.chat?.length) return;
    if (st.backfillRun) return; // 回溯进行中：不随消息推进
    if (!manual && (!s.enabled || !s.autoDetectDate)) return;

    const msgs = messageId != null && c.chat[messageId] ? [c.chat[messageId]] : c.chat.slice(manual ? -6 : -1).reverse();
    let pick = null;
    for (const m of msgs) {
        if (!m?.mes || m.is_system) continue;
        pick = pickStoryDate(m.mes, st.detectedDate && cmp(st.detectedDate, st.currentDate || '') > 0 ? st.detectedDate : st.currentDate, { maxJumpDays: s.maxJumpDays, headChars: s.headChars });
        if (pick) break;
    }
    if (!pick) {
        if (manual) globalThis.toastr?.info('最近的消息里没有找到新的故事日期', '报刊回声');
        return;
    }
    if (pick.weekdayMismatch) {
        st.weekdayWarning = `消息里写的是${WEEKDAY_ZH[pick.statedWeekday]}，但 ${pick.iso} 实际是${weekdayZh(pick.iso)}（原文：“${pick.raw}”）`;
        globalThis.toastr?.warning(st.weekdayWarning, '报刊回声 · 星期不符');
    }
    if (pick.iso === st.currentDate || pick.iso === st.detectedDate) { saveState(); refresh(); return; }

    // 首次：顺便猜地点
    if (!st.era.place) {
        const g = guessPlace(c.chat.slice(-30).map(m => m.mes).join('\n'));
        if (g) { st.era.place = g.label; st.era.country = g.country; st.era.lang = g.lang; }
    }
    const prevYear = st.currentDate ? yearOf(st.currentDate) : null;

    if (messageId != null) takeSnapshot(st, messageId, pick.iso, c.chat[messageId]?.mes ?? null);
    if (messageId != null) { st.dateLog = (st.dateLog || []).filter(x => x.mesId !== messageId); st.dateLog.push({ mesId: messageId, date: pick.iso }); }
    if (!st.currentDate) {
        st.currentDate = pick.iso;
        syncEraYear(st);
        logLine(st, `从消息识别到起始日期 ${pick.iso}`);
        saveState();
    } else if (manual || shouldAdvance(st, s, pick.iso)) {
        const from = st.currentDate;
        const before = new Set((st.receptions || []).map(r => r.id));
        doAdvance(st, s, pick.iso);
        if (!manual && s.aiFillOnAuto && s.aiFill && s.aiFill !== 'off') {
            const fresh = new Set((st.receptions || []).filter(r => !before.has(r.id)).map(r => r.id));
            aiFill(st, s, { from, to: pick.iso, fresh, auto: true }).catch(e => console.warn('[报刊回声] AI 补完失败', e));
        }
    } else {
        // 先只记下故事日期，攒够天数再推演（或等你点“一键推演”）
        if (!st.detectedDate || cmp(pick.iso, st.detectedDate) > 0) st.detectedDate = pick.iso;
        saveState();
    }
    if (prevYear && yearOf(pick.iso) !== prevYear && !getEra()) {
        globalThis.toastr?.info(`故事进入 ${yearOf(pick.iso)} 年，可以在“年代档案”里生成新的时代约束`, '报刊回声');
    }
    refreshInjection();
    refresh();
}

/** 书信簿推算出更晚的剧情日期时跟上（只前进，不超过最大跨度） */
function syncFromEpistolary(messageId = null) {
    const s = getSettings();
    const st = getState();
    if (!st || !s.enabled || s.epiEnabled === false || !s.epiSyncDate || !st.currentDate) return;
    const d = epistolaryStoryDate();
    if (!d || cmp(d, st.currentDate) <= 0) return;
    if (diffDays(d, st.currentDate) > (s.maxJumpDays || 120)) return;
    if (messageId != null) takeSnapshot(st, messageId, d);
    if (!shouldAdvance(st, s, d)) { if (!st.detectedDate || cmp(d, st.detectedDate) > 0) st.detectedDate = d; saveState(); refreshInjection(); refresh(); return; }
    doAdvance(st, s, d);
    logLine(st, `跟随书信簿剧情日期推进到 ${d}`);
    refreshInjection();
    refresh();
}

/** 楼层被删、改写或换回复时回滚 */
function onRollback(mesId, reason, redetect) {
    const st = getState();
    if (!st || mesId == null || mesId < 0 || st.backfillRun) return;
    if (redetect) {
        // 改写 / 换回复：如果这条消息识别出的日期没变，就不动
        const snap = snapshotFor(st, mesId);
        const m = ctx()?.chat?.[mesId];
        if (snap && m?.mes) {
            const pick = pickStoryDate(m.mes, snap.currentDate, { maxJumpDays: getSettings().maxJumpDays, headChars: getSettings().headChars });
            // 日期没变，还要看正文变了多少：改几个错字不动；内容大改（同一天、事情不一样了）照样回滚重推
            const sim = sigSim(snap.sig, textSig(m.mes));
            if (pick?.iso === snap.toDate && (sim == null || sim >= 0.6)) return;
            if (pick?.iso === snap.toDate) reason += '（同一天，但内容大改）';
        }
    }
    if (st.dateLog) st.dateLog = st.dateLog.filter(x => x.mesId < mesId);
    const r = rollbackFrom(st, mesId);
    if (!r) { saveState(); return; }
    logLine(st, `${reason}：回到 ${r.restoredDate || '（未设定）'}，撤掉 ${r.removed} 条推演事件`);
    saveState();
    if (r.removed) globalThis.toastr?.info(`第 ${mesId} 楼${reason}，报刊推演退回到 ${r.restoredDate || '起点'}（撤掉 ${r.removed} 条；你审核过的会在重推时沿用）`, '报刊回声');
    if (redetect) detectFromChat(false, mesId);
    refreshInjection();
    refresh();
}

function addSettingsDrawer() {
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host || document.getElementById('pe-drawer')) return;
    const div = document.createElement('div');
    div.id = 'pe-drawer';
    div.innerHTML = `
    <div class="inline-drawer">
      <div class="inline-drawer-toggle inline-drawer-header">
        <b>📰 报刊回声</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
      </div>
      <div class="inline-drawer-content">
        <p>文学/报刊特化的世界推演：按作品形式、刊物周期、私交与年代，推演谁会在哪天写什么评论。</p>
        <label class="checkbox_label"><input type="checkbox" id="pe-enabled"> 启用</label>
        <div class="menu_button" id="pe-open">打开面板</div>
      </div>
    </div>`;
    host.appendChild(div);
    const s = getSettings();
    const cb = div.querySelector('#pe-enabled');
    cb.checked = !!s.enabled;
    cb.addEventListener('change', () => {
        s.enabled = cb.checked;
        ctx()?.saveSettingsDebounced?.();
        refreshInjection();
        refresh();
    });
    div.querySelector('#pe-open').addEventListener('click', () => togglePanel(true));
}

/** 第 idx 楼之前识别到的最晚故事日期 */
function dateBefore(st, idx) {
    let d = null;
    for (const x of st.dateLog || []) if (x.mesId < idx && (!d || cmp(x.date, d) > 0)) d = x.date;
    return d || st.currentDate;
}

/** 每聊满 N 楼自动跑一次“一键推演到今天”（只在 AI 回复完之后检查，避免和主对话的生成撞车） */
function floorTrigger() {
    const s = getSettings();
    const st = getState();
    const n = Math.floor(Number(s.autoFloorEvery) || 0);
    const delay = Math.max(0, Math.floor(Number(s.autoFloorDelay) || 0));
    const len = ctx()?.chat?.length || 0;
    const eff = Math.max(0, len - delay); // 只算到这一楼之前
    if (!st || !s.enabled || n <= 0 || !st.currentDate) return;
    if (st.floorMark == null || eff < st.floorMark) { st.floorMark = eff; saveState(); return; } // 第一次，或删了楼
    if (eff - st.floorMark < n) return;
    const prevMark = st.floorMark;
    st.floorMark = eff;
    saveState();
    const until = delay ? dateBefore(st, eff) : null;
    runSimNow(st, s, { auto: true, reason: `又聊了 ${n} 楼，按第 ${eff} 楼之前的剧情${delay ? `，延迟 ${delay} 楼` : ''}`, until, rebaseFrom: delay ? eff : null, chatSkip: delay })
        .then(r => { if (r === false) { st.floorMark = prevMark; saveState(); } })
        .catch(e => { st.floorMark = prevMark; saveState(); console.warn(TAG, '自动推演失败，下一楼再试', e); });
}

async function init() {
    const c = ctx();
    if (!c) { console.error(TAG, '找不到 SillyTavern.getContext，扩展无法启动'); return; }
    getSettings();
    addSettingsDrawer();
    mountUI({ refreshInjection, detectFromChat });

    const { eventSource, event_types: E } = c;
    eventSource.on(E.CHAT_CHANGED, () => { refreshInjection(); refresh(); });
    const num = x => (typeof x === 'number' ? x : (x != null && !isNaN(+x) ? +x : null));
    const onMsg = id => { detectFromChat(false, num(id)); syncFromEpistolary(num(id)); };
    eventSource.on(E.MESSAGE_RECEIVED, id => { onMsg(id); floorTrigger(); });
    if (E.MESSAGE_SENT) eventSource.on(E.MESSAGE_SENT, onMsg);
    if (E.GENERATION_STARTED) eventSource.on(E.GENERATION_STARTED, (type, opts, dry) => { if (!dry && type !== 'quiet') noteMainGeneration(true); });
    for (const k of ['GENERATION_ENDED', 'GENERATION_STOPPED']) if (E[k]) eventSource.on(E[k], () => noteMainGeneration(false));
    if (E.MESSAGE_EDITED) eventSource.on(E.MESSAGE_EDITED, id => onRollback(num(id), '被改写', true));
    if (E.MESSAGE_SWIPED) eventSource.on(E.MESSAGE_SWIPED, id => onRollback(num(id), '换了回复', true));
    if (E.MESSAGE_DELETED) eventSource.on(E.MESSAGE_DELETED, len => onRollback(num(len), '被删除', false));

    refreshInjection();
    console.log(TAG, '已加载');
}

if (globalThis.jQuery) globalThis.jQuery(() => init());
else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
