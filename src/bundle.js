// bundle.js — “整理包”：一份把整个模拟现状装进去的 JSON，可以一键导入。
//
// 两种来源：
//  1. 插件里一键整理：把聊天记录、书信、设定、txt 交给已连接的模型，按块抽取后合并；
//  2. 在外部用聊天式 AI（长上下文更合适）照着“复制提示词”整理，然后把结果贴回来 / 上传。
// 导入前先给出预览（新建多少、更新多少、哪些有问题），确认后才写进数据。
// 整理包里引用别的东西一律用名字，不用 id；名字对不上时会自动新建或给出提示。

import { normalizeISO, cmp } from './date.js';
import { extractJSON, uid } from './util.js';
import { callLLM } from './llm.js';
import { clog } from './console.js';
import { FORMS, PERIODICITY, CIRCLES, LAYERS, ROLES, REL_TYPES, REL_FREQ, setStatus, matchSeenFromChat, recordManualReading, recomputeReputation, normSide, normStrength } from './engine.js';

// 以对象为元素的列表按关键字段合并：同一议题/同一文体项目，新的覆盖旧的
const KEYED = { stances: 'issue', stylePrefs: 'aspect', claims: 'issue' };
const keyNorm = v => String(v ?? '').replace(/[\s　“”"「」《》]/g, '').toLowerCase();
export function mergeKeyed(a, b, key) {
    const m = new Map((a || []).map(x => [keyNorm(x?.[key]), x]));
    for (const x of b || []) if (x?.[key]) m.set(keyNorm(x[key]), { ...(m.get(keyNorm(x[key])) || {}), ...Object.fromEntries(Object.entries(x).filter(([, v]) => v !== '' && v != null)) });
    return [...m.values()];
}
import { findByName, blankOutlet, blankPerson, blankWork, blankPenname } from './data.js';
import { PERC_TOPICS, PERC_KIND } from './perception.js';
import { manualPerception } from './image.js';

export const FORMAT_ID = 'press-echo-import';

// ———————————— 格式说明（同时用于外部提示词和内部抽取） ————————————

const enumLine = obj => Object.entries(obj).map(([k, v]) => `${k}=${typeof v === 'string' ? v : v.label}`).join('，');

export const FORMAT_SPEC = `{
  "format": "${FORMAT_ID}",
  "version": 1,
  "storyDate": "故事当前日期 YYYY-MM-DD（聊天记录里最后的日期）",
  "place": "故事地点，如 法国·巴黎",
  "pennames": [{ "name": "笔名", "owner": "真实作者", "publicIdentityKnown": false, "knownBy": ["知道这个笔名是谁的人"] }],
  "outlets": [{ "name": "刊物名（用中文常用译名，全文统一）", "originalName": "原文名", "periodicity": "daily", "weekday": null, "monthDays": [], "circle": "general", "tier": 3, "politics": ["政治/宗教倾向"], "real": true, "note": "" }],
  "persons": [{ "name": "姓名（全文统一用一个写法）", "aliases": ["别名"], "roles": ["critic"], "outlets": ["供稿的刊物名"], "reads": ["常读的刊物名"], "interests": ["关注题材"], "likes": ["欣赏"], "dislikes": ["反感"], "closeness": 0, "knowsIdentity": false, "real": true, "monthlyCapacity": 2, "columnWeekday": null, "notes": "与主角的关系、往来",
      "stances": [{ "issue": "议题（短名词，如 死刑）", "side": "con", "strength": 3, "note": "具体立场", "source": "依据" }],
      "stylePrefs": [{ "aspect": "文体项目（如 解释密度）", "leaning": "倾向一句话", "tolerance": 2, "source": "依据" }],
      "relations": [{ "to": "另一个人物的名字", "type": "friend", "closeness": 2, "frequency": "weekly", "trust": 0.6, "discloseOpinions": true, "discloseIdentity": false, "since": "这段关系从何时开始（可空）", "until": "何时断了往来（可空）" }] }],
  "works": [{ "title": "作品名", "aliases": ["外文名、别名"], "penname": "署名", "form": "serial", "outlet": "首发刊物名", "pubDate": "首次发表 YYYY-MM-DD", "endDate": "连载结束 YYYY-MM-DD 或空", "themes": ["题材标签"], "summary": "内容摘要 80 字内", "versionOf": "若是另一部作品的单行本/再版，写那部作品的名字", "datePrecision": "day", "dateFrom": "只知道“不晚于”时，最早可能的日期（可空）", "shelf": "", "shelfUntil": "",
      "claims": [{ "issue": "议题（与人物 stances 用同一个词）", "side": "mixed", "note": "作品具体怎么说", "where": "出处" }] }],
  "reactions": [{ "date": "YYYY-MM-DD", "layer": "review", "person": "谁（读者来信、剪报可空）", "outlet": "登在哪（私信可空）", "to": "私信的收信人：寄给主角的留空或写“主角”，别人之间的信写收信人", "knownAt": "主角哪天得知这封别人之间的信（不知道就空）", "work": "针对哪部作品", "polarity": 1, "count": null, "title": "文章标题（若有）", "summary": "内容概要", "evidence": "依据：聊天里的原话或位置，40 字内", "datePrecision": "day" }],
  "readings": [{ "date": "YYYY-MM-DD", "person": "谁", "work": "哪部作品", "read": "finished", "note": "依据" }],
  "rumors": [{ "text": "坊间传闻", "strength": 0.5 }],
  "privateFacts": [{ "text": "主角的私人情况或某部作品的创作意图，如：法语不是他的母语", "topic": "语言与母语", "work": "针对哪部作品（创作意图时填，否则空）", "knownBy": [{ "person": "知情者", "since": "哪天起知道", "via": "told", "believes": true }], "public": false }],
  "selfImage": [{ "mode": "self", "topic": "文风与语言", "text": "主角怎么看自己（self），或在文章、序言、访谈里公开说过的话（claim）", "since": "哪天起", "penname": "针对哪个署名（可空）" }],
  "assumed": [{ "person": "主角以为谁（人物名；针对整个读者圈子时改填 circle）", "circle": "", "topic": "思想倾向", "belief": "主角以为对方觉得……", "since": "哪天起" }],
  "perceptions": [{ "person": "谁", "topic": "身份与背景", "belief": "此人对作者的一种看法（聊天里明确说出或写出的）", "kind": "inference", "date": "哪天表露的", "penname": "针对哪个署名（可空）", "evidence": "依据：原话或位置，40 字内" }],
  "eraNotes": [{ "title": "标题", "text": "与时代背景有关、后续写作要遵守的事实" }]
}`;

export const FORMAT_RULES = `字段取值：
- periodicity（出刊周期）：${enumLine(PERIODICITY)}
- weekday / columnWeekday（星期）：0=星期日，1=星期一 … 6=星期六；不知道就填 null
- monthDays：月刊/半月刊的出刊日，如 [1] 或 [1,15]
- circle（读者圈子）：${enumLine(CIRCLES)}
- tier（影响力）：1–5，5 最大
- roles（公开身份，可多选）：${enumLine(ROLES)}；只是朋友、从不公开写评论的人填 []
- closeness（与主角私交）：0 陌生，1 认识，2 朋友，3 至交
- relations（此人与其他人物的关系，有方向：写在 A 下面的是“A 对 B”）：type=${enumLine(REL_TYPES)}；closeness 同上 0–3；frequency=${enumLine(REL_FREQ)}；trust 0–1（A 对 B 的信任）；discloseOpinions：A 会不会跟 B 谈起读过的东西；discloseIdentity：A 如果知道某个笔名背后是谁，会不会告诉 B（多数人会替作者保密，默认 false）；since / until：关系只在这段时间内有效，例如某人哪天搬来同住、哪天才认识（不知道就留空）。只写聊天里看得出来的关系，to 必须是 persons 里的名字
- stances（人物在具体议题上的立场）：side=pro 支持 / con 反对 / mixed 有保留；strength=1 低 / 2 中 / 3 高（对他有多重要）；source 写依据（史实/某日书信/推测）。只写有依据的；推测的 strength 不要给 3
- stylePrefs（人物读作品时在意的写法，是倾向不是规则）：aspect 如 词汇选择、句子节奏、解释密度、修辞密度、叙述距离、情绪强度、论证重复度；leaning 一句话；tolerance=1 难以容忍 / 2 视情况 / 3 宽容。不要用他自己的文风反推
- claims（作品在议题上的主张）：side 同上，“大体反对但保留例外”填 mixed；issue 尽量与人物 stances 用同一个词，才能对照出赞同或分歧
- shelf（作品发表后是否长期流通、一直有人找来读）：yes / no / 留空按形式（成书、单行本、小册子算流通）；shelfUntil：售罄或绝版日期（不知道就空）
- privateFacts（主角的私人信息与知情者）：只记聊天里明确出现的。knownBy 只写确实听过的人（亲口告诉 told / 书信 letter / 听人转述 heard / 亲眼所见 saw / 自己推断 inferred），不要因为两人相熟就推定对方也知道。topic 取：语言与母语、国籍与出身、成长经历、知识背景、创作意图、身份与笔名、健康与生活、其他
- selfImage（主角的自我认知）：mode=self 只是主角心里怎么看自己，谁都不知道；mode=claim 是公开说过的话（文章、序言、访谈），从 since 起读者都可能知道。topic 取：${PERC_TOPICS.join('、')}
- assumed（主角以为别人怎么看他）：只记主角明确表露过的猜想（心理描写、对别人说的话），person 和 circle 二选一，circle 取值同上面的读者圈子
- perceptions（别人对作者的看法）：只记聊天里此人明确说出或写出的判断，不要从态度推断。kind：fact 确知（他确实被告知过）/ self_report 作者本人说的 / inference 自己推测 / rumor 听来的传闻 / misread 明显误解；拿不准就填 inference。topic 同 selfImage
- knowsIdentity：此人是否知道主角就是这个笔名的作者
- real：是否真实历史人物 / 真实存在的刊物
- form（作品形式）：${enumLine(FORMS)}
- layer（反响类型）：${enumLine(LAYERS)}
- polarity（褒贬）：1 肯定，0 褒贬参半，-1 批评
- count：读者来信封数、剪报条数（其他类型填 null）
- read：finished=读完，skimmed=读了一部分，unknown=读过但不知道读了多少
- 私信 to / knownAt：主角只知道寄给他本人的信；别人之间的信，只有写明主角哪天得知（knownAt），之后才算主角知道
- outlets.issueDates：不定期刊物已知的出刊日期（YYYY-MM-DD 列表），不知道就空
规则：
1. 只记录聊天里明确发生过、明确写出的事，不推测、不补全常识；拿不准的字段留空或省略。
2. reactions 只收“已经发生”的：已见报的书评/短评/八卦/论战、已寄到的私信、读者来信、剪报。计划中、传言中的不算，可以写进 rumors。
3. readings 收“某人已经读过某作品”但没有形成书面反响的情况（例如见面时谈起、信里说读过）。
4. 同一个人、刊物、作品全文只用一个名字；外文名放进 aliases / originalName。
5. 日期一律 YYYY-MM-DD。日期不精确时照样填一个代表日，同时填 datePrecision：day=精确到日，xun=只知道上/中/下旬（填该旬第一天），month=只知道月份（填该月 1 日），noLaterThan=只知道“不晚于”这一天（例如单行本至某日已售罄）。
6. 只输出一个 JSON 对象，不要任何解释文字。`;

/** 给外部聊天式 AI 用的完整提示词 */
export function buildExternalPrompt(state) {
    const known = knownNames(state);
    return `请把我接下来提供的角色扮演聊天记录（以及书信、设定）整理成一份 JSON“整理包”，供 SillyTavern 插件“报刊回声”导入。故事是历史背景，主角以笔名发表作品，插件会据此推演报刊和文坛的反响。

格式如下：
${FORMAT_SPEC}

${FORMAT_RULES}
${known ? `\n插件里已经有这些名字，指同一对象时请沿用完全相同的写法：\n${known}\n` : ''}
如果内容很长，可以分几次输出，每次都是完整、合法的 JSON；我会依次导入，插件会按名字合并。
准备好了就回复“请发送聊天记录”。`;
}

function knownNames(state) {
    const L = [];
    if (state.pennames?.length) L.push(`笔名：${state.pennames.map(p => p.name).join('、')}`);
    if (state.outlets?.length) L.push(`刊物：${state.outlets.map(o => o.name).join('、')}`);
    if (state.persons?.length) L.push(`人物：${state.persons.map(p => p.name).join('、')}`);
    if (state.works?.length) L.push(`作品：${state.works.map(w => w.title).join('、')}`);
    return L.join('\n');
}

// ———————————— 规整：容忍外部 AI 的各种写法 ————————————

const arr = v => (Array.isArray(v) ? v : v == null || v === '' ? [] : typeof v === 'string' ? v.split(/[，,、;；]\s*/).filter(Boolean) : [v]);
const str = v => (v == null ? '' : String(v).trim());
/** 书名、刊名去掉外层书名号：“《巴黎回声报》”→“巴黎回声报”；“《生者与死亡》第一册”保持原样 */
const bare = v => { const s = str(v); const m = s.match(/^《([^《》]+)》$/); return m ? m[1].trim() : s; };
const num = (v, d = null) => (v === '' || v == null || isNaN(Number(v)) ? d : Number(v));

/** 把中文标签或英文键都映射成键 */
function enumKey(dict, v, fallback) {
    const s = str(v);
    if (!s) return fallback;
    if (dict[s]) return s;
    const low = s.toLowerCase();
    for (const [k, lab] of Object.entries(dict)) {
        const l = typeof lab === 'string' ? lab : lab.label;
        if (k.toLowerCase() === low || l === s || l.split(/[\/（(]/)[0] === s || s.includes(l.split(/[\/（(]/)[0])) return k;
    }
    return fallback;
}
const WEEK = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
function weekdayOf(v) {
    if (v == null || v === '') return null;
    if (Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 7) return Number(v) % 7;
    const m = String(v).match(/[周星期礼拜]+([日天一二三四五六])/);
    return m ? WEEK[m[1]] : null;
}
const date = v => normalizeISO(str(v)) || '';

const PREC = { day: '精确到日', xun: '只知道旬', month: '只知道月份', noLaterThan: '不晚于' };
export const DATE_PRECISION = PREC;
function precKey(v) {
    const t = str(v);
    if (!t || t === 'day') return '';
    if (PREC[t]) return t;
    if (/旬/.test(t)) return 'xun';
    if (/月/.test(t)) return 'month';
    if (/不晚|最晚|no.?later/i.test(t)) return 'noLaterThan';
    return '';
}

function freqKey(v) {
    const t = str(v);
    if (REL_FREQ[t]) return t;
    if (/天|日常|同住|同居|daily/i.test(t)) return 'daily';
    if (/周|常|频繁|weekly|often/i.test(t)) return 'weekly';
    if (/月|monthly/i.test(t)) return 'monthly';
    if (/偶|少|rare|seldom/i.test(t)) return 'rare';
    return 'monthly';
}

export function normalizeBundle(obj) {
    const b = obj?.[FORMAT_ID] || obj?.bundle || obj || {};
    const warn = [];
    const out = {
        format: FORMAT_ID,
        storyDate: date(b.storyDate || b.currentDate),
        place: str(b.place),
        pennames: arr(b.pennames).map(p => (typeof p === 'string' ? { name: p } : p)).filter(p => str(p.name)).map(p => ({
            name: str(p.name), owner: str(p.owner), publicIdentityKnown: !!p.publicIdentityKnown, knownBy: arr(p.knownBy).map(str),
        })),
        outlets: arr(b.outlets).map(o => (typeof o === 'string' ? { name: o } : o)).filter(o => bare(o.name)).map(o => ({
            name: bare(o.name), originalName: str(o.originalName),
            periodicity: enumKey(PERIODICITY, o.periodicity || o.type, ''),
            weekday: weekdayOf(o.weekday),
            monthDays: arr(o.monthDays).map(Number).filter(n => n >= 1 && n <= 31),
            circle: enumKey(CIRCLES, o.circle, ''),
            tier: num(o.tier), politics: arr(o.politics).map(str), real: o.real !== false, note: str(o.note),
            issueDates: arr(o.issueDates).map(date).filter(Boolean),
        })),
        persons: arr(b.persons).map(p => (typeof p === 'string' ? { name: p } : p)).filter(p => str(p.name)).map(p => ({
            name: str(p.name), aliases: arr(p.aliases).map(str),
            roles: arr(p.roles).map(r => enumKey(ROLES, r, '')).filter(Boolean),
            outlets: arr(p.outlets || p.outletNames).map(bare).filter(Boolean), reads: arr(p.reads).map(bare).filter(Boolean),
            interests: arr(p.interests).map(str), likes: arr(p.likes).map(str), dislikes: arr(p.dislikes).map(str),
            closeness: p.closeness == null ? null : Math.max(0, Math.min(3, num(p.closeness, 0))),
            knowsIdentity: p.knowsIdentity == null ? null : !!p.knowsIdentity,
            real: p.real == null ? null : !!p.real,
            monthlyCapacity: num(p.monthlyCapacity), columnWeekday: weekdayOf(p.columnWeekday), notes: str(p.notes),
            rolesGiven: p.roles !== undefined,
            relations: arr(p.relations).filter(r => r && str(r.to || r.person || r.name)).map(r => ({
                to: str(r.to || r.person || r.name), type: enumKey(REL_TYPES, r.type, 'friend'),
                closeness: Math.max(0, Math.min(3, num(r.closeness, 1))), frequency: freqKey(r.frequency),
                trust: typeof r.trust === 'string' && /[低中高]/.test(r.trust) ? { 低: 0.3, 中: 0.6, 高: 0.9 }[r.trust.match(/[低中高]/)[0]] : Math.max(0, Math.min(1, num(r.trust, 0.6))),
                discloseOpinions: r.discloseOpinions !== false, discloseIdentity: !!r.discloseIdentity,
                since: date(r.since), until: date(r.until),
            })),
            stances: arr(p.stances).filter(x => x && str(x.issue)).map(x => ({ issue: str(x.issue), side: normSide(x.side), strength: x.strength == null || x.strength === '' ? null : normStrength(x.strength), note: str(x.note), source: str(x.source) })),
            stylePrefs: arr(p.stylePrefs).filter(x => x && str(x.aspect)).map(x => ({ aspect: str(x.aspect), leaning: str(x.leaning), tolerance: x.tolerance == null || x.tolerance === '' ? null : normStrength(x.tolerance), source: str(x.source) })),
        })),
        works: arr(b.works).map(w => (typeof w === 'string' ? { title: w } : w)).filter(w => str(w.title || w.name)).map(w => ({
            title: bare(w.title || w.name), aliases: arr(w.aliases).map(bare).filter(a => a && a !== bare(w.title || w.name)), penname: str(w.penname),
            form: enumKey(FORMS, w.form, ''), outlet: bare(w.outlet || w.outletName),
            pubDate: date(w.pubDate), endDate: date(w.endDate), datePrecision: precKey(w.datePrecision), dateFrom: date(w.dateFrom), themes: arr(w.themes).map(str), summary: str(w.summary), versionOf: bare(w.versionOf),
            shelf: w.shelf === true || w.shelf === 'yes' ? 'yes' : w.shelf === false || w.shelf === 'no' ? 'no' : '', shelfUntil: date(w.shelfUntil),
            claims: arr(w.claims).filter(x => x && str(x.issue)).map(x => ({ issue: str(x.issue), side: normSide(x.side), note: str(x.note), where: str(x.where) })),
        })),
        reactions: [], readings: [],
        rumors: arr(b.rumors).map(r => (typeof r === 'string' ? { text: r } : r)).filter(r => str(r.text)).map(r => ({ text: str(r.text), strength: Math.max(0, Math.min(1, num(r.strength, 0.5))) })),
        privateFacts: arr(b.privateFacts).map(f => (typeof f === 'string' ? { text: f } : f)).filter(f => str(f?.text)).map(f => ({
            text: str(f.text), topic: str(f.topic) || '其他', work: bare(f.work), public: !!f.public, publicSince: date(f.publicSince),
            knownBy: arr(f.knownBy).map(k => (typeof k === 'string' ? { person: k } : k)).filter(k => str(k?.person)).map(k => ({ person: str(k.person), since: date(k.since), via: ['told', 'letter', 'heard', 'saw', 'inferred'].includes(k.via) ? k.via : 'told', believes: k.believes !== false })),
        })),
        eraNotes: arr(b.eraNotes).map(n => (typeof n === 'string' ? { text: n } : n)).filter(n => str(n.text)).map(n => ({ title: str(n.title), text: str(n.text) })),
        selfImage: arr(b.selfImage).map(x => (typeof x === 'string' ? { text: x } : x)).filter(x => str(x?.text)).map(x => ({
            mode: x.mode === 'claim' ? 'claim' : 'self', topic: PERC_TOPICS.includes(str(x.topic)) ? str(x.topic) : '其他', text: str(x.text), since: date(x.since), penname: str(x.penname) })),
        assumed: arr(b.assumed).filter(x => str(x?.belief) && (str(x.person) || str(x.circle))).map(x => ({
            person: str(x.person), circle: str(x.person) ? '' : enumKey(CIRCLES, x.circle, ''), topic: PERC_TOPICS.includes(str(x.topic)) ? str(x.topic) : '其他', belief: str(x.belief), since: date(x.since), penname: str(x.penname) })),
        perceptions: arr(b.perceptions).filter(x => str(x?.belief) && str(x.person)).map(x => ({
            person: str(x.person), topic: PERC_TOPICS.includes(str(x.topic)) ? str(x.topic) : '其他', belief: str(x.belief), kind: PERC_KIND[x.kind] ? x.kind : 'inference', date: date(x.date), penname: str(x.penname), evidence: str(x.evidence) })),
        warnings: warn,
    };
    for (const r of arr(b.reactions || b.confirmedReactions)) {
        const d = date(r.date);
        if (!d) { warn.push(`反响缺少有效日期，已跳过：${str(r.summary || r.person).slice(0, 30)}`); continue; }
        out.reactions.push({
            date: d, layer: enumKey(LAYERS, r.layer, 'notice'), person: str(r.person), outlet: bare(r.outlet || r.outletName), work: bare(r.work),
            polarity: [1, 0, -1].includes(num(r.polarity)) ? num(r.polarity) : 0, count: num(r.count),
            title: str(r.title), summary: str(r.summary), evidence: str(r.evidence), datePrecision: precKey(r.datePrecision),
            to: str(r.to || r.recipient), knownAt: date(r.knownAt),
        });
    }
    for (const r of arr(b.readings)) {
        const d = date(r.date);
        if (!d || !str(r.person) || !str(r.work)) { warn.push(`阅读记录缺日期/人物/作品，已跳过：${str(r.person)} ${str(r.work)}`); continue; }
        out.readings.push({ date: d, person: str(r.person), work: bare(r.work), read: ['skimmed', 'finished', 'unknown'].includes(r.read) ? r.read : 'unknown', note: str(r.note) });
    }
    return out;
}

// ———————————— 合并多份整理包（分块抽取或分几次输出） ————————————

const keyOf = { selfImage: x => x.mode + x.text, assumed: x => (x.person || x.circle) + x.belief, perceptions: x => x.person + x.belief, privateFacts: x => x.text, pennames: x => x.name, outlets: x => x.name, persons: x => x.name, works: x => x.title, rumors: x => x.text, eraNotes: x => x.title + x.text,
    reactions: x => `${x.date}|${x.layer}|${x.person}|${x.work}|${x.outlet}|${x.title}|${x.polarity}`, readings: x => `${x.person}|${x.work}` };
const sameName = (a, b) => { const n = s => String(s || '').replace(/[\s·・.《》]/g, '').toLowerCase(); return n(a) && n(a) === n(b); };

export function mergeBundles(a, b) {
    if (!a) return b;
    const out = { ...a, warnings: [...(a.warnings || []), ...(b.warnings || [])] };
    if (b.storyDate && (!a.storyDate || cmp(b.storyDate, a.storyDate) > 0)) out.storyDate = b.storyDate;
    if (b.place) out.place = b.place;
    for (const k of Object.keys(keyOf)) {
        const list = [...(a[k] || [])];
        for (const item of b[k] || []) {
            const ex = list.find(x => sameName(keyOf[k](x), keyOf[k](item)) || (x.aliases || []).some(al => sameName(al, keyOf[k](item))));
            if (!ex) { list.push(item); continue; }
            const nameField = 'name' in item ? 'name' : 'title' in item ? 'title' : null;
            if (nameField && item[nameField] && item[nameField] !== ex[nameField] && 'aliases' in ex) ex.aliases = [...new Set([...(ex.aliases || []), item[nameField]])];
            for (const [f, v] of Object.entries(item)) {
                if (f === nameField) continue; // 名字以先出现的为准，后来的写法记作别名
                if (f === 'knownBy') { const m = new Map((ex.knownBy || []).map(k => [k.person, k])); for (const k of v) m.set(k.person, { ...(m.get(k.person) || {}), ...k }); ex.knownBy = [...m.values()]; continue; }
                if (f === 'relations') { const m = new Map((ex.relations || []).map(r => [r.to, r])); for (const r of v) m.set(r.to, { ...(m.get(r.to) || {}), ...r }); ex.relations = [...m.values()]; continue; }
                if (KEYED[f]) { ex[f] = mergeKeyed(ex[f], v, KEYED[f]); continue; }
                if (f === 'rolesGiven') { ex[f] = !!(ex[f] || v); continue; }
                if (Array.isArray(v)) ex[f] = [...new Set([...(ex[f] || []), ...v])];
                else if (v !== '' && v != null) ex[f] = v; // 后出现的（更新的）覆盖
            }
        }
        out[k] = list;
    }
    return out;
}

// ———————————— 预览与应用 ————————————

function findPerson(state, name) {
    return findByName(state.persons, name) || state.persons.find(p => (p.aliases || []).some(a => sameName(a, name))) || null;
}
// 作品只认完全同名（忽略空格标点）或别名：“石田日记”和“石田日记 单行本”是两部作品
function findWork(state, title) {
    return state.works.find(w => sameName(w.title, title)) || state.works.find(w => (w.aliases || []).some(a => sameName(a, title))) || null;
}

/** 旧版整理包导入的“已发生反响”里，新整理包已经没有的（例如被合并进累计数、被删掉的重复条目） */
export function staleImported(state, b) {
    const nameOf = (list, id, f = 'name') => (id ? list.find(x => x.id === id)?.[f] || '' : '');
    const eq = (a, b) => (!a && !b) || sameName(a, b);
    return (state.ledger || []).filter(e => e.origin === 'manual' && (e.flags || []).includes('来自整理包：已发生')).filter(e => !b.reactions.some(r =>
        r.date === e.date && r.layer === e.layer && (e.text?.title || '') === r.title && e.polarity === r.polarity
        && eq(nameOf(state.persons, e.personId) || e.personName || '', (r.person && findPerson(state, r.person)?.name) || r.person || '')
        && eq(nameOf(state.works, e.workId, 'title'), (r.work && findWork(state, r.work)?.title) || '')
        && eq(nameOf(state.outlets, e.outletId), (r.outlet && findByName(state.outlets, r.outlet)?.name) || r.outlet || '')));
}

/** 预览：每类新建几个、更新几个，以及会出问题的地方 */
export function previewBundle(state, b) {
    const pv = { counts: {}, items: {}, warnings: [...(b.warnings || [])] };
    const tally = (k, list, finder, label) => {
        pv.items[k] = list.map(x => ({ name: label(x), exists: !!finder(x) }));
        pv.counts[k] = { new: pv.items[k].filter(x => !x.exists).length, update: pv.items[k].filter(x => x.exists).length };
    };
    tally('pennames', b.pennames, x => findByName(state.pennames, x.name), x => x.name);
    tally('outlets', b.outlets, x => findByName(state.outlets, x.name) || (x.originalName && findByName(state.outlets, x.originalName)), x => x.name);
    tally('persons', b.persons, x => findPerson(state, x.name), x => x.name);
    tally('works', b.works, x => findWork(state, x.title), x => `《${x.title}》${x.pubDate ? ' ' + x.pubDate : ''}`);
    const dup = r => state.ledger.some(e => e.origin === 'manual' && e.date === r.date && e.layer === r.layer && (e.text?.title || '') === r.title && e.polarity === r.polarity
        && (state.persons.find(p => p.id === e.personId)?.name || e.personName || '') === (findPerson(state, r.person)?.name || r.person || '')
        && (state.works.find(w => w.id === e.workId)?.title || '') === (findWork(state, r.work)?.title || '')
        && (state.outlets.find(o => o.id === e.outletId)?.name || '') === (findByName(state.outlets, r.outlet)?.name || ''));
    pv.items.reactions = b.reactions.map(r => ({ name: `${r.date} ${LAYERS[r.layer]?.label || r.layer} ${r.person || r.outlet || ''}${r.work ? ' 评《' + r.work + '》' : ''}`, exists: dup(r) }));
    pv.counts.reactions = { new: pv.items.reactions.filter(x => !x.exists).length, update: pv.items.reactions.filter(x => x.exists).length };
    pv.items.readings = b.readings.map(r => ({ name: `${r.date} ${r.person} 读《${r.work}》`, exists: false }));
    pv.counts.readings = { new: b.readings.length, update: 0 };
    pv.counts.rumors = { new: b.rumors.length, update: 0 };
    pv.counts.eraNotes = { new: b.eraNotes.length, update: 0 };
    pv.items.privateFacts = (b.privateFacts || []).map(f => ({ name: `${f.text}${f.knownBy?.length ? '（知情：' + f.knownBy.map(k => k.person).join('、') + '）' : ''}`, exists: (state.privateFacts || []).some(x => String(x.text).replace(/\s/g, '') === String(f.text).replace(/\s/g, '')) }));
    pv.counts.privateFacts = { new: pv.items.privateFacts.filter(x => !x.exists).length, update: pv.items.privateFacts.filter(x => x.exists).length };
    const nz = t => String(t || '').replace(/[\s，。、；：“”（）,.;:]/g, '');
    pv.items.selfImage = (b.selfImage || []).map(x => ({ name: `${x.mode === 'claim' ? '对外说法' : '主角自认'}：${x.text}`, exists: (state.selfImage || []).some(y => y.mode === x.mode && nz(y.text) === nz(x.text)) }));
    pv.items.assumed = (b.assumed || []).map(x => ({ name: `以为${x.person || CIRCLES[x.circle] || ''}觉得：${x.belief}`, exists: (state.assumed || []).some(y => nz(y.belief) === nz(x.belief)) }));
    pv.items.perceptions = (b.perceptions || []).map(x => ({ name: `${x.person}：${x.belief}（${PERC_KIND[x.kind]}）`, exists: (state.perceptions || []).some(y => nz(y.belief) === nz(x.belief) && findPerson(state, x.person)?.id === y.observerId) }));
    for (const k of ['selfImage', 'assumed', 'perceptions']) pv.counts[k] = { new: pv.items[k].filter(x => !x.exists).length, update: 0 };
    // 引用了整理包和现有数据里都没有的名字
    const has = (k, n) => !n || b[k].some(x => sameName(x.name || x.title, n) || (x.aliases || []).some(a => sameName(a, n)))
        || (k === 'outlets' ? findByName(state.outlets, n) : k === 'persons' ? findPerson(state, n) : findWork(state, n));
    const miss = new Set();
    for (const w of b.works) if (w.outlet && !has('outlets', w.outlet)) miss.add(`刊物“${w.outlet}”（作品《${w.title}》）将自动新建`);
    for (const p of b.persons) for (const o of [...p.outlets, ...p.reads]) if (!has('outlets', o)) miss.add(`刊物“${o}”（${p.name} 供稿/常读）将自动新建，出刊周期需要你补`);
    for (const r of b.reactions) {
        if (r.work && !has('works', r.work)) miss.add(`反响引用的作品《${r.work}》不存在，这条会没有对应作品`);
        if (r.outlet && !has('outlets', r.outlet)) miss.add(`刊物“${r.outlet}”将自动新建`);
    }
    for (const r of b.readings) {
        if (!has('persons', r.person)) miss.add(`阅读记录里的“${r.person}”不在人物列表，将自动新建`);
        if (!has('works', r.work)) miss.add(`阅读记录里的作品《${r.work}》不存在，这条会被跳过`);
    }
    pv.warnings.push(...miss);
    pv.stale = staleImported(state, b).map(e => `${e.date} ${LAYERS[e.layer]?.label || e.layer} ${state.persons.find(p => p.id === e.personId)?.name || e.personName || ''}${e.workId ? ' 《' + (state.works.find(w => w.id === e.workId)?.title || '') + '》' : ''}${e.count ? ` 约${e.count}` : ''}`);
    if (b.storyDate && state.currentDate && cmp(b.storyDate, state.currentDate) < 0) pv.warnings.push(`整理包的日期 ${b.storyDate} 早于当前故事日期 ${state.currentDate}，不会把日期往回调`);
    return pv;
}

/** 私信的收信人：空、“主角”、主角的名字或笔名 → 主角；否则是别人之间的信，主角要等 knownAt 才知道 */
function recipientOf(state, r) {
    if (r.layer !== 'private_letter') return {};
    const me = new Set(['', '主角', '我', ...(state.pennames || []).flatMap(p => [p.owner, p.name]).filter(Boolean)].map(x => String(x).replace(/\s/g, '')));
    const to = String(r.to || '').replace(/\s/g, '');
    if (me.has(to)) return { to: 'protagonist', knownAt: r.knownAt || r.date };
    return { to: r.to, knownAt: r.knownAt || null };
}

function ensureOutlet(state, name, report) {
    if (!name) return '';
    let o = findByName(state.outlets, name);
    if (!o) { o = { ...blankOutlet(), name, periodicity: 'irregular' }; state.outlets.push(o); report.created.push(`刊物“${name}”（请补全出刊周期）`); }
    return o.id;
}
function ensurePerson(state, name, report) {
    if (!name) return null;
    let p = findPerson(state, name);
    if (!p) { p = { ...blankPerson(), name, roles: [], closeness: 0 }; state.persons.push(p); report.created.push(`人物“${name}”（资料空白）`); }
    return p;
}
/** 合并：默认只补充（数组取并集，空值不覆盖）；replace=true 时以新版为准，标签等数组整体替换 */
const fill = (target, src, replace = false) => {
    for (const [k, v] of Object.entries(src)) {
        if (Array.isArray(v) && replace && !['outletIds', 'reads'].includes(k)) { target[k] = [...v]; continue; }
        if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue;
        target[k] = Array.isArray(v) && Array.isArray(target[k]) ? [...new Set([...target[k], ...v])] : v;
    }
};

/**
 * 应用整理包。opts.kinds：要导入的类别；opts.dateMode：'set'（直接设为当前，不推演之间）| 'none'
 * 返回报告 { lines, created, skipped }
 */
export function applyBundle(state, b, { kinds = null, dateMode = 'set', settings = {}, era = null, sync = false } = {}) {
    const on = k => !kinds || kinds.includes(k);
    const report = { lines: [], created: [], skipped: [], removed: [] };
    if (sync && on('reactions')) {
        const stale = new Set(staleImported(state, b).map(e => e.id));
        for (const e of state.ledger.filter(x => stale.has(x.id))) report.removed.push(`${e.date} ${LAYERS[e.layer]?.label || e.layer}${e.count ? ` 约${e.count}` : ''}`);
        state.ledger = state.ledger.filter(e => !stale.has(e.id));
    }
    if (sync && on('readings')) {
        // 旧版导入的阅读记录（带标记的）先撤掉，下面按新版重建
        const old = (state.receptions || []).filter(r => r.fromBundle);
        const oldIds = new Set(old.flatMap(r => r.eventIds || []));
        state.ledger = state.ledger.filter(e => !(oldIds.has(e.id) && e.status !== 'approved'));
        state.receptions = state.receptions.filter(r => !r.fromBundle);
        for (const r of old) delete state.rolls?.[`${r.workId}|${r.personId}`];
        if (old.length) report.lines.push(`撤掉旧版导入的阅读记录 ${old.length} 条，按新版重建`);
    }
    if (b.place && !state.era.place) state.era.place = b.place;

    if (on('outlets')) for (const o of b.outlets) {
        const ex = findByName(state.outlets, o.name) || (o.originalName && findByName(state.outlets, o.originalName));
        const data = { name: o.name, originalName: o.originalName, periodicity: o.periodicity, weekday: o.weekday, monthDays: o.monthDays, circle: o.circle, tier: o.tier, politics: o.politics, issueDates: o.issueDates, note: [o.originalName, o.note].filter(Boolean).join('；') };
        if (ex) { const n = ex.name; fill(ex, data, sync); ex.name = n; ex.real = o.real; } else state.outlets.push({ ...blankOutlet(), ...Object.fromEntries(Object.entries(data).filter(([, v]) => v !== '' && v != null)), periodicity: o.periodicity || 'irregular', circle: o.circle || 'general', tier: o.tier || 3, real: o.real });
    }
    if (on('persons')) for (const p of b.persons) {
        let ex = findPerson(state, p.name);
        if (!ex) { ex = { ...blankPerson(), name: p.name, roles: [] }; state.persons.push(ex); }
        const data = {
            aliases: p.aliases, interests: p.interests, likes: p.likes, dislikes: p.dislikes, notes: p.notes,
            closeness: p.closeness, knowsIdentity: p.knowsIdentity, real: p.real, monthlyCapacity: p.monthlyCapacity, columnWeekday: p.columnWeekday,
            outletIds: p.outlets.map(n => ensureOutlet(state, n, report)).filter(Boolean),
            reads: p.reads.map(n => ensureOutlet(state, n, report)).filter(Boolean),
        };
        fill(ex, data, sync);
        for (const f of ['stances', 'stylePrefs']) if (p[f]?.length || sync) ex[f] = sync ? [...(p[f] || [])] : mergeKeyed(ex[f], p[f], KEYED[f]);
        if (sync) { ex.outletIds = data.outletIds; ex.reads = data.reads; }
        if (p.rolesGiven) ex.roles = p.roles;
    }
    if (on('persons')) for (const p of b.persons) {
        if (!p.relations?.length && !(sync && findPerson(state, p.name)?.relations?.length)) continue;
        const ex = findPerson(state, p.name);
        if (!ex) continue;
        const m = new Map(sync ? [] : (ex.relations || []).map(r => [r.to, r]));
        for (const r of p.relations) {
            const q = findPerson(state, r.to);
            if (!q || q.id === ex.id) { report.skipped.push(`关系：${p.name} → ${r.to}（找不到此人）`); continue; }
            m.set(q.id, { ...(m.get(q.id) || {}), ...r, to: q.id });
        }
        ex.relations = [...m.values()];
    }
    if (on('pennames')) for (const p of b.pennames) {
        let ex = findByName(state.pennames, p.name);
        if (!ex) { ex = { ...blankPenname(), name: p.name }; state.pennames.push(ex); }
        if (p.owner) ex.owner = p.owner;
        if (p.publicIdentityKnown) ex.publicIdentityKnown = true;
        const ids = p.knownBy.map(n => findPerson(state, n)?.id).filter(Boolean);
        ex.knownBy = [...new Set([...(ex.knownBy || []), ...ids])];
    }
    if (on('works')) {
        for (const w of b.works) {
            let ex = findWork(state, w.title);
            const pen = w.penname ? (findByName(state.pennames, w.penname) || (() => { const p = { ...blankPenname(), name: w.penname }; state.pennames.push(p); report.created.push(`笔名“${w.penname}”`); return p; })()) : null;
            const data = {
                aliases: w.aliases, form: w.form, outletId: ensureOutlet(state, w.outlet, report), pubDate: w.pubDate, endDate: w.endDate,
                themes: w.themes, summary: w.summary, pennameId: pen?.id || '', datePrecision: w.datePrecision, dateFrom: w.dateFrom, shelf: w.shelf, shelfUntil: w.shelfUntil,
            };
            if (!ex) { ex = { ...blankWork(), title: w.title, pennameId: state.pennames[0]?.id || '' }; state.works.push(ex); }
            fill(ex, data, sync);
            if (w.claims?.length || sync) ex.claims = sync ? [...(w.claims || [])] : mergeKeyed(ex.claims, w.claims, KEYED.claims);
        }
        for (const w of b.works) if (w.versionOf) {
            const ex = findWork(state, w.title); const par = findWork(state, w.versionOf);
            if (ex && par && ex !== par) ex.parentId = par.id;
        }
    }
    // 日期放在反响之前：阅读记录需要知道“现在”
    if (b.storyDate && dateMode === 'set' && (!state.currentDate || cmp(b.storyDate, state.currentDate) > 0)) {
        report.lines.push(`故事日期：${state.currentDate || '（未设定）'} → ${b.storyDate}`);
        state.currentDate = b.storyDate;
    }
    if (on('privateFacts')) for (const f of b.privateFacts || []) {
        state.privateFacts = state.privateFacts || [];
        const n = t => String(t || '').replace(/[\s，。、；：“”（）,.;:]/g, '');
        let ex = state.privateFacts.find(x => n(x.text) === n(f.text));
        if (!ex) { ex = { id: uid('pf'), topic: f.topic, text: f.text, workId: '', public: false, publicSince: '', secret: '', knownBy: [] }; state.privateFacts.push(ex); }
        ex.topic = f.topic || ex.topic;
        if (f.work) ex.workId = findWork(state, f.work)?.id || ex.workId;
        if (f.public) { ex.public = true; ex.publicSince = f.publicSince || ex.publicSince; }
        const kb = sync ? [] : [...(ex.knownBy || [])];
        for (const k of f.knownBy) {
            const q = findPerson(state, k.person);
            if (!q) { report.skipped.push(`私人信息的知情者“${k.person}”不在人物表里`); continue; }
            const i = kb.findIndex(x => x.personId === q.id);
            const row = { personId: q.id, since: k.since, via: k.via, believes: k.believes };
            if (i >= 0) kb[i] = { ...kb[i], ...row }; else kb.push(row);
        }
        ex.knownBy = kb;
    }
    const nz = t => String(t || '').replace(/[\s，。、；：“”（）,.;:]/g, '');
    const penOf = name => (name ? findByName(state.pennames, name)?.id : '') || '';
    if (on('selfImage')) for (const x of b.selfImage || []) {
        state.selfImage = state.selfImage || [];
        if (state.selfImage.some(y => y.mode === x.mode && nz(y.text) === nz(x.text))) continue;
        state.selfImage.push({ id: uid('si'), mode: x.mode, topic: x.topic, text: x.text, since: x.since || '', pennameId: penOf(x.penname) });
        report.created.push(`${x.mode === 'claim' ? '对外说法' : '主角自认'}“${x.text.slice(0, 20)}”`);
    }
    if (on('assumed')) for (const x of b.assumed || []) {
        state.assumed = state.assumed || [];
        const q = x.person ? findPerson(state, x.person) : null;
        if (x.person && !q) { report.skipped.push(`“主角以为”里的人物“${x.person}”不在人物表里`); continue; }
        if (state.assumed.some(y => nz(y.belief) === nz(x.belief) && (y.personId || '') === (q?.id || '') && (y.circle || '') === (x.circle || ''))) continue;
        state.assumed.push({ id: uid('as'), personId: q?.id || '', circle: q ? '' : x.circle, topic: x.topic, belief: x.belief, since: x.since || '', pennameId: penOf(x.penname) });
        report.created.push(`主角以为“${x.belief.slice(0, 20)}”`);
    }
    if (on('perceptions')) for (const x of b.perceptions || []) {
        const q = findPerson(state, x.person);
        if (!q) { report.skipped.push(`看法的主人“${x.person}”不在人物表里`); continue; }
        if ((state.perceptions || []).some(y => y.observerId === q.id && nz(y.belief) === nz(x.belief))) continue;
        const p = manualPerception(state, { personId: q.id, topic: x.topic, belief: x.belief, kind: x.kind, date: x.date || state.currentDate || '', pennameId: penOf(x.penname) });
        p.origin = 'bundle'; p.evidence = x.evidence.slice(0, 120);
        report.created.push(`${q.name} 的看法“${x.belief.slice(0, 20)}”${p.kind !== x.kind ? `（标为${PERC_KIND[x.kind]}，但对不上他知道的事，改为${PERC_KIND[p.kind]}）` : ''}`);
    }
    if (on('reactions')) for (const r of b.reactions) {
        const person = r.person ? (findPerson(state, r.person) || (['reader_letters', 'mentions'].includes(r.layer) ? null : ensurePerson(state, r.person, report))) : null;
        const work = r.work ? findWork(state, r.work) : null;
        const outletId = ensureOutlet(state, r.outlet, report) || null;
        // 同日同类、同人同作品，还要同刊物、同标题、同褒贬才算重复（同一天多家报纸的书评要分别记）
        const dup = state.ledger.some(e => e.origin === 'manual' && e.date === r.date && e.layer === r.layer && (e.personId || null) === (person?.id || null)
            && (e.workId || null) === (work?.id || null) && (e.outletId || null) === outletId && (e.text?.title || '') === r.title && e.polarity === r.polarity);
        if (dup) { report.skipped.push(`已存在：${r.date} ${r.person}`); continue; }
        const seen = matchSeenFromChat(state, { layer: r.layer, date: r.date, personId: person?.id || null, workId: work?.id || null, outletId, summary: r.summary });
        if (seen) { r.matchedEngine = seen.id; report.lines.push(`聊天里提到的 ${r.date} ${r.person || ''}${r.work ? '《' + r.work + '》' : ''}，就是推演里的那一篇：标为主角已读到（${seen.seenAt}）`); continue; }
        const ev = {
            id: uid('ev'), key: null, origin: 'manual', date: r.date, layer: r.layer,
            personId: person?.id || null, personName: person ? undefined : (r.person || undefined),
            outletId,
            workId: work?.id || null, pennameId: work?.pennameId || null,
            polarity: r.polarity, count: r.count ?? undefined, status: 'candidate',
            text: r.summary || r.title ? { title: r.title, summary: r.summary, body: '', byline: '', section: '' } : null,
            datePrecision: r.datePrecision || undefined,
            ...recipientOf(state, r),
            flags: ['来自整理包：已发生'], why: r.evidence ? [`依据：${r.evidence}`] : [], repApplied: null,
        };
        state.ledger.push(ev);
        setStatus(state, ev, 'approved');
    }
    // 署了名的反响意味着此人当时已经读过：没有对应阅读记录的，补一条，态度按反响定
    const inferred = [];
    if (on('readings') && on('reactions')) {
        for (const r of b.reactions) {
            if (!r.person || !r.work || ['reader_letters', 'mentions'].includes(r.layer) || r.matchedEngine) continue; // 对上推演事件的：推演里已经有他的阅读记录
            const has = b.readings.some(x => sameName(x.person, r.person) && sameName(x.work, r.work))
                || inferred.some(x => sameName(x.person, r.person) && sameName(x.work, r.work));
            if (!has) inferred.push({ date: r.date, person: r.person, work: r.work, read: 'unknown', note: `由${LAYERS[r.layer]?.label || '反响'}推断接触过（${r.date}），读了多少不详`, known: { polarity: r.polarity, source: LAYERS[r.layer]?.label } });
        }
        if (inferred.length) report.lines.push(`由署名反响补了 ${inferred.length} 条阅读记录：${inferred.map(x => `${x.person}读${x.work}`).join('、')}`);
    }
    if (on('readings')) for (const r of [...b.readings, ...inferred]) {
        const work = findWork(state, r.work);
        const person = ensurePerson(state, r.person, report);
        if (!work || !person) { report.skipped.push(`阅读：${r.person} 读《${r.work}》（找不到作品）`); continue; }
        if (state.currentDate && cmp(r.date, state.currentDate) > 0) { report.skipped.push(`阅读：${r.person} ${r.date} 晚于当前日期`); continue; }
        // 导入的是“已经发生的历史”：在当前日期之前，不让这些阅读另外推演出主角没收到过的信或文章
        const hist = state.currentDate ? { ...settings, publicBefore: state.currentDate, privateBefore: state.currentDate } : settings;
        // 同一部作品若他也有署名反响，用反响的态度
        const kn = r.known || (() => { const x = b.reactions.find(y => y.person && sameName(y.person, r.person) && sameName(y.work, r.work) && !['reader_letters', 'mentions'].includes(y.layer)); return x ? { polarity: x.polarity, source: LAYERS[x.layer]?.label } : null; })();
        try { const rc = recordManualReading(state, hist, era, { workId: work.id, personId: person.id, date: r.date, read: r.read, note: r.note || '整理包', known: kn }); rc.fromBundle = true; } catch (e) { report.skipped.push(`阅读：${e.message}`); }
    }
    if (on('rumors')) for (const r of b.rumors) {
        if ((state.rumors || []).some(x => sameName(x.text, r.text))) continue;
        (state.rumors = state.rumors || []).push({ id: uid('rm'), text: r.text, strength: r.strength, pinned: false, lastDate: state.currentDate });
    }
    if (on('eraNotes')) for (const n of b.eraNotes) {
        if (state.eraNotes.some(x => sameName(x.text, n.text))) continue;
        state.eraNotes.push({ title: n.title, text: n.text });
    }
    state.ledger.sort((a, b2) => cmp(a.date, b2.date));
    recomputeReputation(state);
    return report;
}

// ———————————— 插件内一键整理 ————————————

export function chunk(text, size = 14000, overlap = 400) {
    const s = String(text || '');
    const out = [];
    for (let i = 0; i < s.length; i += size - overlap) {
        out.push(s.slice(i, i + size));
        if (i + size >= s.length) break;
    }
    return out;
}

/** 把多份材料交给已连接的模型，按块抽取并合并成一份整理包 */
export async function organize(state, materials, settings, onProgress, signal) {
    const chunks = materials.flatMap(m => chunk(m.text).map((t, i, all) => ({ label: `${m.label}${all.length > 1 ? `（${i + 1}/${all.length}）` : ''}`, text: t })));
    let bundle = null;
    for (let i = 0; i < chunks.length; i++) {
        if (signal?.aborted) break;
        onProgress?.(`整理 ${i + 1}/${chunks.length}：${chunks[i].label}`);
        const known = knownNames({
            pennames: [...state.pennames, ...(bundle?.pennames || [])],
            outlets: [...state.outlets, ...(bundle?.outlets || [])],
            persons: [...state.persons, ...(bundle?.persons || [])],
            works: [...state.works, ...(bundle?.works || []).map(w => ({ title: w.title }))],
        });
        const system = `你是档案整理员。把用户给的一段材料（角色扮演聊天记录、书信、设定）整理成“报刊回声整理包”的 JSON。这只是全部材料中的一段，只输出这一段里出现的信息。
格式：
${FORMAT_SPEC}

${FORMAT_RULES}
${known ? `\n已知名字（指同一对象时沿用完全相同的写法）：\n${known}` : ''}`;
        let raw;
        try {
            raw = await callLLM({ system, user: `【${chunks[i].label}】\n${chunks[i].text}`, settings, maxTokens: 4000, label: `整理第 ${i + 1}/${chunks.length} 段（${chunks[i].label}）` });
            const part = normalizeBundle(extractJSON(raw));
            bundle = mergeBundles(bundle, part);
            clog('info', `第 ${i + 1} 段整理出：人物 ${part.persons.length}、作品 ${part.works.length}、刊物 ${part.outlets.length}、反响 ${part.reactions.length}、阅读 ${part.readings.length}${part.warnings.length ? `；提示 ${part.warnings.length} 条` : ''}`,
                [part.persons.length ? '人物：' + part.persons.map(p => p.name).join('、') : '', part.works.length ? '作品：' + part.works.map(w => w.title).join('、') : '', ...part.reactions.map(r => `反响：${r.date || ''} ${r.person || ''} ${r.layer || ''} ${r.work || ''}`), ...part.warnings].filter(Boolean).join('\n') || null);
        } catch (e) {
            bundle = mergeBundles(bundle, normalizeBundle({}));
            bundle.warnings.push(`第 ${i + 1} 段（${chunks[i].label}）整理失败：${e.message}`);
            clog('error', `第 ${i + 1} 段（${chunks[i].label}）整理失败：${e.message}`, raw ? '模型原始回复：\n' + String(raw).slice(0, 6000) : (e.stack || null));
        }
    }
    return bundle || normalizeBundle({});
}

/** SillyTavern 聊天导出（.jsonl）或当前聊天 → 纯文本 */
export function chatToText(messages) {
    return (messages || [])
        .filter(m => m && typeof m.mes === 'string' && !m.is_system)
        .map(m => `${m.name || (m.is_user ? '用户' : '角色')}：${m.mes}`)
        .join('\n\n');
}
export function parseJsonl(text) {
    const out = [];
    for (const line of String(text || '').split(/\r?\n/)) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line)); } catch { /* 跳过坏行 */ }
    }
    return out;
}

