import assert from 'assert';
import { findDates, pickStoryDate, weekdayZh, addDays } from '../src/date.js';
import { advanceTo, setStatus, LAYERS, recordManualReading, isMajor } from '../src/engine.js';
import { takeSnapshot, rollbackFrom } from '../src/rollback.js';
import { defaultState } from '../src/store.js';
import { trimFuture } from '../src/era.js';
import { buildInjection } from '../src/inject.js';
import { buildWriterPrompt, checkAnachronism } from '../src/writer.js';
import { extractJSON } from '../src/util.js';
import { DEFAULT_SETTINGS } from '../src/store.js';

// —— 日期识别 ——
const t1 = '六月二十四日傍晚……1890 年 6 月 24 日（星期二），马索大街。提到普兰齐尼 1887年8月31日 被处决。';
const p1 = pickStoryDate(t1, '1890-06-20');
assert.equal(p1.iso, '1890-06-24'); assert.equal(p1.weekdayMismatch, false);
const p2 = pickStoryDate('1890 年 6 月 24 日（星期三）', null);
assert.equal(p2.weekdayMismatch, true);
assert.equal(pickStoryDate('一八九〇年十月二十九日夜里，总理……', '1890-10-01').iso, '1890-10-29');
assert.equal(pickStoryDate('Paris, le 24 juin 1890. Mardi.', null).iso, '1890-06-24');
assert.equal(pickStoryDate('Lundi 1er septembre 1890', null).iso, '1890-09-01');
assert.equal(pickStoryDate('June 24, 1890', null).iso, '1890-06-24');
assert.equal(pickStoryDate('他想起1887年8月31日的处决。', '1890-06-24'), null, '旧日期不应让时间倒退');
assert.equal(pickStoryDate('1891年3月1日', '1890-06-24', { maxJumpDays: 120 }), null, '跨度过大视为引述');
assert.equal(weekdayZh('1890-05-26'), '星期一');
assert.equal(weekdayZh('1890-08-30'), '星期六');
console.log('日期识别 ✓');

// —— 剪掉未来 ——
const wiki = `== Événements ==\n=== Juin ===\n24 juin : quelque chose\n=== Août ===\n6 août : exécution de Kemmler\n== Naissances ==\n2 juin : X\n29 juillet : Y meurt`;
const tr = trimFuture(wiki, '1890-06-24');
assert(!tr.includes('Kemmler')); assert(!tr.includes('29 juillet')); assert(tr.includes('24 juin')); assert(tr.includes('2 juin'));
console.log('剪掉未来 ✓');

assert.deepEqual(extractJSON('前言```json\n{"a":1,}\n```'), { a: 1 });

