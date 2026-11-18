// 回归测试：用已经确认的 1890 年剧情情形，固定“正确结果”。改任何东西都先跑这里。
import assert from 'assert';
import * as E from '../src/engine.js';
import * as B from '../src/bundle.js';
import { addDays, cmp } from '../src/date.js';
import { defaultState, DEFAULT_SETTINGS } from '../src/store.js';
import { buildInjection } from '../src/inject.js';
import { historyOf, normalizeOpinion, quoteInText } from '../src/analysis.js';
import { takeSnapshot, rollbackFrom } from '../src/rollback.js';

const S = { ...DEFAULT_SETTINGS };
const ok = name => console.log('  ✓ ' + name);
console.log('回归测试（1890）');

function base(seed = 'reg') {
    const t = defaultState(); t.seed = seed;
    t.pennames = [{ id: 'ee', name: 'E.E.', owner: '勒鲁', knownBy: ['mir'] }];
    t.outlets = [
        { id: 'echo', name: '巴黎回声报', periodicity: 'daily', circle: 'general', tier: 3, sections: ['review', 'notice', 'echo', 'reader_letters'] },
        { id: 'figaro', name: '费加罗报', periodicity: 'daily', circle: 'general', tier: 5 },
        { id: 'merc', name: '法兰西信使', periodicity: 'monthly', circle: 'literary', tier: 3, monthDays: [1] },
    ];
    t.persons = [
        { id: 'mir', name: '米尔博', roles: ['writer', 'journalist'], outletIds: ['echo'], reads: [], interests: ['社会', '死刑'], likes: ['同情'], dislikes: [], closeness: 3, active: true, real: true, monthlyCapacity: 2 },
        { id: 'gour', name: '古尔蒙', roles: ['critic'], outletIds: ['merc'], reads: ['merc'], interests: ['宗教', '象征'], likes: [], dislikes: [], closeness: 1, active: true, real: true, monthlyCapacity: 2 },
        { id: 'vin', name: '文森特', roles: [], outletIds: [], reads: ['echo'], interests: ['社会', '同情'], likes: ['同情'], dislikes: [], closeness: 2, active: true, real: true },
        { id: 'theo', name: '提奥', roles: [], outletIds: [], reads: [], interests: ['绘画'], likes: [], dislikes: [], closeness: 1, active: true, real: true },
    ];
    t.works = [
        { id: 'aine', title: '长子', pennameId: 'ee', form: 'serial', outletId: 'echo', pubDate: '1890-04-15', endDate: '1890-04-19', themes: ['家庭', '同情', '社会'] },
        { id: 'ld1', title: '生者与死亡 第一册', pennameId: 'ee', form: 'pamphlet', outletId: 'merc', pubDate: '1890-05-01', themes: ['宗教', '死亡'] },
        { id: 'ishb', title: '石田日记 单行本', pennameId: 'ee', form: 'translation_book', outletId: 'echo', pubDate: '1890-06-23', datePrecision: 'noLaterThan', themes: ['日本', '日记'] },
    ];
    t.currentDate = '1890-04-10';
    return t;
}

// 1. 文森特 4 月在圣雷米读作品，不会用到 5 月 20 日才开始的同住关系
{
    let early = 0, late = 0, earlyRead = 0;
    for (let i = 0; i < 40; i++) {
        const t = base('vin' + i);
        t.persons.find(p => p.id === 'vin').relations = [{ to: 'theo', type: 'family', closeness: 3, frequency: 'daily', discloseOpinions: true, since: '1890-05-20' }];
        E.advanceTo(t, '1890-09-01', S, null);
        const rv = t.receptions.find(r => r.personId === 'vin' && r.workId === 'aine' && E.READ_DONE.includes(r.read));
        const told = t.recommends?.aine?.theo;
        if (rv && told && told.by === 'vin') { assert(cmp(told.date, '1890-05-20') >= 0, `谈起日期 ${told.date} 不能早于关系开始`); if (cmp(rv.readDate, '1890-04-20') < 0) early++; else late++; }
        if (rv && cmp(rv.readDate, '1890-04-19') <= 0) earlyRead++;
        if (rv && cmp(rv.readDate, '1890-04-19') <= 0 && told?.by === 'vin') assert.fail('四月中读完，五月二十日才同住，相隔一个多月，不应谈起');
    }
    assert(earlyRead > 0, '样本里要有四月中就读完的');
    ok(`四月中就读完的 ${earlyRead} 次都没有谈起（同住一个多月后才开始）；其余 ${late} 次谈起都不早于 5-20`);
}

