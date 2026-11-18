// store.js — 存档。故事数据跟着聊天存（chat metadata），设置和年代档案缓存跟着扩展设置存。
import { stripSources } from './sources.js';

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
    // 世界书
    loreEnabled: false,
    loreAuto: true,
    loreBook: '报刊回声',
    loreScope: 'involved', // involved 读过作品/登记了立场/与主角相识的人 · all 全部人物
    loreWorks: true,
    loreBindChat: true,
    epiEnabled: true, // 书信簿（st-epistolary）联动总开关
    epiSyncDate: true,
    epiSendAuto: true, // 入账并写好正文的私信，自动寄进书信簿（寄给主角） // 书信簿（st-epistolary）推算出更晚的剧情日期时，一并采用
    autoAdvance: true, // 旧版开关，保留兼容
    autoAdvanceMode: 'interval', // interval 故事时间每过 N 天推演一次 / every 每次识别到新日期 / off 只手动
    autoAdvanceDays: 14,
    maxJumpDays: 120,
    headChars: 160,
    // 注入
    injectEnabled: true,
    injectPosition: 1, // 0 = 系统提示词内，1 = 聊天内（按深度），2 = 最前
    injectDepth: 4,
    injectMaxItems: 12,
    injectMaxRumors: 5,
    panelOpacity: 90,
    includeHidden: true,
    chatSource: 'summary', // 读聊天：summary=有摘要块的楼只读摘要；full=读全文
    readUser: false, // 整理时读主角（用户）的发言
    summaryTags: 'Narrative_Matrix',
    summaryFallback: 'full', // 没有摘要块的楼：full 读全文 / skip 跳过（主角发言仍读）
    knowPublic: 'reads',
    clipDays: 3,
    loreMaxChars: 1500,
    injectEraNotes: true,
    injectOffscreen: 'known', // 幕后内容注入：off 不注入 / known 只注入主角能知道的 / all 全部（标明主角不知道）
    // 一键推演时让 AI 补完
    aiFill: 'opinions', // off / brief 幕后补完 / opinions 再给新读者生成看法 / all 再给新入账反响写稿
    aiFillMax: 10,
    aiFillOnAuto: false,
    autoFloorEvery: 0,
    autoFloorDelay: 5, // 只按 N 楼之前的内容推演，最新几楼重roll、改写不会牵连 // 每聊满 N 楼自动跑一次“一键推演到今天”（0 = 不按楼数）
    aiSuggestPersons: true, // AI 补完时推荐可能读到作品的新人物（进待确认）
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
    eraRefresh: 'quarter', // 年代档案按季度 / 按月刷新（off 不刷新）
    eraRefreshMode: 'auto', // auto 到期自动刷新（调用 1 次 AI）/ remind 只提醒
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
        privateFacts: [], // 主角的私人信息与知情者
        perceptions: [], // 每个人对作者的认知
        factLeaks: [], // 私人信息可能外传的候选
        outletChecks: [], // AI 核对刊物资料，待确认
        relSuggestions: [], // AI 查到、待确认的人物关系
        selfImage: [], // 主角怎么看自己（self）、对外怎么说（claim）
        assumed: [], // 主角以为某人 / 某圈子怎么看他
        publicImages: [], // 各读者圈子的公众形象（AI 依据公开材料整理）
        percReviews: [], // 认知对照分析（AI）
        projects: [], // 创作构想（不是作品，不进阅读/名声）
        ideaTalks: [], // 灵感讨论：谁在场、谁提了什么、采纳没有
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
    const saved = all[MODULE];
    // 旧版只有“识别到新日期后自动推演”开关：关着的迁移成“不自动”，开着的迁移成“按间隔”
    if (saved && saved.autoAdvanceMode === undefined) saved.autoAdvanceMode = saved.autoAdvance === false ? 'off' : 'interval';
    all[MODULE] = Object.assign({}, DEFAULT_SETTINGS, saved || {});
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
    try { const st = ctx()?.chatMetadata?.[MODULE]; if (st) stripSources(st, () => saveState()); } catch (e) { console.warn('[报刊回声]', e); }
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

/** 自动推演方式（兼容旧版的开关） */
export function advanceMode(s) {
    if (s.autoAdvanceMode) return s.autoAdvanceMode;
    return s.autoAdvance === false ? 'off' : 'interval';
}
