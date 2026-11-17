// llm.js — 调用模型。两种模式：
//  'st'     用酒馆当前连接（generateRaw），不需要另配 API；
//  'custom' 独立的 OpenAI 兼容接口，不占用主对话的模型和上下文。

export async function callLLM({ system, user, settings, maxTokens }) {
    const s = settings || {};
    const responseLength = maxTokens || s.maxTokens || 1800;
    if (s.apiMode === 'custom') return callCustom({ system, user, s, responseLength });
    return callST({ system, user, responseLength });
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