// 2. 关系在交谈之前就断了：不谈
{
    for (let i = 0; i < 30; i++) {
        const t = base('until' + i);
        t.persons.find(p => p.id === 'vin').relations = [{ to: 'theo', type: 'family', closeness: 3, frequency: 'monthly', until: '1890-04-17' }];
        E.advanceTo(t, '1890-09-01', S, null);
        const told = t.recommends?.aine?.theo;
        if (told?.by === 'vin') assert(cmp(told.date, '1890-04-17') <= 0, '断了往来之后不会再谈起');
    }
    ok('关系结束之后不会再谈起');
}

// 3. 古尔蒙 5 月评价第一册，不参考他 8 月才形成的看法
{
    const t = base();
    t.receptions = [
        { id: 'r5', personId: 'gour', workId: 'ld1', read: 'finished', readDate: '1890-05-06', opinion: null },
        { id: 'r8', personId: 'gour', workId: 'aine', read: 'finished', readDate: '1890-08-20', opinion: { summary: '八月的看法：作者越写越好' } },
        { id: 'r4', personId: 'gour', workId: 'aine', read: 'finished', readDate: '1890-04-20', opinion: { summary: '四月的看法' } },
    ];
    const h = historyOf(t, 'gour', 'r5', 'ee', '1890-05-06');
    assert.equal(h.length, 1); assert(h[0].includes('四月的看法') && !h.join().includes('八月'));
    ok('生成看法时只给此前已形成的旧看法');
}

// 4. 第三方之间的私信，主角不会立刻知道
{
    const t = base(); t.currentDate = '1890-08-30';
    B.applyBundle(t, B.normalizeBundle({ reactions: [
        { date: '1890-08-26', layer: 'private_letter', person: '米尔博', work: '长子', to: '主角', polarity: 1, summary: '寄给主角的信' },
        { date: '1890-08-27', layer: 'private_letter', person: '米尔博', work: '长子', to: '瓦莱特', polarity: -1, summary: '米尔博写给瓦莱特的信' },
        { date: '1890-08-28', layer: 'private_letter', person: '古尔蒙', work: '长子', to: '瓦莱特', knownAt: '1890-09-05', summary: '古尔蒙写给瓦莱特，九月才传到主角耳朵里' },
    ] }), { settings: S });
    const [toMe, third, later] = t.ledger.slice(-3);
    assert(E.knownToUser(t, toMe)); assert(!E.knownToUser(t, third)); assert(!E.knownToUser(t, later));
    const inj = buildInjection(t, null, S);
    assert(inj.includes('寄给主角的信') && !inj.includes('写给瓦莱特'));
    t.currentDate = '1890-09-06';
    assert(E.knownToUser(t, later), '标了得知日期的，到那天之后才知道');
    ok('第三方私信不注入主对话；标了得知日期的，到期后才算主角知道');
}

// 5. 《石田日记》单行本只知道“不晚于 6 月 23 日”：不把它当真实首发日
{
    const t = base(); const w = t.works.find(x => x.id === 'ishb');
    const eff = E.effectivePubDate(t, w);
    assert(cmp(eff, '1890-06-23') <= 0 && cmp(eff, addDays('1890-06-23', -21)) >= 0, `推算日 ${eff}`);
    E.advanceTo(t, '1890-07-31', S, null);
    const rs = t.receptions.filter(r => r.workId === 'ishb' && r.contactDate);
    assert(rs.every(r => cmp(r.contactDate, eff) >= 0));
    assert(rs.every(r => r.why.some(x => x.includes('首发日期不确定'))));
    ok(`“不晚于 6-23”按 ${eff} 推算，并在“为什么”里写明`);
}

// 6. 只读了开头的人，不能引用后面才有的情节
{
    const src = '开头一段：长子回到家里，父亲沉默不语。'.repeat(150) + '结尾一段：他最终在桥上做了决定。'.repeat(30);
    const head = src.slice(0, 2500);
    const op = normalizeOpinion({ summary: 'x', dimensions: { technique: { score: 1, evidence: [{ quote: '他最终在桥上做了决定' }] }, emotion: { score: 1, evidence: [{ quote: '父亲沉默不语' }] } },
        styleNotes: [{ aspect: '节奏', verdict: '有力', quote: '他最终在桥上做了决定' }] }, null, head);
    assert.equal(op.dimensions.technique, null, '引用读不到的结尾，判为尚未判断');
    assert.equal(op.dimensions.emotion, 1);
    assert.equal(op.styleNotes.length, 0);
    assert(quoteInText('长子回到家里……父亲沉默不语', src)); assert(!quoteInText('长子在战场上阵亡', src));
    ok('引文逐条对原文核验；只读了开头的人，引用结尾的情节会被驳回');
}