/** 判断一个对象是不是整理包 */
export function looksLikeBundle(obj) {
    if (!obj || typeof obj !== 'object') return false;
    if (obj.format === FORMAT_ID) return true;
    return ['works', 'persons', 'outlets', 'reactions', 'pennames'].filter(k => Array.isArray(obj[k])).length >= 2;
}

// ———————————— 预览里修改整理包 ————————————

/** 改了名字之后，把整理包里其他地方对旧名字的引用一起改掉 */
export function renameRefs(b, kind, oldName, newName) {
    if (!oldName || !newName || oldName === newName) return 0;
    let n = 0;
    const sw = v => { if (sameName(v, oldName)) { n++; return newName; } return v; };
    const swArr = a => (Array.isArray(a) ? a.map(sw) : a);
    if (kind === 'persons') {
        for (const r of b.reactions || []) r.person = sw(r.person);
        for (const r of b.readings || []) r.person = sw(r.person);
        for (const p of b.persons || []) for (const r of p.relations || []) r.to = sw(r.to);
        for (const p of b.pennames || []) p.knownBy = swArr(p.knownBy);
    } else if (kind === 'works') {
        for (const r of b.reactions || []) r.work = sw(r.work);
        for (const r of b.readings || []) r.work = sw(r.work);
        for (const w of b.works || []) w.versionOf = sw(w.versionOf);
    } else if (kind === 'outlets') {
        for (const r of b.reactions || []) r.outlet = sw(r.outlet);
        for (const w of b.works || []) w.outlet = sw(w.outlet);
        for (const p of b.persons || []) { p.outlets = swArr(p.outlets); p.reads = swArr(p.reads); }
    } else if (kind === 'pennames') {
        for (const w of b.works || []) w.penname = sw(w.penname);
    }
    return n;
}

/** 把一条改过的条目规整后放回整理包；改名时同步引用，并合并因此重名的条目 */
export function replaceBundleItem(b, kind, index, raw) {
    const old = b[kind]?.[index];
    if (!old) throw new Error('条目不存在');
    const norm = normalizeBundle({ [kind]: [raw] });
    const item = norm[kind]?.[0];
    if (!item) throw new Error(norm.warnings[0] || '这条不完整（例如缺日期或名字），没有保存');
    if (kind === 'persons') item.rolesGiven = old.rolesGiven || JSON.stringify(item.roles) !== JSON.stringify(old.roles);
    const nameKey = kind === 'works' ? 'title' : 'name';
    const refs = old[nameKey] && item[nameKey] ? renameRefs(b, kind, old[nameKey], item[nameKey]) : 0;
    b[kind][index] = item;
    const merged = mergeBundles(normalizeBundle({ storyDate: b.storyDate, place: b.place }), { ...b, warnings: [] });
    merged.warnings = b.warnings || [];
    return { bundle: merged, refs, merged: merged[kind].length < b[kind].length };
}
