// store.js — 存档。故事数据跟着聊天存（chat metadata），设置和年代档案缓存跟着扩展设置存。

import { DEFAULT_ENGINE_SETTINGS } from './engine.js';

export const MODULE = 'press_echo';
const STATE_VERSION = 2;

export const DEFAULT_SETTINGS = {
    enabled: true,
    fabPos: null, // 悬浮按钮位置 { right, bottom }
    winRect: null, // 面板位置和大小 { left, top, width, height }
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
    injectOffscreen: 'known', // 幕后内容注入：off 不注入 / known 只注入主角能知道的 / all 全部（标明主角不知道）
    // 一键推演时让 AI 补完
    aiFill: 'opinions', // off / brief 幕后补完 / opinions 再给新读者生成看法 / all 再给新入账反响写稿
    aiFillMax: 10,
    aiFillOnAuto: false,
    consoleAuto: true,
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
        pendingBundle: null,
        followers: {},
        impressions: {},
        recommends: {},
        identityLeaks: [],
        epiHints: [],
        rolls: {},
        rumors: [],
        offscreen: [],
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

/** 这份数据像不像“整理包”（而不是插件自己导出的存档） */
export function looksLikeBundleData(obj) {
    if (!obj || typeof obj !== 'object') return false;
    if (obj.format === 'press-echo-import') return true;
    const noId = list => Array.isArray(list) && list.length && list.some(x => x && typeof x === 'object' && !x.id);
    return noId(obj.persons) || noId(obj.works) || noId(obj.pennames) || noId(obj.outlets);
}

export function replaceState(obj) {
    const c = ctx();
    if (!c?.chatMetadata) return null;
    if (looksLikeBundleData(obj)) throw new Error('这是“整理包”，不是插件导出的存档。请到“导入与整理”页读取整理包（会先给出预览，再按名字合并）。');
    c.chatMetadata[MODULE] = Object.assign(defaultState(), obj || {});
    saveState();
    return c.chatMetadata[MODULE];
}

export function logLine(state, text) {
    state.log = state.log || [];
    state.log.unshift({ at: new Date().toISOString(), date: state.currentDate, text });
    if (state.log.length > 200) state.log.length = 200;
}