// —— 用你的 1890 时间线做一次推演 ——
const st = defaultState();
st.seed = 'test-seed';
const O = (id, name, periodicity, circle, tier, politics = [], extra = {}) => ({ id, name, periodicity, circle, tier, politics, sections: [], weekday: null, monthDays: [], real: true, ...extra });
st.outlets = [
  O('echo', '巴黎回声报', 'daily', 'general', 4, ['文学日报']),
  O('mercure', '法兰西信使', 'monthly', 'literary', 2, ['象征派']),
  O('insurge', '造反者', 'weekly', 'radical', 2, ['无政府主义'], { weekday: 6 }),
  O('temps', '时报', 'daily', 'critics', 4, ['温和共和派']),
  O('debats', '争论报', 'daily', 'critics', 3, ['保守', '天主教']),
  O('plume', '羽毛', 'biweekly', 'literary', 2, ['青年文学']),
  O('gil', '吉尔·布拉斯', 'daily', 'general', 4, ['轻松']),
  O('croix', '十字架报', 'daily', 'religious', 4, ['天主教']),
  O('figaro', '费加罗报', 'daily', 'general', 5, ['保守']),
  O('spirite', '灵学评论', 'monthly', 'professional', 1, ['招魂术']),
];
const P = (id, name, roles, outletIds, interests, likes, dislikes, closeness, extra = {}) => ({ id, name, roles, outletIds, interests, likes, dislikes, closeness, monthlyCapacity: 2, real: true, active: true, ...extra });
st.persons = [
  P('france', '法朗士', ['critic'], ['temps'], ['讽刺', '宗教', '历史', '日记'], ['伏尔泰式讽刺', '怀疑', '同情'], [], 2, { columnWeekday: 0, monthlyCapacity: 1 }),
  P('mirbeau', '米尔博', ['writer', 'journalist'], ['echo', 'figaro'], ['社会', '死刑', '孤独'], ['同情', '社会批判'], [], 3, { knowsIdentity: true }),
  P('gourmont', '古尔蒙', ['critic'], ['mercure'], ['象征', '宗教', '招魂术'], ['怀疑'], [], 1),
  P('debatsc', '争论报某撰稿人', ['critic'], ['debats'], ['宗教', '法律'], [], ['宗教比较', '反教权'], 0, { real: false }),
  P('plumec', '羽毛青年评论员', ['critic'], ['plume'], ['神话', '小说', '日本'], ['幽默', '哲理故事'], [], 0, { real: false }),
  P('gilc', '吉尔布拉斯专栏', ['journalist'], ['gil'], ['八卦', '身份'], [], [], 0, { real: false, monthlyCapacity: 3 }),
  P('croixc', '十字架报社论', ['journalist'], ['croix'], ['宗教'], [], ['反教权', '宗教比较', '怀疑', '无政府主义'], 0, { real: false }),
  P('spiritc', '灵学撰稿人', ['scholar'], ['spirite'], ['招魂术'], [], ['怀疑', '揭穿灵媒'], 0, { real: false }),
];
st.pennames = [{ id: 'ee', name: 'E.E.', owner: '勒鲁', publicIdentityKnown: false, knownBy: ['mirbeau', 'france'] }];
const W = (id, title, form, outletId, pubDate, endDate, themes) => ({ id, title, pennameId: 'ee', form, outletId, pubDate, endDate, themes, summary: '' });
st.works = [
  W('w1999', '1999年12月31日', 'article', 'insurge', '1890-04-12', '', ['未来', '社会批判', '机器']),
  W('wcorner', '长子', 'serial', 'echo', '1890-04-15', '1890-04-19', ['家庭', '自杀', '工人', '同情']),
  W('wfutur', '未来百货', 'article', 'insurge', '1890-04-19', '', ['未来', '商业', '社会批判', '慈善']),
  W('wld1', '生者与死亡 第一册', 'pamphlet', 'mercure', '1890-05-01', '', ['宗教', '宗教比较', '神话', '死亡', '历史']),
  W('wishida', '石田日记', 'translation_serial', 'echo', '1890-05-01', '1890-05-13', ['日本', '日记', '失忆', '孤独']),
  W('wporte', '共和国的门', 'serial', 'echo', '1890-05-29', '1890-06-07', ['政治', '讽刺', '宪法', '法律']),
  W('wtest', '第十条遗嘱', 'serial', 'echo', '1890-06-16', '1890-06-24', ['法律', '遗产', '人口', '讽刺']),
  W('wishidab', '石田日记 单行本', 'translation_book', 'echo', '1890-06-23', '', ['日本', '日记', '失忆']),
  W('wld2', '生者与死亡 第二册', 'pamphlet', 'mercure', '1890-07-01', '', ['招魂术', '医学', '死亡', '怀疑', '揭穿灵媒']),
  W('wcroc', '池中的鳄鱼', 'article', 'echo', '1890-08-30', '', ['寓言', '孤独', '同情']),
];
const S = { ...DEFAULT_SETTINGS, autoApprove: 'none' };
let d = '1890-04-12';
st.currentDate = d;
while (d < '1890-08-30') { d = addDays(d, 3); if (d > '1890-08-30') d = '1890-08-30'; advanceTo(st, d, S, null); }
// 全部批准
for (const e of st.ledger.filter(e => e.status === 'candidate')) setStatus(st, e, 'approved');
const inWindow = st.ledger.filter(e => e.status === 'approved' && e.date >= '1890-05-26' && e.date <= '1890-08-30');
const pub = inWindow.filter(e => LAYERS[e.layer].public);
const substantive = pub.filter(e => e.layer === 'review' || e.layer === 'polemic');
console.log('\n4/12–8/30 全部反响：');
for (const e of st.ledger.filter(e => e.status !== 'rejected')) {
  const p = st.persons.find(x => x.id === e.personId); const w = st.works.find(x => x.id === e.workId); const o = st.outlets.find(x => x.id === e.outletId);
  console.log(`${e.date} ${weekdayZh(e.date)} ${e.status.padEnd(9)} ${LAYERS[e.layer].label.padEnd(5)} ${(o?.name||'').padEnd(6)} ${(p?.name||'').padEnd(8)} 《${w.title}》 ${e.layer==='reader_letters'? e.count+'封' : ['批评','参半','肯定'][e.polarity+1]} p=${e.p ?? ''}`);
}
console.log(`\n5/26–8/30：公开反响 ${pub.length} 条，其中正式书评+论战 ${substantive.length} 条`);
const fr = st.ledger.filter(e => e.personId === 'france' && (e.layer === 'review' || e.layer === 'notice'));
for (const e of fr) assert.equal(weekdayZh(e.date), '星期日', '法朗士的专栏应落在周日');
for (const e of st.ledger.filter(e => e.outletId === 'insurge' && LAYERS[e.layer].public)) assert.equal(weekdayZh(e.date), '星期六');
for (const e of st.ledger.filter(e => e.outletId === 'mercure' && LAYERS[e.layer].public)) assert.equal(e.date.slice(8), '01');
console.log('出刊日约束 ✓');
console.log('声誉：', JSON.stringify(st.reputation));
console.log('传闻：', st.rumors.map(r => `${r.text.slice(0,20)}… ${r.strength}`));