// 7. 同一天 14 封、之后累计 82 封：总数是 82，不是 96
{
    const t = base(); t.currentDate = '1890-04-30';
    const old = B.normalizeBundle({ works: [{ title: '长子', pubDate: '1890-04-15' }], reactions: [{ date: '1890-04-17', layer: 'reader_letters', work: '长子', outlet: '巴黎回声报', count: 14 }] });
    const neu = B.normalizeBundle({ works: [{ title: '长子', pubDate: '1890-04-15' }], reactions: [{ date: '1890-04-22', layer: 'reader_letters', work: '长子', outlet: '巴黎回声报', count: 82, summary: '累计' }] });
    B.applyBundle(t, old, { settings: S }); B.applyBundle(t, neu, { settings: S, sync: true });
    const total = t.ledger.filter(e => e.layer === 'reader_letters' && e.status === 'approved').reduce((n, e) => n + (e.count || 0), 0);
    assert.equal(total, 82);
    ok('以新版为准导入时，读者来信累计数不重复相加');
}

// 8. 改写一条历史消息：撤销相应推演，不影响独立确认的事实
{
    const t = base(); t.currentDate = '1890-04-14';
    B.applyBundle(t, B.normalizeBundle({ reactions: [{ date: '1890-04-12', layer: 'notice', person: '古尔蒙', outlet: '法兰西信使', polarity: 1, summary: '已确认的短评' }] }), { settings: S });
    takeSnapshot(t, 10, '1890-05-20');
    E.advanceTo(t, '1890-05-20', S, null);
    assert(t.receptions.length > 0);
    rollbackFrom(t, 10);
    assert.equal(t.currentDate, '1890-04-14'); assert.equal(t.receptions.filter(r => r.origin !== 'manual').length, 0);
    assert(t.ledger.some(e => e.text?.summary === '已确认的短评' && e.status === 'approved'));
    ok('回滚撤掉推演，手动和导入的已确认事实保留');
}

// 9. 时间旅行测试：按日推演 = 每 14 天推演 = 分段回溯；任何时刻都没人提前知道未来
{
    const sig = t => t.receptions.filter(r => r.read && r.read !== 'none').map(r => [r.personId, r.workId, r.channel, r.read, r.readDate, r.polarity].join('|')).sort().join('\n');
    const run = step => {
        const t = base('tt'); t.currentDate = '1890-04-01';
        let d = '1890-04-01';
        while (cmp(d, '1890-09-01') < 0) {
            d = addDays(d, step); if (cmp(d, '1890-09-01') > 0) d = '1890-09-01';
            E.advanceTo(t, d, { ...S, autoApprove: 'none' }, null);
            // 没有人提前知道未来：已入账/候选的都不晚于今天，主角已知的都不晚于今天
            for (const e of t.ledger) if (e.status !== 'scheduled') assert(cmp(e.date, d) <= 0, `${e.date} 的事件在 ${d} 就出现了`);
            for (const e of t.ledger) if (E.knownToUser(t, e)) assert(cmp(e.date, d) <= 0);
        }
        return t;
    };
    const daily = run(1), fort = run(14);
    assert.equal(sig(daily), sig(fort), '按日推演与每 14 天推演结果应一致');
    const bf = base('tt'); bf.currentDate = '1890-09-01';
    const b = E.backfillBegin(bf, { ...S, autoApprove: 'none' }, null, { mode: 'all' });
    for (const d of ['1890-05-01', '1890-06-15', '1890-08-01', b.to]) E.backfillStep(bf, { ...S, autoApprove: 'none' }, null, d);
    E.backfillEnd(bf);
    const n = sig(daily).split('\n').length;
    const same = sig(bf).split('\n').filter(x => sig(daily).includes(x)).length;
    assert(same / n >= 0.9, `分段回溯与逐日推演的阅读记录应基本一致（${same}/${n}）`);
    ok(`逐日、每 14 天推演结果完全一致；分段回溯一致 ${same}/${n}；任何时刻都没有未来的事件提前出现`);
}

