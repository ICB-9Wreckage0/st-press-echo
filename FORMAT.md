# 报刊回声 · 整理包格式（press-echo-import v1）

在外部用聊天式 AI 整理聊天记录时，把下面“提示词”整段发给它，再发聊天记录。它输出的 JSON 可以在插件“导入与整理”页粘贴读取，或存成 .json 拖进去。分几次输出的可以多次读取，插件按名字自动合并。整理包不要用“设置”页的“恢复存档 JSON”导入。

## 结构

```json
{
  "format": "press-echo-import",
  "version": 1,
  "storyDate": "故事当前日期 YYYY-MM-DD（聊天记录里最后的日期）",
  "place": "故事地点，如 法国·巴黎",
  "pennames": [{ "name": "笔名", "owner": "真实作者", "publicIdentityKnown": false, "knownBy": ["知道这个笔名是谁的人"] }],
  "outlets": [{ "name": "刊物名（用中文常用译名，全文统一）", "originalName": "原文名", "periodicity": "daily", "weekday": null, "monthDays": [], "circle": "general", "tier": 3, "politics": ["政治/宗教倾向"], "real": true, "note": "" }],
  "persons": [{ "name": "姓名（全文统一用一个写法）", "aliases": ["别名"], "roles": ["critic"], "outlets": ["供稿的刊物名"], "reads": ["常读的刊物名"], "interests": ["关注题材"], "likes": ["欣赏"], "dislikes": ["反感"], "closeness": 0, "knowsIdentity": false, "real": true, "monthlyCapacity": 2, "columnWeekday": null, "notes": "与主角的关系、往来",
      "relations": [{ "to": "另一个人物的名字", "type": "friend", "closeness": 2, "frequency": "weekly", "trust": 0.6, "discloseOpinions": true, "discloseIdentity": false, "since": "这段关系从何时开始（可空）", "until": "何时断了往来（可空）" }] }],
  "works": [{ "title": "作品名", "aliases": ["外文名、别名"], "penname": "署名", "form": "serial", "outlet": "首发刊物名", "pubDate": "首次发表 YYYY-MM-DD", "endDate": "连载结束 YYYY-MM-DD 或空", "themes": ["题材标签"], "summary": "内容摘要 80 字内", "versionOf": "若是另一部作品的单行本/再版，写那部作品的名字", "datePrecision": "day" }],
  "reactions": [{ "date": "YYYY-MM-DD", "layer": "review", "person": "谁（读者来信、剪报可空）", "outlet": "登在哪（私信可空）", "work": "针对哪部作品", "polarity": 1, "count": null, "title": "文章标题（若有）", "summary": "内容概要", "evidence": "依据：聊天里的原话或位置，40 字内", "datePrecision": "day" }],
  "readings": [{ "date": "YYYY-MM-DD", "person": "谁", "work": "哪部作品", "read": "finished", "note": "依据" }],
  "rumors": [{ "text": "坊间传闻", "strength": 0.5 }],
  "eraNotes": [{ "title": "标题", "text": "与时代背景有关、后续写作要遵守的事实" }]
}
```

