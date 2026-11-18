// llm.js — 调用模型。两种模式：
//  'st'     用酒馆当前连接（generateRaw），不需要另配 API；
//  'custom' 独立的 OpenAI 兼容接口，不占用主对话的模型和上下文。

import { clog, countAi } from './console.js';

export async function callLLM({ system, user, settings, maxTokens, label = '' }) {
    const s = settings || {};
    const responseLength = maxTokens || s.maxTokens || 1800;
    const via = s.apiMode === 'custom' ? `独立 API${s.apiModel ? ' · ' + s.apiModel : ''}` : '酒馆当前连接';
    const t0 = Date.now();
    countAi();
    clog('ai', `调用模型${label ? '：' + label : ''}（${via}；提示词 ${(String(system || '').length + String(user || '').length).toLocaleString()} 字，最多输出 ${responseLength} token）`,
        `【系统提示词】\n${String(system || '').slice(0, 4000)}${String(system || '').length > 4000 ? '\n……（后略）' : ''}\n\n【用户内容】\n${String(user || '').slice(0, 4000)}${String(user || '').length > 4000 ? '\n……（后略）' : ''}`);
    try {
        const out = s.apiMode === 'custom' ? await callCustom({ system, user, s, responseLength }) : await callST({ system, user, responseLength });
        const txt = String(out ?? '');
        clog(txt.trim() ? 'info' : 'warn', `模型返回 ${txt.length.toLocaleString()} 字，用时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒${txt.trim() ? '' : '（空回复）'}`, txt.slice(0, 6000) || null);
        return out;
    } catch (err) {
        clog('error', `模型调用失败（${((Date.now() - t0) / 1000).toFixed(1)} 秒）：${err.message || err}`, err.stack || null);
        throw err;
    }
}

async function callCustom({ system, user, s, responseLength }) {
    if (!s.apiUrl) throw new Error('未填写独立 API 地址');
    let url = s.apiUrl.trim().replace(/\/+$/, '');
    if (!/\/chat\/completions$/.test(url)) url += '/chat/completions';
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(s.apiKey ? { Authorization: `Bearer ${s.apiKey}` } : {}),
        },
        body: JSON.stringify({
            model: s.apiModel || undefined,
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
        throw new Error(`独立 API 返回 ${res.status}：${t.slice(0, 300)}`);
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text;
    if (!content) throw new Error('独立 API 返回中没有内容');
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