// 10. 不定期刊物：没有已知刊期的，评论要你确认、不自动入账；有已知刊期的只落在那几天
{
    const t = base('irr');
    t.outlets.push({ id: 'irr', name: '某不定期刊', periodicity: 'irregular', circle: 'literary', tier: 2 });
    t.persons.find(p => p.id === 'gour').outletIds = ['irr'];
    let flagged = 0, auto = 0;
    for (let i = 0; i < 30; i++) {
        const u = JSON.parse(JSON.stringify(t)); u.seed = 'irr' + i;
        E.advanceTo(u, '1890-09-01', S, null);
        for (const e of u.ledger.filter(e => e.outletId === 'irr')) { if (e.flags?.some(f => f.startsWith('不定期刊物'))) flagged++; if (e.auto) auto++; }
    }
    assert(auto === 0, '不定期刊物上的评论不自动入账');
    const slots = E.columnSlots({ periodicity: 'irregular', issueDates: ['1890-05-03', '1890-06-14'] }, '1890-05-01', '1890-06-30');
    assert.deepEqual(slots, ['1890-05-03', '1890-06-14']);
    ok(`不定期刊物：无刊期时 ${flagged} 条都标了“请核对”、无一自动入账；有刊期时只落在已知日期`);
}

// 11. 只有署名反响、没有阅读记录：记为“读过，程度不详”，不推断读完
{
    const t = base(); t.currentDate = '1890-05-10';
    B.applyBundle(t, B.normalizeBundle({ reactions: [{ date: '1890-05-05', layer: 'notice', person: '古尔蒙', outlet: '法兰西信使', work: '生者与死亡 第一册', polarity: 0 }] }), { settings: S });
    const r = t.receptions.find(x => x.personId === 'gour' && x.workId === 'ld1');
    assert.equal(r.read, 'unknown');
    ok('由署名反响补的阅读记录是“读过，程度不详”');
}