字段取值：
- periodicity（出刊周期）：daily=日报，weekly=周刊/周报，biweekly=半月刊，monthly=月刊，irregular=不定期
- weekday / columnWeekday（星期）：0=星期日，1=星期一 … 6=星期六；不知道就填 null
- monthDays：月刊/半月刊的出刊日，如 [1] 或 [1,15]
- circle（读者圈子）：critics=评论界，literary=文学圈，general=普通读者，radical=激进/社会主义报刊圈，religious=宗教界，professional=专业界（法、医、学术），political=政界与政论
- tier（影响力）：1–5，5 最大
- roles（公开身份，可多选）：critic=评论家，journalist=记者/专栏作者，editor=编辑，writer=作家，scholar=学者/专业人士；只是朋友、从不公开写评论的人填 []
- closeness（与主角私交）：0 陌生，1 认识，2 朋友，3 至交
- relations（此人与其他人物的关系，有方向：写在 A 下面的是“A 对 B”）：type=friend=朋友，colleague=同事，family=家人/伴侣，mentor=师友/前辈，editor=编辑与作者，salon=沙龙/聚会常客，correspondent=通信往来，rival=对手/论敌；closeness 同上 0–3；frequency=daily=几乎天天见，weekly=每周，monthly=每月，rare=偶尔；trust 0–1（A 对 B 的信任）；discloseOpinions：A 会不会跟 B 谈起读过的东西；discloseIdentity：A 如果知道某个笔名背后是谁，会不会告诉 B（多数人会替作者保密，默认 false）；since / until：关系只在这段时间内有效，例如某人哪天搬来同住、哪天才认识（不知道就留空）。只写聊天里看得出来的关系，to 必须是 persons 里的名字
- knowsIdentity：此人是否知道主角就是这个笔名的作者
- real：是否真实历史人物 / 真实存在的刊物
- form（作品形式）：serial=报纸连载，article=单篇文章，book=成书，pamphlet=小册子/附赠本，translation_serial=译作连载，translation_book=译作单行本
- layer（反响类型）：review=正式书评，polemic=论战文章，notice=书讯/短评，echo=短讯/八卦，private_letter=私信，reader_letters=读者来信，mentions=转载/提及（剪报）
- polarity（褒贬）：1 肯定，0 褒贬参半，-1 批评
- count：读者来信封数、剪报条数（其他类型填 null）
- read：finished=读完，skimmed=读了一部分
规则：
1. 只记录聊天里明确发生过、明确写出的事，不推测、不补全常识；拿不准的字段留空或省略。
2. reactions 只收“已经发生”的：已见报的书评/短评/八卦/论战、已寄到的私信、读者来信、剪报。计划中、传言中的不算，可以写进 rumors。
3. readings 收“某人已经读过某作品”但没有形成书面反响的情况（例如见面时谈起、信里说读过）。
4. 同一个人、刊物、作品全文只用一个名字；外文名放进 aliases / originalName。
5. 日期一律 YYYY-MM-DD。日期不精确时照样填一个代表日，同时填 datePrecision：day=精确到日，xun=只知道上/中/下旬（填该旬第一天），month=只知道月份（填该月 1 日），noLaterThan=只知道“不晚于”这一天（例如单行本至某日已售罄）。
6. 只输出一个 JSON 对象，不要任何解释文字。

## 提示词

请把我接下来提供的角色扮演聊天记录（以及书信、设定）整理成一份 JSON“整理包”，供 SillyTavern 插件“报刊回声”导入。故事是历史背景，主角以笔名发表作品，插件会据此推演报刊和文坛的反响。

格式如下：
{
  "format": "press-echo-import",
  "version": 1,
  "storyDate": "故事当前日期 YYYY-MM-DD（聊天记录里最后的日期）",
  "place": "故事地点，如 法国·巴黎",
  "pennames": [{ "name": "笔名", "owner": "真实作者", "publicIdentityKnown": false, "knownBy": ["知道这个笔名是谁的人"] }],
  "outlets": [{ "name": "刊物名（用中文常用译名，全文统一）", "originalName": "原文名", "periodicity": "daily", "weekday": null, "monthDays": [], "circle": "general", "tier": 3, "politics": ["政治/宗教倾向"], "real": true, "note": "" }],
  "persons": [{ "name": "姓名（全文统一用一个写法）", "aliases": ["别名"], "roles": ["critic"], "outlets": ["供稿的刊物名"], "reads": ["常读的刊物名"], "interests": ["关注题材"], "likes": ["欣赏"], "dislikes": ["反感"], "closeness": 0, "knowsIdentity": false, "real": true, "monthlyCapacity": 2, "columnWeekday": null, "notes": "与主角的关系、往来",
      "relations": [{ "to": "另一个人物的名字", "type": "friend", "closeness": 2, "frequency": "weekly", "trust": 0.6, "discloseOpinions": true, "discloseIdentity": false, "since": "这段关系从何时开始（可空）", "until": "何时断了往来（可空）" }] }],
  "works": [{ "title": "作品名", "aliases": ["外文名、别名"], "penname": "署名", "form": "serial", "outlet": "首发刊物名", "pubDate": "首次发表 YYYY-MM-DD", "endDate": "连载结束 YYYY-MM-DD 或空", "themes": ["题材标签"], "summary": "内容摘要 80 字内", "versionOf": "若是另一部作品的单行本/再版，写那部作品的名字", "datePrecision": "day" }],
  "reactions": [{ "date": "YYYY-MM-DD", "layer": "review", "person": "谁（读者来信、剪报可空）", "outlet": "登在哪（私信可空）", "work": "针对哪部作品", "polarity": 1, "count": null, "title": "文章标题（若有）", "summary": "内容概要", "evidence": "依据：聊天里的原话或位置，40 字内", "datePrecision": "day" }],
  "readings": [{ "date": "YYYY-MM-DD", "person": "谁", "work": "哪部作品", "read": "finished", "note": "依据" }],
  "rumors": [{ "text": "坊间传闻", "strength": 0.5 }],
  "eraNotes": [{ "title": "标题", "text": "与时代背景有关、后续写作要遵守的事实" }]
}

