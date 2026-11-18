// console.js — 插件内的控制台：记录正在做哪一步、调用了几次模型、各步结果和报错。
// 只放在内存里（刷新页面就清空），不写进聊天存档。

const MAX = 600;
const entries = [];
const subs = new Set();
let task = null;
let seq = 0;

const notify = (e) => { for (const fn of subs) { try { fn(e, task); } catch { /* 控制台自身不能再报错 */ } } };

export const LEVELS = { task: '任务', step: '步骤', ai: '模型', ok: '完成', info: '信息', warn: '注意', error: '错误' };

export function clog(level, text, detail = null) {
    const e = { id: ++seq, t: Date.now(), level, text: String(text ?? ''), detail: detail == null ? null : typeof detail === 'string' ? detail : safeJson(detail), task: task?.name || '' };
    entries.push(e);
    if (entries.length > MAX) entries.splice(0, entries.length - MAX);
    if (level === 'error' && task) task.failed = true;
    notify(e);
    return e;
}
function safeJson(v) { try { return JSON.stringify(v, null, 2); } catch { return String(v); } }

/** 开始一项任务（同名任务进行中则沿用） */
export function taskBegin(name) {
    if (task && !task.ending) return task;
    if (task?.ending) { clearTimeout(task.ending); task = null; }
    task = { name, start: Date.now(), i: 0, n: 0, label: '', ai: 0, failed: false };
    clog('task', `开始：${name}`);
    return task;
}
/** 任务内的一步：i/n 用来画进度条 */
export function taskStep(label, i = 0, n = 0) {
    if (!task) taskBegin(label);
    Object.assign(task, { label, i, n });
    clog('step', `${n ? `[${i}/${n}] ` : ''}${label}`);
}
/** 结束任务。稍等一拍再记，让紧随其后的报错能把它标成失败 */
export function taskEnd(note = '') {
    if (!task || task.ending) return;
    const t = task;
    t.ending = setTimeout(() => {
        const sec = ((Date.now() - t.start) / 1000).toFixed(1);
        if (task === t) task = null;
        clog(t.failed ? 'error' : 'ok', `${t.name}${t.failed ? '失败' : '完成'}（${sec} 秒${t.ai ? `，调用模型 ${t.ai} 次` : ''}）${note ? '：' + note : ''}`);
    }, 0);
}
export const currentTask = () => task;
export const allEntries = () => entries.slice();
export function clearEntries() { entries.length = 0; notify(null); }
export function subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }
export function countAi() { if (task) task.ai++; }

export function entriesText() {
    return entries.map(e => `${new Date(e.t).toLocaleTimeString()} [${LEVELS[e.level] || e.level}] ${e.text}${e.detail ? '\n' + e.detail.split('\n').map(x => '    ' + x).join('\n') : ''}`).join('\n');
}