// 12. 没填常读刊物的人，不会被当成订阅了所有大报
{
    let reader = 0, browse = 0;
    for (let i = 0; i < 60; i++) {
        const t = base('br' + i);
        t.works.push({ id: 'fig', title: '费加罗上的文章', pennameId: 'ee', form: 'article', outletId: 'figaro', pubDate: '1890-05-10', themes: ['绘画'] });
        E.advanceTo(t, '1890-06-30', S, null);
        const r = t.receptions.find(x => x.personId === 'theo' && x.workId === 'fig');
        if (r?.channel === 'reader') reader++;
        if (r?.channel === 'browse') browse++;
    }
    assert.equal(reader, 0); assert(browse > 3 && browse < 40, `偶尔翻到 ${browse}/60`);
    ok(`没填常读刊物：不算“常读”，只按“偶尔翻到大报”接触（${browse}/60）`);
}
// 13. 主角的私人信息：只有登记的知情者、在知情日之后才知道；生成看法、写稿只给知情者
{
    const P = await import('../src/perception.js');
    const { buildWriterPrompt } = await import('../src/writer.js');
    const { generateOpinion } = await import('../src/analysis.js');
    const t = base('pf'); t.currentDate = '1890-09-01';
    t.pennames[0].knownBy = ['mir', 'gour'];
    t.privateFacts = [{ id: 'f1', topic: '语言与母语', text: '法语不是勒鲁的母语，他对自己的法语文章没有信心', knownBy: [{ personId: 'gour', since: '1890-05-10', via: 'told', believes: true }] }];
    assert.equal(P.factsKnownBy(t, 'mir', '1890-09-01').length, 0, '米尔博没登记，不知道');
    assert.equal(P.factsKnownBy(t, 'gour', '1890-05-01').length, 0, '知情日之前不知道');
    assert.equal(P.factsKnownBy(t, 'gour', '1890-06-01').length, 1);
    // 写稿：公开文章不得写出私事；不知情的人什么都不知道
    t.ledger.push({ id: 'pv1', origin: 'manual', date: '1890-08-20', layer: 'notice', personId: 'gour', outletId: 'merc', workId: 'ld1', pennameId: 'ee', polarity: 1, status: 'approved', flags: [] });
    t.ledger.push({ id: 'pv2', origin: 'manual', date: '1890-08-20', layer: 'notice', personId: 'mir', outletId: 'echo', workId: 'aine', pennameId: 'ee', polarity: 1, status: 'approved', flags: [] });
    const wg = buildWriterPrompt(t, t.ledger.find(e => e.id === 'pv1'), null, S).user;
    const wm = buildWriterPrompt(t, t.ledger.find(e => e.id === 'pv2'), null, S).user;
    assert(wg.includes('母语') && wg.includes('绝不能写出来')); assert(!wm.includes('母语不是') && wm.includes('不知道主角的任何私人情况'));
    // 生成看法：提示词里只有知情者的私事；“确知”的认知对不上他知道的事 → 降为推测
    let seen = '';
    globalThis.SillyTavern = { getContext: () => ({ generateRaw: async a => { seen = a.prompt; return JSON.stringify({ summary: '还行', dimensions: {}, beliefsAboutAuthor: [
        { topic: '身份与背景', belief: '作者是在中国长大的', kind: 'fact', confidence: 0.9 },
        { topic: '文风与语言', belief: '法语不是他的母语，所以句子很直接', kind: 'self_report', confidence: 0.7 },
        { topic: '公开回应与论战', belief: '他似乎不喜欢公开论战', kind: 'inference', confidence: 0.5 }] }); } }) };
    const rm = { id: 'rm', personId: 'mir', workId: 'aine', read: 'finished', readDate: '1890-08-01', polarity: 1, strength: 'mild' };
    const rg = { id: 'rg', personId: 'gour', workId: 'ld1', read: 'finished', readDate: '1890-08-01', polarity: 1, strength: 'mild' };
    t.receptions.push(rm, rg);
    await generateOpinion(t, rm, null, { apiMode: 'st' });
    assert(!seen.includes('母语不是') && seen.includes('不知道勒鲁的任何私人情况'), '不知情者的提示词里没有私事');
    const pm = t.perceptions.filter(p => p.recId === 'rm');
    assert(pm.every(p => p.kind === 'inference' || p.kind === 'rumor' || p.kind === 'misread'), '不知情者的认知不能是“确知/本人说的”');
    await generateOpinion(t, rg, null, { apiMode: 'st' });
    assert(seen.includes('法语不是勒鲁的母语'));
    const pg = t.perceptions.filter(p => p.recId === 'rg');
    assert.equal(pg.find(p => p.belief.includes('中国')).kind, 'inference', '编出来的“确知”降为推测');
    assert.equal(pg.find(p => p.belief.includes('母语')).kind, 'self_report', '对得上知情内容的保留');
    // 回滚撤掉阅读记录时，相应的认知一起撤
    t.receptions = t.receptions.filter(r => r.id !== 'rm');
    takeSnapshot(t, 99, '1890-09-02'); rollbackFrom(t, 99);
    assert(!t.perceptions.some(p => p.recId === 'rm'));
    delete globalThis.SillyTavern;
    ok('私人信息只给知情者（含知情日）；公开文章不写私事；“确知”的认知必须对得上他真知道的事');
}

