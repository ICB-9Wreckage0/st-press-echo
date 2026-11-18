// llm.js — 调用模型。两种模式：
//  'st'     用酒馆当前连接（generateRaw），不需要另配 API；
//  'custom' 独立的 OpenAI 兼容接口，不占用主对话的模型和上下文。

import { clog, countAi, taskStep, currentTask } from './console.js';

// ———— 主对话在生成时先等一等（只对“酒馆当前连接”有意义：独立 API 不抢同一个连接） ————
let mainGenerating = false;
let ownCalls = 0;
/** 由 index.js 接到酒馆的生成开始/结束事件时调用 */
export function noteMainGeneration(on) { if (on && ownCalls) return; mainGenerating = !!on; }
function stBusy() {
    if (mainGenerating) return true;
    const stop = typeof document !== 'undefined' ? document.getElementById('mes_stop') : null;
    if (stop) { const cs = getComputedStyle(stop); if (cs.display !== 'none' && cs.visibility !== 'hidden') return true; }
    return false;
}
async function waitMainIdle(label) {
    if (!stBusy()) return;
    const t0 = Date.now();
    clog('warn', `主对话正在生成，等它结束再调用模型${label ? '（' + label + '）' : ''}`);
    const t = currentTask(); if (t) taskStep('等主对话生成结束…', t.i, t.n);
    while (stBusy()) {
        if (Date.now() - t0 > 10 * 60 * 1000) { clog('warn', '等了 10 分钟主对话还在生成，直接调用'); break; }
        await new Promise(r => setTimeout(r, 800));
    }
    // 生成刚结束时酒馆还要保存、渲染，稍等一下
    await new Promise(r => setTimeout(r, 1200));
    clog('info', `主对话生成结束，继续（等了 ${Math.round((Date.now() - t0) / 1000)} 秒）`);
}

// 用酒馆当前连接时，插件自己的几路调用（自动补完、年代档案刷新、你手动点的）排队一个个来，免得同时抢一个连接
let stQueue = Promise.resolve();
export async function callLLM(args) {
    if ((args.settings || {}).apiMode === 'custom') return callLLMNow(args);
    const run = stQueue.then(() => callLLMNow(args));
    // 前一路卡住超过 5 分钟就不再等它，免得整个队列被一次没回音的调用堵死
    let timer;
    const timeout = new Promise(r => { timer = setTimeout(r, 5 * 60 * 1000); });
    run.finally(() => clearTimeout(timer)).catch(() => {});
    stQueue = Promise.race([run.catch(() => {}), timeout]);
    return run;
}
async function callLLMNow({ system, user, settings, maxTokens, label = '' }) {
    const s = settings || {};
    const responseLength = maxTokens || s.maxTokens || 1800;
    const via = s.apiMode === 'custom' ? `独立 API${s.apiModel ? ' · ' + s.apiModel : ''}` : '酒馆当前连接';
    if (s.apiMode !== 'custom') await waitMainIdle(label);
    const t0 = Date.now();
    countAi();
    clog('ai', `调用模型${label ? '：' + label : ''}（${via}；提示词 ${(String(system || '').length + String(user || '').length).toLocaleString()} 字，最多输出 ${responseLength} token）`,
        `【系统提示词】\n${String(system || '').slice(0, 4000)}${String(system || '').length > 4000 ? '\n……（后略）' : ''}\n\n【用户内容】\n${String(user || '').slice(0, 4000)}${String(user || '').length > 4000 ? '\n……（后略）' : ''}`);
    try {
        ownCalls++;
        let out;
        try { out = s.apiMode === 'custom' ? await callCustom({ system, user, s, responseLength }) : await callST({ system, user, responseLength }); } finally { ownCalls--; }
        const txt = String(out ?? '');
        clog(txt.trim() ? 'info' : 'warn', `模型返回 ${txt.length.toLocaleString()} 字，用时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒${txt.trim() ? '' : '（空回复）'}`, txt.slice(0, 6000) || null);
        return out;
    } catch (err) {
        clog('error', `模型调用失败（${((Date.now() - t0) / 1000).toFixed(1)} 秒）：${err.message || err}`, err.stack || null);
        throw err;
    }
}

