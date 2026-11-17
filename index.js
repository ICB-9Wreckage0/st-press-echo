// 报刊回声 · Press Echo —— 文学/报刊特化的世界推演扩展
// 入口：挂界面、监听消息识别故事日期、推进推演、刷新注入。

import { getSettings, getState, saveState, logLine } from './src/store.js';
import { pickStoryDate, yearOf, weekdayZh, WEEKDAY_ZH } from './src/date.js';
import { applyInjection } from './src/inject.js';
import { guessPlace } from './src/era.js';
import { mountUI, refresh, togglePanel, getEra, doAdvance, syncEraYear } from './src/ui.js';
import { takeSnapshot, rollbackFrom, snapshotFor } from './src/rollback.js';
import { epistolaryStoryDate } from './src/epistolary.js';
import { diffDays, cmp } from './src/date.js';

const TAG = '[报刊回声]';

function ctx() { return globalThis.SillyTavern?.getContext?.(); }

function refreshInjection() {
    const st = getState();
    if (!st) return;
    applyInjection(st, getEra(), getSettings());
}

/** 从聊天识别故事日期。manual=true 时从最近几条消息里找，并给出提示 */
function detectFromChat(manual = false, messageId = null) {
    const s = getSettings();
    const st = getState();
    const c = ctx();
    if (!st || !c?.chat?.length) return;
    if (!manual && (!s.enabled || !s.autoDetectDate)) return;

    const msgs = messageId != null && c.chat[messageId] ? [c.chat[messageId]] : c.chat.slice(manual ? -6 : -1).reverse();
    let pick = null;
    for (const m of msgs) {
        if (!m?.mes || m.is_system) continue;
        pick = pickStoryDate(m.mes, st.currentDate, { maxJumpDays: s.maxJumpDays, headChars: s.headChars });
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
    if (pick.iso === st.currentDate) { saveState(); refresh(); return; }

    // 首次：顺便猜地点
    if (!st.era.place) {
        const g = guessPlace(c.chat.slice(-30).map(m => m.mes).join('\n'));
        if (g) { st.era.place = g.label; st.era.country = g.country; st.era.lang = g.lang; }
    }
    const prevYear = st.currentDate ? yearOf(st.currentDate) : null;

    if (messageId != null && (s.autoAdvance || !st.currentDate)) takeSnapshot(st, messageId, pick.iso);
    if (!st.currentDate) {
        st.currentDate = pick.iso;
        syncEraYear(st);
        logLine(st, `从消息识别到起始日期 ${pick.iso}`);
        saveState();
    } else if (s.autoAdvance || manual) {
        doAdvance(st, s, pick.iso);
    } else {
        st.detectedDate = pick.iso;
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
    if (!st || !s.enabled || !s.epiSyncDate || !st.currentDate) return;
    const d = epistolaryStoryDate();
    if (!d || cmp(d, st.currentDate) <= 0) return;
    if (diffDays(d, st.currentDate) > (s.maxJumpDays || 120)) return;
    if (!s.autoAdvance) { st.detectedDate = d; saveState(); refresh(); return; }
    if (messageId != null) takeSnapshot(st, messageId, d);
    doAdvance(st, s, d);
    logLine(st, `跟随书信簿剧情日期推进到 ${d}`);
    refreshInjection();
    refresh();
}

/** 楼层被删、改写或换回复时回滚 */
function onRollback(mesId, reason, redetect) {
    const st = getState();
    if (!st || mesId == null || mesId < 0) return;
    if (redetect) {
        // 改写 / 换回复：如果这条消息识别出的日期没变，就不动
        const snap = snapshotFor(st, mesId);
        const m = ctx()?.chat?.[mesId];
        if (snap && m?.mes) {
            const pick = pickStoryDate(m.mes, snap.currentDate, { maxJumpDays: getSettings().maxJumpDays, headChars: getSettings().headChars });
            if (pick?.iso === snap.toDate) return;
        }
    }
    const r = rollbackFrom(st, mesId);
    if (!r) return;
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
    eventSource.on(E.MESSAGE_RECEIVED, onMsg);
    if (E.MESSAGE_SENT) eventSource.on(E.MESSAGE_SENT, onMsg);
    if (E.MESSAGE_EDITED) eventSource.on(E.MESSAGE_EDITED, id => onRollback(num(id), '被改写', true));
    if (E.MESSAGE_SWIPED) eventSource.on(E.MESSAGE_SWIPED, id => onRollback(num(id), '换了回复', true));
    if (E.MESSAGE_DELETED) eventSource.on(E.MESSAGE_DELETED, len => onRollback(num(len), '被删除', false));

    refreshInjection();
    console.log(TAG, '已加载');
}

if (globalThis.jQuery) globalThis.jQuery(() => init());
else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
