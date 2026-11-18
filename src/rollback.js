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
    // 轻量快照：之后新生成的掷骰、阅读记录、事件、推荐都带递增序号 q，回滚时撤掉 q 大于 rollQ 的即可，
    // 不必复制整张表（旧版每个快照几十 KB，40 个就是几 MB，拖慢聊天保存）
    state.snapshots.push({
        v: 2, mesId, toDate,
        at: new Date().toISOString(),
        currentDate: state.currentDate,
        weekdayWarning: state.weekdayWarning || null,
        rollQ: state.rollSeq || 0,
        rumors: JSON.parse(JSON.stringify(state.rumors || [])),
        followers: JSON.parse(JSON.stringify(state.followers || {})),
        identityLeaks: JSON.parse(JSON.stringify(state.identityLeaks || [])),
        factLeaks: JSON.parse(JSON.stringify(state.factLeaks || [])),
        // 只记当时还在排期中的引擎事件：回滚时把它们退回排期
        scheduled: (state.ledger || []).filter(e => e.origin === 'engine' && e.status === 'scheduled').map(e => e.id),
        offscreenIds: (state.offscreen || []).map(d => d.id),
    });
    state.snapshots.sort((a, b) => a.mesId - b.mesId);
    if (state.snapshots.length > MAX_SNAPSHOTS) state.snapshots.splice(0, state.snapshots.length - MAX_SNAPSHOTS);
}

