// inject.js — 注入主对话的“报刊现状”。
// 借鉴 World 的“知情边界”：只注入主角此刻能知道的东西；并明确告诉主模型，
// 列表以外的书评不存在，不得自行编造。

import { LAYERS, CIRCLES, repLabel, knownToUser, byId } from './engine.js';
import { weekdayZh } from './date.js';
import { truncate } from './util.js';
import { offscreenLines } from './offscreen.js';

export const INJECT_KEY = 'press_echo';

export function buildInjection(state, era, settings) {
    if (!state) return '';
    const L = [];
    const today = state.detectedDate && state.currentDate && state.detectedDate > state.currentDate ? state.detectedDate : state.currentDate;
    L.push(`[报刊回声｜故事日期 ${today || '未设定'}${today ? '（' + weekdayZh(today) + '）' : ''}${state.era?.place ? '｜' + state.era.place : ''}]`);

    if (settings.injectEraNotes && era) {
        const bits = [];
        if (era.currency) bits.push(`货币：${truncate(era.currency, 60)}`);
        if (era.forbiddenAnachronisms?.length) bits.push(`此时尚不存在：${era.forbiddenAnachronisms.slice(0, 12).join('、')}`);
        if (bits.length) L.push('时代约束：' + bits.join('；'));
    }

    for (const pen of state.pennames || []) {
        const rep = state.reputation?.[pen.id];
        if (!rep) continue;
        const parts = Object.entries(rep).filter(([, v]) => Math.abs(v) >= 0.2).map(([c, v]) => `${CIRCLES[c] || c}${repLabel(v)}`);
        if (parts.length) L.push(`署名“${pen.name}”的名声：${parts.join('，')}${pen.publicIdentityKnown ? '' : '（公众不知其真实身份）'}`);
    }

    const known = (state.ledger || []).filter(e => knownToUser(state, e));
    const recent = known.slice(-(settings.injectMaxItems || 12));
    if (recent.length) {
        L.push(`主角已知的反响（共 ${known.length} 条，列出最近 ${recent.length} 条）：`);
        for (const e of recent) {
            const person = byId(state.persons, e.personId);
            const outlet = byId(state.outlets, e.outletId);
            const work = byId(state.works, e.workId);
            const who = person?.name || e.personName || '';
            const where = outlet ? `《${outlet.name}》` : '';
            const what = e.layer === 'reader_letters' ? `读者来信约 ${e.count} 封` : e.layer === 'mentions' ? `各报转载/提及约 ${e.count} 条` : (LAYERS[e.layer]?.label || e.layer);
            const pol = (e.layer === 'reader_letters' || e.layer === 'mentions') ? '' : ['（批评）', '（褒贬参半）', '（肯定）'][e.polarity + 1];
            const sum = e.text?.summary ? '：' + truncate(e.text.summary, 70) : '';
            L.push(`- ${e.date.slice(5)} ${where}${who}${what}${pol}${work ? (e.layer === 'mentions' || e.layer === 'reader_letters' ? '，关于《' : '，评《') + work.title + '》' : ''}${sum}`);
        }
    }

    const rumors = (state.rumors || []).filter(r => r.strength >= 0.25);
    if (rumors.length) {
        L.push('坊间传闻：');
        for (const r of rumors) L.push(`- ${r.text}（热度 ${Math.round(r.strength * 100)}%）`);
    }

    const os = offscreenLines(state, settings.injectOffscreen, 8);
    if (os.length) { L.push(settings.injectOffscreen === 'all' ? '幕后（文学界在主角看不到处发生的事）：' : '主角听说的文坛动静：'); L.push(...os); }

    L.push('规则：以上列表之外的书评、报道、私信视为尚不存在，正文不得自行编造新的评论或评论者；主角只能知道已见报或寄给他本人的内容；尚在排期中的文章对任何角色都不可见。');
    return L.join('\n');
}

export function applyInjection(state, era, settings) {
    const c = globalThis.SillyTavern?.getContext?.();
    if (!c || typeof c.setExtensionPrompt !== 'function') return;
    const text = settings.enabled && settings.injectEnabled ? buildInjection(state, era, settings) : '';
    try {
        c.setExtensionPrompt(INJECT_KEY, text, Number(settings.injectPosition ?? 1), Number(settings.injectDepth ?? 4), false, 0);
    } catch (e) {
        console.warn('[报刊回声] 注入失败', e);
    }
}