// 14. 私事外传只出候选；“绝不外传”的不出
{
    let n = 0, strict = 0;
    for (let i = 0; i < 40; i++) {
        const t = base('fl' + i);
        t.persons.find(p => p.id === 'vin').relations = [{ to: 'theo', type: 'family', closeness: 3, frequency: 'daily', trust: 0.9, discloseIdentity: true }];
        t.privateFacts = [{ id: 'a', text: '甲事', knownBy: [{ personId: 'vin', since: '1890-01-01' }] }, { id: 'b', text: '乙事', secret: 'strict', knownBy: [{ personId: 'vin', since: '1890-01-01' }] }];
        E.advanceTo(t, '1890-09-01', S, null);
        n += (t.factLeaks || []).filter(l => l.factId === 'a').length; strict += (t.factLeaks || []).filter(l => l.factId === 'b').length;
        assert(!t.privateFacts[0].knownBy.some(k => k.personId === 'theo'), '候选不会自动生效');
    }
    assert(n > 0 && strict === 0);
    ok(`私事外传只出候选（${n} 次），不自动生效；“绝不外传”的不出`);
}
// 15. 认知对照：程序只标能确定的出入；“截至某天”只看那天之前的
{
    const I = await import('../src/image.js');
    const t = base('pc'); t.currentDate = '1890-09-01';
    t.privateFacts = [{ id: 'f1', topic: '语言与母语', text: '法语不是母语', knownBy: [{ personId: 'gour', since: '1890-05-10' }] }];
    t.perceptions = [
        { id: 'b1', observerId: 'mir', target: 'pen:ee', topic: '思想倾向', belief: '他同情穷人但不信革命', kind: 'inference', formedAt: '1890-05-01' },
        { id: 'b2', observerId: 'mir', target: 'pen:ee', topic: '身份与背景', belief: '作者是比利时人', kind: 'misread', formedAt: '1890-08-01' },
        { id: 'b3', observerId: 'gour', target: 'pen:ee', topic: '文风与语言', belief: '句子短而直', kind: 'inference', formedAt: '1890-06-01' },
    ];
    t.selfImage = [{ id: 's1', mode: 'self', topic: '思想倾向', text: '我不想说教', since: '' }];
    t.assumed = [
        { id: 'a1', personId: 'mir', topic: '思想倾向', belief: '米尔博觉得我太说教', since: '' },
        { id: 'a2', personId: 'gour', topic: '文风与语言', belief: '句子短而直，很干净', since: '' },
        { id: 'a3', personId: 'theo', topic: '能力与潜力', belief: '提奥觉得我有天分', since: '' },
    ];
    const m = I.perceptionMatrix(t, { penId: 'ee' });
    const row = k => m.rows.find(r => r.topic === k);
    assert(row('身份与背景').flags.some(f => f.type === 'misread'));
    assert(row('思想倾向').flags.some(f => f.type === 'assumed_diff'), '你以为的和实际字面对不上');
    assert(!row('文风与语言').flags.length, '对得上的不标');
    assert(row('能力与潜力').flags.some(f => f.type === 'assumed_none'), '对方没形成看法');
    assert(row('文风与语言').facts.length === 1, '母语的私事归到“文风与语言”');
    const early = I.perceptionMatrix(t, { penId: 'ee', asOf: '1890-07-01' });
    assert(!early.rows.find(r => r.topic === '身份与背景')?.persons.length, '7 月还没有 8 月的误解');
    ok('认知对照：误解、你以为的对不上、对方没形成看法都会标出；截至日期之前的才算');
}

// 16. 公众形象只看公开材料；没有依据的不收；材料少不能说“普遍”
{
    const I = await import('../src/image.js');
    const t = base('pi'); t.currentDate = '1890-09-01';
    t.privateFacts = [{ id: 'f1', topic: '语言与母语', text: '秘密：法语不是母语', knownBy: [{ personId: 'mir', since: '1890-05-01' }] }];
    t.ledger.push(
        { id: 'p1', origin: 'manual', date: '1890-05-02', layer: 'review', personId: 'gour', outletId: 'merc', workId: 'ld1', pennameId: 'ee', polarity: 1, status: 'approved', flags: [], text: { summary: '古尔蒙赞其宗教感' } },
        { id: 'p2', origin: 'manual', date: '1890-05-03', layer: 'private_letter', personId: 'mir', workId: 'aine', pennameId: 'ee', polarity: 1, status: 'approved', flags: [], text: { summary: '私信：米尔博说秘密内容' } },
        { id: 'p3', origin: 'manual', date: '1890-10-03', layer: 'review', personId: 'gour', outletId: 'merc', workId: 'ld1', pennameId: 'ee', polarity: -1, status: 'approved', flags: [], text: { summary: '未来的书评' } });
    t.selfImage = [{ id: 'c1', mode: 'claim', topic: '创作动机', text: '我写作是为了让人看见长子的处境', since: '1890-06-01' }, { id: 's1', mode: 'self', topic: '其他', text: '自认的心里话', since: '' }];
    const pr = I.buildImagePrompt(t, { penId: 'ee', circle: 'literary', asOf: '1890-09-01', era: null });
    assert(pr.user.includes('宗教感') && !pr.user.includes('私信') && !pr.user.includes('秘密') && !pr.user.includes('未来的书评') && !pr.user.includes('心里话'));
    assert(pr.user.includes('让人看见长子'), '作者的公开说法算公开材料');
    const n = I.normalizeImage({ items: [
        { topic: '思想倾向', belief: '有宗教感', spread: 'wide', basis: ['E1'] },
        { topic: '其他', belief: '没有依据的说法', spread: 'wide', basis: [] },
        { topic: '其他', belief: '编号不存在', basis: ['E9'] }] }, pr.refs);
    assert.equal(n.items.length, 1); assert.equal(n.items[0].spread, 'some', '一篇文章不能说“普遍”');
    // 生成后回滚撤掉
    takeSnapshot(t, 10, '1890-09-01');
    globalThis.SillyTavern = { getContext: () => ({ generateRaw: async () => JSON.stringify({ summary: 's', items: [{ topic: '思想倾向', belief: '有宗教感', basis: ['E1'] }] }) }) };
    const img = await I.generatePublicImage(t, { penId: 'ee', circle: 'literary', asOf: '1890-09-01', settings: { apiMode: 'st' } });
    assert(img.items.length === 1 && I.latestImage(t, 'ee', 'literary', '1890-09-01'));
    assert(!I.latestImage(t, 'ee', 'literary', '1890-08-01'), '更早的日期看不到之后整理的');
    const { penEntry } = await import('../src/lore.js');
    const pe = penEntry(t, t.pennames[0]);
    assert(pe.content.includes('有宗教感') && pe.content.includes('让人看见长子') && !pe.content.includes('心里话'), '世界书：公众形象与公开说法');
    rollbackFrom(t, 10);
    assert(!(t.publicImages || []).length, '回滚撤掉之后整理的公众形象');
    delete globalThis.SillyTavern;
    ok('公众形象只依据公开材料（不含私信、私事、未来的文章、主角心里话）；没有依据的不收；回滚一起撤');
}