/** 回到 mesId 这条消息出现之前。返回是否真的回滚了 */
export function rollbackFrom(state, mesId) {
    const snaps = (state.snapshots || []).filter(s => s.mesId >= mesId);
    if (!snaps.length) return false;
    const snap = snaps[0];
    const v2 = snap.v === 2;
    const Q = snap.rollQ || 0;
    const keepQ = (x, list) => !x?.q || x.q <= Q || (list && list.has(x.id));
    const keepEvList = new Set(snap.keepEvents || []), keepRecList = new Set(snap.keepRecs || []);
    const keepEv = v2 ? e => keepQ(e, keepEvList) : (ids => e => ids.has(e.id))(new Set(snap.eventIds || []));
    const keepRec = v2 ? r => keepQ(r, keepRecList) : (ids => r => ids.has(r.id))(new Set(snap.receptionIds || []));
    state.currentDate = snap.currentDate;
    state.weekdayWarning = snap.weekdayWarning;
    if (snap.rolls) state.rolls = snap.rolls; // 旧版快照
    else { const keep = new Set(snap.keepRolls || []); for (const [k, v] of Object.entries(state.rolls || {})) if ((v?.q || 0) > Q && !keep.has(k)) delete state.rolls[k]; }
    state.rumors = snap.rumors;
    state.followers = snap.followers || {};
    state.identityLeaks = snap.identityLeaks || [];
    if (snap.factLeaks) state.factLeaks = snap.factLeaks;
    // 被撤掉的事件里，你亲手作过的决定（批准/驳回/改稿）按事件键记下来；
    // 之后推演再次生成同一条（同键同日）时自动套回去，免得改一个错字就丢掉审核结果
    state.decisionMemo = state.decisionMemo || {};
    const removed = [];
    for (const e of state.ledger || []) {
        if (e.origin === 'manual' || keepEv(e)) continue;
        removed.push(e);
        if (e.key && !e.auto && (e.status === 'approved' || e.status === 'rejected' || e.text?.body || e.note)) {
            state.decisionMemo[e.key] = { date: e.date, status: e.status, polarity: e.polarity, text: e.text, note: e.note, flags: e.flags };
        }
    }
    state.ledger = (state.ledger || []).filter(e => e.origin === 'manual' || keepEv(e));
    const wasScheduled = v2 ? new Set(snap.scheduled || []) : new Set(Object.entries(snap.eventStatus || {}).filter(([, st]) => st === 'scheduled').map(([id]) => id));
    for (const e of state.ledger) {
        // 快照时还在排期中的，退回排期（你亲手的批准保留，自动通过的撤回）
        if (wasScheduled.has(e.id) && (e.status !== 'approved' || e.auto)) { e.status = 'scheduled'; e.auto = false; }
    }
    state.receptions = (state.receptions || []).filter(r => r.origin === 'manual' || keepRec(r));
    // 印象跟着阅读记录走；推荐按序号撤
    const recIds = new Set(state.receptions.map(r => r.id));
    state.perceptions = (state.perceptions || []).filter(p => !p.recId || recIds.has(p.recId));
    // 公众形象与对照分析是按当时的公开材料整理的：之后整理的一起撤
    if (v2) { state.publicImages = (state.publicImages || []).filter(x => keepQ(x)); state.percReviews = (state.percReviews || []).filter(x => keepQ(x)); }
    if (snap.impressions) state.impressions = snap.impressions;
    else for (const pm of Object.values(state.impressions || {})) for (const pid of Object.keys(pm || {})) pm[pid] = pm[pid].filter(x => !x.recId || recIds.has(x.recId));
    if (snap.recommends) state.recommends = snap.recommends;
    else { const keep = new Set(snap.keepRecommends || []); for (const [wid, box] of Object.entries(state.recommends || {})) for (const [pid, x] of Object.entries(box || {})) if ((x?.q || 0) > Q && !keep.has(`${wid}|${pid}`)) delete box[pid]; }
    if (snap.offscreenIds) { const keepOs = new Set(snap.offscreenIds); state.offscreen = (state.offscreen || []).filter(d => keepOs.has(d.id)); }
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

/**
 * 延迟自动推演之后调用：这次推演只用到了 fromMesId 楼之前的内容，
 * 所以之后楼层的快照也应包含它的结果——否则重roll最新几楼时，会把这次推演一起撤掉。
 */
export function rebaseSnapshots(state, fromMesId, before, target) {
    const newEv = (state.ledger || []).filter(e => !before.events.has(e.id));
    const newRec = (state.receptions || []).filter(r => !before.recs.has(r.id)).map(r => r.id);
    const newOs = (state.offscreen || []).filter(d => !before.os.has(d.id)).map(d => d.id);
    const newRolls = Object.keys(state.rolls || {}).filter(k => !before.rolls.has(k));
    const newRecs = Object.entries(state.recommends || {}).flatMap(([wid, box]) => Object.entries(box || {}).filter(([, x]) => (x?.q || 0) > (before.q || 0)).map(([pid]) => `${wid}|${pid}`));
    let n = 0;
    for (const snap of state.snapshots || []) {
        if (snap.mesId < fromMesId) continue;
        n++;
        const add = (k, list) => { snap[k] = [...new Set([...(snap[k] || []), ...list])]; };
        if (snap.v === 2) {
            add('keepEvents', newEv.map(e => e.id)); add('keepRecs', newRec); add('keepRolls', newRolls); add('keepRecommends', newRecs);
            add('scheduled', newEv.filter(e => e.status === 'scheduled').map(e => e.id));
        } else {
            add('eventIds', newEv.map(e => e.id)); add('receptionIds', newRec);
            for (const e of newEv) if (e.origin === 'engine' && snap.eventStatus) snap.eventStatus[e.id] = e.status;
            if (snap.rolls) for (const k of newRolls) snap.rolls[k] = state.rolls[k];
            for (const k of ['impressions', 'recommends']) if (snap[k]) snap[k] = JSON.parse(JSON.stringify(state[k] || {}));
        }
        if (snap.offscreenIds) add('offscreenIds', newOs);
        if (target && (!snap.currentDate || snap.currentDate < target)) snap.currentDate = target;
        for (const k of ['followers', 'rumors']) snap[k] = JSON.parse(JSON.stringify(state[k] || (k === 'rumors' ? [] : {})));
    }
    return n;
}
