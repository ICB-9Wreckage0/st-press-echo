// store.js — 存档。故事数据跟着聊天存（chat metadata），设置和年代档案缓存跟着扩展设置存。

import { DEFAULT_ENGINE_SETTINGS } from './engine.js';

export const MODULE = 'press_echo';
const STATE_VERSION = 2;

export const DEFAULT_SETTINGS = {
    enabled: true,
    // 推演
    ...DEFAULT_ENGINE_SETTINGS,
    autoDetectDate: true,
    epiSyncDate: true, // 书信簿（st-epistolary）推算出更晚的剧情日期时，一并采用
    autoAdvance: true,
    maxJumpDays: 120,
    headChars: 160,
    // 注入
    injectEnabled: true,
    injectPosition: 1, // 0 = 系统提示词内，1 = 聊天内（按深度），2 = 最前
    injectDepth: 4,
    injectMaxItems: 12,
    injectEraNotes: true,
    // 写稿
    apiMode: 'st', // 'st' 用酒馆当前连接；'custom' 用独立 OpenAI 兼容接口
    apiUrl: '',
    apiKey: '',
    apiModel: '',
    temperature: 0.7,
    maxTokens: 1800,
    realPersonPolicy: 'stance', // 'stance' 真实人物只写立场摘要；'full' 允许拟写全文（会标注虚构）
    outputLanguage: '中文',
    // 年代检索
    wikiEnabled: true,
    wikiLangs: 'fr,en,zh',
    eraCache: {},
};

export function defaultState() {
    return {
        version: STATE_VERSION,
        seed: Math.random().toString(36).slice(2, 10),
        currentDate: null,
        weekdayWarning: null,
        era: { year: null, place: '', country: '', lang: '', key: null },
        eraNotes: [],
        pennames: [],
        works: [],
        persons: [],
        outlets: [],
        ledger: [],
        receptions: [],
        snapshots: [],
        decisionMemo: {},
        epiHints: [],
        rolls: {},
        rumors: [],
        reputation: {},
        pendingMerge: [],
        log: [],
    };
}

function ctx() {
    return globalThis.SillyTavern?.getContext?.();
}

export function getSettings() {
    const c = ctx();
    if (!c) return { ...DEFAULT_SETTINGS };
    const all = c.extensionSettings;
    all[MODULE] = Object.assign({}, DEFAULT_SETTINGS, all[MODULE] || {});
    all[MODULE].layerMult = Object.assign({}, DEFAULT_SETTINGS.layerMult, all[MODULE].layerMult || {});
    return all[MODULE];
}

export function saveSettings() {
    ctx()?.saveSettingsDebounced?.();
}

export function getState() {
    const c = ctx();
    if (!c || !c.chatMetadata) return null;
    const meta = c.chatMetadata;
    if (!meta[MODULE] || typeof meta[MODULE] !== 'object') meta[MODULE] = defaultState();
    const st = meta[MODULE];
    // 补齐旧存档缺的字段
    const def = defaultState();
    for (const k of Object.keys(def)) if (st[k] === undefined) st[k] = def[k];
    return st;
}

let saveTimer = null;
export function saveState() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        const c = ctx();
        if (!c) return;
        if (typeof c.saveMetadata === 'function') c.saveMetadata();
        else if (typeof c.saveChat === 'function') c.saveChat();
    }, 400);
}

export function resetState() {
    const c = ctx();
    if (!c?.chatMetadata) return null;
    c.chatMetadata[MODULE] = defaultState();
    saveState();
    return c.chatMetadata[MODULE];
}

export function replaceState(obj) {
    const c = ctx();
    if (!c?.chatMetadata) return null;
    c.chatMetadata[MODULE] = Object.assign(defaultState(), obj || {});
    saveState();
    return c.chatMetadata[MODULE];
}

export function logLine(state, text) {
    state.log = state.log || [];
    state.log.unshift({ at: new Date().toISOString(), date: state.currentDate, text });
    if (state.log.length > 200) state.log.length = 200;
}