// 可复现：同种子重跑
const fresh = () => { const x = JSON.parse(JSON.stringify(st)); x.ledger = []; x.rolls = {}; x.reputation = {}; x.rumors = []; x.receptions = []; x.snapshots = []; x.currentDate = '1890-04-12'; return x; };
const st2 = fresh();
let d2 = '1890-04-12'; while (d2 < '1890-08-30') { d2 = addDays(d2, 3); if (d2 > '1890-08-30') d2 = '1890-08-30'; advanceTo(st2, d2, S, null); }
assert.deepEqual(st2.ledger.map(e => e.key + e.date).sort(), st.ledger.map(e => e.key + e.date).sort());
const st3 = fresh();
advanceTo(st3, '1890-06-01', S, null); advanceTo(st3, '1890-08-30', S, null);
console.log('步长不同时事件数：', st3.ledger.length, 'vs', st2.ledger.length);
console.log('可复现 ✓');

// —— 漏斗统计 ——
const R = st.receptions;
const cnt = k => R.filter(r => r.read === k).length;
console.log(`\n阅读记录 ${R.length} 条：未接触 ${cnt('none')}，接触未读 ${cnt('ignored')}，读一部分 ${cnt('skimmed')}，读完 ${cnt('finished')}`);
const expr = {}; for (const r of R) expr[r.expression || '-'] = (expr[r.expression || '-'] || 0) + 1;
console.log('表达分布：', JSON.stringify(expr));
assert(R.filter(r => ['skimmed', 'finished'].includes(r.read)).length > R.filter(r => r.expression === 'public').length, '读过的人应多于公开发表的人');
for (const r of R) assert(Array.isArray(r.why) && r.why.length, '每条阅读记录都要有理由');
// 刊物版面：同一期同一刊物不超过容量
const perIssue = {};
for (const e of st.ledger.filter(e => e.origin === 'engine' && e.personId && LAYERS[e.layer].public)) { const k = e.outletId + e.date; perIssue[k] = (perIssue[k] || 0) + 1; }
console.log('单期最多篇数：', Math.max(0, ...Object.values(perIssue)));
console.log('漏斗 ✓');

