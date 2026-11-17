// rollback.js — 按聊天楼层回滚。
// 每次由某条消息触发推进前，记一个轻量快照（只记推演状态，不复制已写好的文章正文）。
// 那条消息被删除、改写、换成别的回复（swipe）时，退回快照：
//  - 撤掉之后由引擎新生成的事件与阅读记录；
//  - 保留你手动录入的内容、你的批准/驳回决定和已写好的正文；
//  - 声誉按剩下的已批准事件重新计算。

import { recomputeReputation } from './engine.js';

const MAX_SNAPSHOTS = 40;

export function takeSnapshot(state, mesId, toDate = null) {
    if (mesId == null) return;
    state.snapshots = state.snapshots || [];
    // 同一楼层只留最早那份（它代表“这条消息出现之前”的状态）
    if (state.snapshots.some(s => s.mesId === mesId)) return;
    state.snapshots.push({
        mesId,
        toDate,
        at: new Date().toISOString(),
        currentDate: state.currentDate,
        weekdayWarning: state.weekdayWarning || null,
        rolls: JSON.parse(JSON.stringify(state.rolls || {})),
        rumors: JSON.parse(JSON.stringify(state.rumors || [])),
        eventIds: (state.ledger || []).map(e => e.id),
        eventStatus: Object.fromEntries((state.ledger || []).filter(e => e.origin === 'engine').map(e => [e.id, e.status])),
        receptionIds: (state.receptions || []).map(r => r.id),
    });
    state.snapshots.sort((a, b) => a.mesId - b.mesId);
    if (state.snapshots.length > MAX_SNAPSHOTS) state.snapshots.splice(0, state.snapshots.length - MAX_SNAPSHOTS);
}

/** 回到 mesId 这条消息出现之前。返回是否真的回滚了 */
export function rollbackFrom(state, mesId) {
    const snaps = (state.snapshots || []).filter(s => s.mesId >= mesId);
    if (!snaps.length) return false;
    const snap = snaps[0];
    const keepEv = new Set(snap.eventIds);
    const keepRec = new Set(snap.receptionIds);
    state.currentDate = snap.currentDate;
    state.weekdayWarning = snap.weekdayWarning;
    state.rolls = snap.rolls;
    state.rumors = snap.rumors;
    // 被撤掉的事件里，你亲手作过的决定（批准/驳回/改稿）按事件键记下来；
    // 之后推演再次生成同一条（同键同日）时自动套回去，免得改一个错字就丢掉审核结果
    state.decisionMemo = state.decisionMemo || {};
    const removed = [];
    for (const e of state.ledger || []) {
        if (e.origin === 'manual' || keepEv.has(e.id)) continue;
        removed.push(e);
        if (e.key && !e.auto && (e.status === 'approved' || e.status === 'rejected' || e.text?.body || e.note)) {
            state.decisionMemo[e.key] = { date: e.date, status: e.status, polarity: e.polarity, text: e.text, note: e.note, flags: e.flags };
        }
    }
    state.ledger = (state.ledger || []).filter(e => e.origin === 'manual' || keepEv.has(e.id));
    for (const e of state.ledger) {
        // 快照时还在排期中的，退回排期（你亲手的批准保留，自动通过的撤回）
        if (snap.eventStatus[e.id] === 'scheduled' && (e.status !== 'approved' || e.auto)) { e.status = 'scheduled'; e.auto = false; }
    }
    state.receptions = (state.receptions || []).filter(r => r.origin === 'manual' || keepRec.has(r.id));
    state.snapshots = state.snapshots.filter(s => s.mesId < mesId);
    state.detectedDate = null;
    recomputeReputation(state);
    return { removed: removed.length, toDate: snap.toDate, restoredDate: snap.currentDate };
}

/** 查看某楼层的快照（不改动状态） */
export function snapshotFor(state, mesId) {
    return (state.snapshots || []).find(s => s.mesId === mesId) || null;
}

/** 推演后调用：把记下的决定套回同键同日的新事件。返回套回的条数 */
export function reapplyDecisions(state, events) {
    const memo = state.decisionMemo || {};
    let n = 0;
    for (const ev of events) {
        const m = ev.key && memo[ev.key];
        if (!m || m.date !== ev.date) continue;
        ev.status = m.status;
        ev.polarity = m.polarity;
        if (m.text) ev.text = m.text;
        if (m.note) ev.note = m.note;
        if (m.flags) ev.flags = m.flags;
        delete memo[ev.key];
        n++;
    }
    return n;
}