// 17. 作者的公开说法：之后读到的人可以“本人说的”；之前不行；手记也一样核对
{
    const I = await import('../src/image.js');
    const P = await import('../src/perception.js');
    const t = base('cl'); t.currentDate = '1890-09-01';
    t.selfImage = [{ id: 'c1', mode: 'claim', topic: '创作动机', text: '我写作是为了让人看见长子的处境', since: '1890-06-01', pennameId: 'ee' }];
    const b = [{ topic: '创作动机', belief: '作者说他是为了让人看见长子的处境', kind: 'self_report' }];
    const after = P.storePerceptions(t, { rec: { id: 'r1', workId: 'aine' }, person: t.persons[0], target: 'pen:ee', beliefs: b, date: '1890-07-01' });
    const before = P.storePerceptions(t, { rec: { id: 'r2', workId: 'aine' }, person: t.persons[0], target: 'pen:ee', beliefs: b, date: '1890-05-01' });
    assert.equal(after[0].kind, 'self_report'); assert.equal(before[0].kind, 'inference');
    const f = P.storePerceptions(t, { rec: { id: 'r3', workId: 'aine' }, person: t.persons[0], target: 'pen:ee', beliefs: [{ ...b[0], kind: 'fact' }], date: '1890-07-01' });
    assert.equal(f[0].kind, 'self_report', '只有公开说法支持的“确知”降为“本人说的”');
    const mp = I.manualPerception(t, { personId: 'theo', topic: '身份与背景', belief: '他是外国人', kind: 'fact', date: '1890-08-01', pennameId: 'ee' });
    assert.equal(mp.kind, 'inference');
    ok('作者公开说过的话：之后可以算“本人说的”，之前不行；“确知”降级；手记同样核对');
}

// 18. 整理包：自我认知、主角以为、别人的看法
{
    const t = base('bd'); t.currentDate = '1890-09-01';
    const b = B.normalizeBundle({ selfImage: [{ mode: 'claim', topic: '创作动机', text: '为长子说话', since: '1890-06-01', penname: 'E.E.' }],
        assumed: [{ person: '米尔博', topic: '思想倾向', belief: '觉得我说教' }, { circle: '评论界', belief: '评论界看不起我' }, { person: '不存在', belief: 'x' }],
        perceptions: [{ person: '古尔蒙', topic: '身份与背景', belief: '作者是女人', kind: 'fact', date: '1890-08-01' }] });
    const rep = B.applyBundle(t, b, {});
    assert.equal(t.selfImage[0].pennameId, 'ee');
    assert.equal(t.assumed.length, 2); assert.equal(t.assumed[1].circle, 'critics');
    assert.equal(t.perceptions[0].kind, 'inference', '整理包里的“确知”也要核对'); assert.equal(t.perceptions[0].origin, 'bundle');
    assert(rep.skipped.some(x => x.includes('不存在')));
    ok('整理包导入自我认知、主角以为（人物或圈子）、别人的看法（同样核对来源）');
}
console.log('回归测试全部通过');