/** 独立 API 的根地址（去掉末尾的 /chat/completions 或 /models） */
export function apiBase(u) { return String(u || '').trim().replace(/\/+$/, '').replace(/\/(chat\/completions|models)$/, ''); }
const keyOf = s => String(s.apiKey || '').trim().replace(/^Bearer\s+/i, '');
const tail = k => (k ? `…${k.slice(-4)}（共 ${k.length} 位）` : '（空）');
function httpHint(status, s) {
    const k = keyOf(s);
    if (status === 401 || status === 403) return `\n→ 密钥无效。插件里存的密钥是 ${tail(k)}，和服务商后台的对一下。浏览器有时会把保存的登录密码自动填进密钥栏（顺带把用户名填进上面的地址栏），请重新粘贴一次密钥并检查地址。`;
    if (status === 404) return `\n→ 地址或模型名不对。地址一般写到 /v1 为止（插件会自己补 /chat/completions），模型名可以点“获取模型列表”选。`;
    if (status === 402) return '\n→ 账户余额不足。';
    if (status === 429) return '\n→ 请求太频繁或额度用完，稍后再试。';
    return '';
}

/** 读模型列表（OpenAI 兼容的 GET /models） */
export async function listModels(s) {
    const base = apiBase(s.apiUrl);
    if (!base) throw new Error('先填独立 API 地址');
    const k = keyOf(s);
    const res = await fetch(base + '/models', { headers: k ? { Authorization: `Bearer ${k}` } : {} });
    if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`读取模型列表失败 ${res.status}：${t.slice(0, 200)}${httpHint(res.status, s)}`); }
    const data = await res.json().catch(() => null);
    const arr = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : Array.isArray(data) ? data : [];
    return [...new Set(arr.map(m => (typeof m === 'string' ? m : m?.id || m?.name)).filter(Boolean).map(String))].sort();
}

async function callCustom({ system, user, s, responseLength }) {
    if (!s.apiUrl) throw new Error('未填写独立 API 地址');
    const url = apiBase(s.apiUrl) + '/chat/completions';
    const k = keyOf(s);
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(k ? { Authorization: `Bearer ${k}` } : {}),
        },
        body: JSON.stringify({
            model: String(s.apiModel || '').trim() || undefined,
            messages: [
                { role: 'system', content: system },
                { role: 'user', content: user },
            ],
            temperature: Number(s.temperature ?? 0.7),
            max_tokens: responseLength,
        }),
    });
    if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`独立 API 返回 ${res.status}：${t.slice(0, 300)}${httpHint(res.status, s)}`);
    }
    const data = await res.json();
    const ch = data?.choices?.[0];
    let content = ch?.message?.content ?? ch?.text;
    if (Array.isArray(content)) content = content.map(x => (typeof x === 'string' ? x : x?.text || '')).join('');
    if (!content) {
        const think = ch?.message?.reasoning_content || ch?.message?.reasoning;
        if (think && ch?.finish_reason === 'length') throw new Error(`模型把输出额度都用在“思考”上了，正文还没开始就到上限（${responseLength} token）。这是推理型模型，请在设置里调大“最多输出 token”，或换非推理模型`);
        if (data?.error) throw new Error(`独立 API 报错：${JSON.stringify(data.error).slice(0, 300)}`);
        throw new Error(`独立 API 返回中没有内容（finish_reason=${ch?.finish_reason ?? '无'}）：${JSON.stringify(data).slice(0, 300)}`);
    }
    return content;
}

async function callST({ system, user, responseLength }) {
    const c = globalThis.SillyTavern?.getContext?.();
    if (!c) throw new Error('找不到酒馆上下文');
    const fn = c.generateRaw;
    if (typeof fn === 'function') {
        // 新版：generateRaw({ prompt, systemPrompt, responseLength })；旧版：位置参数
        if (fn.length <= 1) {
            return await fn({ prompt: user, systemPrompt: system, responseLength });
        }
        return await fn(user, '', false, false, system, responseLength);
    }
    if (typeof c.generateQuietPrompt === 'function') {
        return await c.generateQuietPrompt(`${system}\n\n${user}`, false, true);
    }
    throw new Error('当前酒馆版本没有可用的生成接口，请在设置里改用独立 API');
}