// —— 自动通过 ——
const sa = fresh();
let da = '1890-04-12'; while (da < '1890-07-01') { da = addDays(da, 5); advanceTo(sa, da, { ...S, autoApprove: 'minor' }, null); }
assert(sa.ledger.filter(e => e.auto).every(e => !isMajor(sa, e)), '重要事件不应自动通过');
assert(sa.ledger.filter(e => e.status === 'candidate').every(e => isMajor(sa, e)), '次要事件都应自动通过');
console.log('自动通过：', sa.ledger.filter(e => e.auto).length, '条；待审重要事件', sa.ledger.filter(e => e.status === 'candidate').length, '条 ✓');

// —— 楼层回滚 ——
const sr = fresh();
advanceTo(sr, '1890-05-20', S, null);
const before = JSON.stringify({ d: sr.currentDate, n: sr.ledger.length, r: sr.receptions.length });
takeSnapshot(sr, 10, '1890-06-30');
const snapIds = new Set(sr.snapshots[0].eventIds);
advanceTo(sr, '1890-06-30', S, null);
const target = sr.ledger.find(e => e.status === 'candidate' && !snapIds.has(e.id) && e.key);
assert(target, '应有快照之后新生成的候选');
{ setStatus(sr, target, 'approved'); target.text = { title: 'T', body: '正文', summary: '' }; }
const manual = { ...sr.ledger[0] }; // 手动事件应保留
sr.ledger.push({ ...manual, id: 'manual1', origin: 'manual', date: '1890-06-10', status: 'approved' });
const rb = rollbackFrom(sr, 9);
assert(rb && rb.removed > 0);
assert.equal(JSON.stringify({ d: sr.currentDate, n: sr.ledger.length - 1, r: sr.receptions.length }), before, '回滚后应回到快照状态（手动事件除外）');
assert(sr.ledger.some(e => e.id === 'manual1'));
const rep = advanceTo(sr, '1890-06-30', S, null);
{
  const again = sr.ledger.find(e => e.key === target.key && e.date === target.date);
  assert(again && again.status === 'approved' && again.text?.body === '正文', '重推后应沿用之前的审核和正文');
  assert(rep.reapplied >= 1);
  console.log('回滚后重推沿用审核：', rep.reapplied, '条');
}
console.log('楼层回滚 ✓');

// —— 手动阅读记录 ——
const sm = fresh();
advanceTo(sm, '1890-06-20', S, null);
const rec = recordManualReading(sm, S, null, { workId: 'wld2', personId: 'gourmont', date: '1890-06-20', read: 'finished', note: '书信' });
assert.equal(rec.origin, 'manual'); assert.equal(rec.read, 'finished');
console.log('手动阅读：', rec.expression, rec.why.slice(-2).join(' / '));
assert.throws(() => recordManualReading(sm, S, null, { workId: 'nope', personId: 'gourmont', date: '1890-06-20' }));
console.log('手动阅读 ✓');


const inj = buildInjection({ ...st }, null, S);
assert(inj.includes('列表之外'));
console.log('\n注入示例（前 600 字）：\n' + inj.slice(0, 600));
const ev = st.ledger.find(e => e.layer === 'review') || st.ledger[0];
const pr = buildWriterPrompt(st, ev, { forbiddenAnachronisms: ['电影', '飞机'] }, S);
assert(pr.system.includes('不得晚于'));
console.log('\n写稿提示词长度', pr.system.length + pr.user.length);
console.log('时代校验：', checkAnachronism({ title: '', body: '他在电影院想起1926年' }, { forbiddenAnachronisms: ['电影院'] }, { date: '1890-06-01', workId: 'wtest' }, st));
console.log('\n全部测试通过');