字段取值：
- periodicity（出刊周期）：daily=日报，weekly=周刊/周报，biweekly=半月刊，monthly=月刊，irregular=不定期
- weekday / columnWeekday（星期）：0=星期日，1=星期一 … 6=星期六；不知道就填 null
- monthDays：月刊/半月刊的出刊日，如 [1] 或 [1,15]
- circle（读者圈子）：critics=评论界，literary=文学圈，general=普通读者，radical=激进/社会主义报刊圈，religious=宗教界，professional=专业界（法、医、学术），political=政界与政论
- tier（影响力）：1–5，5 最大
- roles（公开身份，可多选）：critic=评论家，journalist=记者/专栏作者，editor=编辑，writer=作家，scholar=学者/专业人士；只是朋友、从不公开写评论的人填 []
- closeness（与主角私交）：0 陌生，1 认识，2 朋友，3 至交
- relations（此人与其他人物的关系，有方向：写在 A 下面的是“A 对 B”）：type=friend=朋友，colleague=同事，family=家人/伴侣，mentor=师友/前辈，editor=编辑与作者，salon=沙龙/聚会常客，correspondent=通信往来，rival=对手/论敌；closeness 同上 0–3；frequency=daily=几乎天天见，weekly=每周，monthly=每月，rare=偶尔；trust 0–1（A 对 B 的信任）；discloseOpinions：A 会不会跟 B 谈起读过的东西；discloseIdentity：A 如果知道某个笔名背后是谁，会不会告诉 B（多数人会替作者保密，默认 false）；since / until：关系只在这段时间内有效，例如某人哪天搬来同住、哪天才认识（不知道就留空）。只写聊天里看得出来的关系，to 必须是 persons 里的名字
- knowsIdentity：此人是否知道主角就是这个笔名的作者
- real：是否真实历史人物 / 真实存在的刊物
- form（作品形式）：serial=报纸连载，article=单篇文章，book=成书，pamphlet=小册子/附赠本，translation_serial=译作连载，translation_book=译作单行本
- layer（反响类型）：review=正式书评，polemic=论战文章，notice=书讯/短评，echo=短讯/八卦，private_letter=私信，reader_letters=读者来信，mentions=转载/提及（剪报）
- polarity（褒贬）：1 肯定，0 褒贬参半，-1 批评
- count：读者来信封数、剪报条数（其他类型填 null）
- read：finished=读完，skimmed=读了一部分
规则：
1. 只记录聊天里明确发生过、明确写出的事，不推测、不补全常识；拿不准的字段留空或省略。
2. reactions 只收“已经发生”的：已见报的书评/短评/八卦/论战、已寄到的私信、读者来信、剪报。计划中、传言中的不算，可以写进 rumors。
3. readings 收“某人已经读过某作品”但没有形成书面反响的情况（例如见面时谈起、信里说读过）。
4. 同一个人、刊物、作品全文只用一个名字；外文名放进 aliases / originalName。
5. 日期一律 YYYY-MM-DD。日期不精确时照样填一个代表日，同时填 datePrecision：day=精确到日，xun=只知道上/中/下旬（填该旬第一天），month=只知道月份（填该月 1 日），noLaterThan=只知道“不晚于”这一天（例如单行本至某日已售罄）。
6. 只输出一个 JSON 对象，不要任何解释文字。

如果内容很长，可以分几次输出，每次都是完整、合法的 JSON；我会依次导入，插件会按名字合并。
准备好了就回复“请发送聊天记录”。

插件里的“复制提示词”按钮会额外附上你已有的人物、刊物、作品名，让外部 AI 沿用同样的写法。
