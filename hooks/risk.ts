import type { Tier } from '../types'

// Whether a message asks for an irreversible or outward-facing action: push, merge, deploy, release, delete, a forced
// command, a write to production or a database, a pull request, a cherry-pick onto a shared branch, a message to people,
// or money. Plain code, no model: the classifier judges how much thinking the work needs, and this only keeps such an
// action off Haiku.
// It reads the masked message sentence by sentence, and each sentence part by part (at and / then / 然后 / 再 / 之后).
// It skips a part that only asks about one of these words ("what does git push do?"), reports one as done ("merged",
// "I pushed it already", "已经推送了"), or says not to do it ("don't push"). A miss leaves the classifier's tier as it
// was; a false alarm costs a lookup one Sonnet turn.

type Rule = { re: RegExp; zh?: true }

// Who or where a message goes.
const TO_PEOPLE = String.raw`(?:\b(?:slack|jira|confluence|teams|channel|thread|ticket|issue|prs?|pull[- ]request|customer|client|email|mail|team|everyone|him|her|them)\b|\s#[a-z0-9])`
// An instruction to message: the verb starts the part, or follows please/and/then/to/you, so "fix the error message in
// the ticket" or "send the request" does not count.
const MSG_START = String.raw`(?:^|\b(?:please|pls|and|then|to|you|now|also|go|just|so)\s+)`
const ZH_PROD = String.raw`(?:生产环境|生產環境|正式环境|正式環境|线上环境|線上環境|生产库|生產庫|正式库|正式庫|\bprod(?:uction)?\b)`
const ZH_ACT = String.raw`(?:执行|執行|运行|運行|跑|改|修改|更新|删|刪|清|部署|发布|發布|重启|重啟|写入|寫入|插入|迁移|遷移|回滚|回滾|操作)`

const rules: Rule[] = [
  // English verbs in their base form (and -s/-ing, and re-), so "pushed" or "merged" never match. A noun use ("the merge
  // conflicts", "the deploy log", "push notifications", "--merges") does not count.
  { re: /(?<!-)\b(?:force[- ]?push(?:es|ing)?|(?:re-?)?push(?:es|ing)?(?!\s+notifications?)|(?:re-?)?merg(?:e|es|ing)(?!\s+(?:conflicts?|commits?|requests?|base|markers?|strategy|queue|logs?))|(?:re-?)?deploy(?:s|ing)?(?!\s+(?:logs?|docs?|documentation|notes?|guide|history|status))|releas(?:e|es|ing)(?!\s+notes?\b)|delet(?:e|es|ing)|purg(?:e|es|ing)|wip(?:e|es|ing)|roll(?:s|ing)?\s+back)\b/ },
  { re: /\b(?:drop|truncate|alter)\s+(?:the\s+)?(?:table|database|db|column|index|schema|collection)s?\b|\brm\s+-[a-z]*[rf][a-z]*\b|--force\b|\breset\s+--hard\b/ },
  // SQL writes, and stored procedures run by name (exec sp_x, exec dbo.x, execute procedure x).
  { re: /\bupdate\s+[\w.[\]"`]+\s+set\b|\binsert\s+into\b|(?<!(?:docker|kubectl)\s)\bexec(?:ute)?\s+(?:proc(?:edure)?\s+\S|(?:\[?\w+\]?\.)?\[?u?sp_\w|\[?\w+\]?\.\[?\w)|(?<!(?:docker|kubectl)\s)\bexec\s+\[?[a-z]\w*_\w/ },
  { re: /\bterraform\s+(?:apply|destroy)\b|\b(?:npm|pnpm|yarn)\s+publish\b|\bgit\s+clean\s+-[a-z]*f|\bgit\s+branch\s+-[a-z]*d\b|\bdocker\s+(?:system\s+prune|(?:container\s+|image\s+|volume\s+)?(?:rm|rmi|prune))\b|\baws\s+s3\s+(?:rm|rb)\b/ },
  // Production only with an action on it: "show me the prod logs" is a lookup.
  { re: /\b(?:run|apply|execute|exec|migrate|restart|reboot|change|modify|update|write|edit|patch|set|fix|hotfix|seed|backfill|insert|remove|kill|scale|rotate|ship|deploy|redeploy|push|release|delete|drop|truncate|wipe|purge|reset|test)\b[^.?!\n]{0,40}\bprod(?:uction)?\b/ },
  { re: /\b(?:(?:open|create|raise|submit)\s+(?:up\s+)?(?:a|an|a\s+new|new)\s+(?:prs?|pull[- ]requests?|merge[- ]requests?)|(?:merge|decline|approve|close)\b[^.?!\n]{0,40}\b(?:prs?|pull[- ]requests?|merge[- ]requests?))\b|\b(?:create|raise|submit)\b[^.?!\n]{0,40}\b(?:prs?|pull[- ]requests?|merge[- ]requests?)\b/ },
  { re: /\bcherry[- ]?pick\b[^.?!\n]{0,60}\b(?:develop|main|master|staging|release|prod|production)\b/ },
  { re: new RegExp(`${MSG_START}(?:send|post|reply|comment|message|email|e-mail|notify|ping|dm|(?:add|leave|write)\\s+(?:a\\s+)?comment)\\b[^.?!\\n]{0,60}${TO_PEOPLE}`) },
  { re: new RegExp(`${MSG_START}(?:send|ship)\\s+(?:it|this|that)\\b|\\bship\\s+(?:it|this|that|them|the)\\b|\\bslack\\s+(?:him|her|them)\\b`) },
  { re: /\b(?:pay(?!\s+(?:attention|page|button|flow|form|screen|component|module|period))|refund|transfer\s+(?:the\s+)?(?:money|funds)|(?:make|send|process|approve|submit)\s+(?:a\s+|the\s+)?payment)\b/ },
  // Chinese, Simplified and Traditional. Without inflection, a report of something done is caught by 已/刚 just before
  // or 了/过 just after the word.
  { re: /推送|推上去|推上|推到|推吧|push\s*上去|强推|強推|强制推|強制推/, zh: true },
  { re: /合并|合併/, zh: true },
  { re: /(?:部署|上线|上線|发布|發布|發佈)(?!文档|文檔|说明|說明|日志|日誌|记录|記錄)|回滚|回滾|发版|發版|上传|上傳/, zh: true },
  { re: /删除|刪除|删掉|刪掉|删库|刪庫|清空/, zh: true },
  { re: new RegExp(`${ZH_ACT}[^，。！？\\n]{0,12}${ZH_PROD}|${ZH_PROD}[^，。！？\\n]{0,12}${ZH_ACT}`), zh: true },
  { re: /(?:开|開|提|建|创建|建立|合|发|發|提交)\s*(?:个|個|一个|一個)?\s*(?:pr|pull request|合并请求|合併請求)/, zh: true },
  // 回复 / 评论 / 留言 count with someone or somewhere to go to, so "这个 PR 的评论" or "请简短回复" does not.
  { re: /发送|發送|发给|發給|发到|發到|发消息|發訊息|发邮件|發郵件|(?:回复|回覆|回復|评论|評論|留言)(?=\s*(?:一下|下)?\s*(?:给|給|他|她|对方|對方|客户|客戶|用户|用戶|大家|团队|團隊|老板|老闆|同事|群|频道|頻道|邮件|郵件|工单|工單|这|這|那|[a-z@#]))|在[^，。！？\n]{1,20}(?:上|里|裡|下)\s*(?:评论|評論|留言|回复|回覆)/, zh: true },
  { re: /付款|转账|轉帳|轉賬|汇款|匯款|退款/, zh: true },
]

// A polite request is a request even when it ends in a question mark (请问 is "may I ask", not a request).
const REQUEST = /^(?:please|pls|can you|could you|would you|will you|go ahead)\b|请(?!问)|請(?!問)|帮我|幫我|麻烦|麻煩|能不能|可不可以|能否/
// A sentence that ends as a question, unless it is a polite request.
const TAIL = /[?？]$|[吗嗎呢][?？]?$/
// A part that asks about something, whatever it ends with. "when" only with a verb after it, so "when CI passes merge
// it" is an instruction.
const ASKS = /^(?:what|how|why|where|which|who|whose)\b|^when\s+(?:is|are|was|were|do|does|did|will|would|should|can|could|has|have)\b|^(?:does|did|is|are|was|were|should|shall|do\s+(?:i|you|we|they))\b|^(?:explain|tell me)\b|\b(?:tell me|explain)\s+(?:what|how|why|whether|if|when|where|which)\b|什么|什麼|甚麼|怎么|怎麼|如何|为什么|為什麼|为何|為何|哪(?!怕)|[几幾](?![个個位条條份项項张張])/
// Directly before the word: a negation (at most one word between), or a report of the same thing already done.
const NEGATED = /\b(?:don't|dont|do not|never|not|without|no need to)\s+(?:[a-z]+\s+)?$|\bstop\s+$|(?:不要|(?<![分特区區级級个個类類识識告性差派])[别別]|先不|不用|勿|无需|無需|不必)\s*(?:再|先|马上|馬上|直接)?\s*$/
const ALREADY_EN = /\balready\s+(?:[a-z]+\s+)?$/
const DONE_ZH_BEFORE = /(?:已经|已經|已|刚刚|剛剛|刚|剛)\s*$/
const DONE_ZH_AFTER = /^\s*(?:了|过|過|完了|好了)/
const LEAD = new Set(['please', 'pls', 'and', 'then', 'to', 'you', 'now', 'also', 'go', 'just', 'so', 'up', 're'])
const IRREGULAR: Record<string, string> = { send: 'sent', pay: 'paid', ship: 'shipped', drop: 'dropped', set: 'set', run: 'ran' }

// The same verb in the past tense just before the match ("merged, merge" is a report); a different verb is not
// ("the fix I pushed looks good so merge it").
function doneEn(before: string, matched: string): boolean {
  if (ALREADY_EN.test(before)) return true
  const verb = (matched.match(/[a-z]{2,}/g) ?? []).find(w => !LEAD.has(w))
  if (!verb) return false
  const base = verb.replace(/(?:es|s|ing)$/, '')
  const past = IRREGULAR[base] ?? `${base.replace(/e$/, '')}e?d`
  return new RegExp(`\\b(?:re-?)?${past}\\s+(?:[a-z]+\\s+)?$`).test(before)
}

// Sentences: split at sentence ends, commas and line breaks, in both scripts; the closing mark stays on the sentence.
function sentences(text: string): string[] {
  return text
    .toLowerCase()
    .split(/(?<=[.!?;,])\s+|(?<=[。！？；，、])\s*|\n+/)
    .map(s => s.trim().replace(/[\s，、,;；]+$/, ''))
    .filter(s => s !== '')
}

// Parts of a sentence: at and / then / 然后 / 之后, and at 再 unless a negation is just before it ("不要再推送").
function parts(sentence: string): string[] {
  return sentence
    .split(/\s+(?:and\s+then|and|then)\s+|然后|然後|之后(?!的)|之後(?!的)|(?<!不要|不用|不必|无需|無需|先不|别|別|不|勿)再/)
    .map(p => p.trim())
    .filter(p => p !== '')
}

function asks(c: string, rule: Rule): boolean {
  for (const m of c.matchAll(new RegExp(rule.re.source, 'g'))) {
    const before = c.slice(0, m.index)
    if (NEGATED.test(before)) continue
    if (rule.zh ? DONE_ZH_BEFORE.test(before) || DONE_ZH_AFTER.test(c.slice(m.index + m[0].length)) : doneEn(before, m[0])) continue
    return true
  }
  return false
}

export function isRisky(text: string): boolean {
  return sentences(text).some(s => {
    if (TAIL.test(s) && !REQUEST.test(s)) return false
    return parts(s).some(p => !ASKS.test(p) && rules.some(r => asks(p, r)))
  })
}

// A risky action runs on at least Sonnet: lookup becomes execute, and a higher tier is left as it is.
export function riskFloor(tier: Tier, risky: boolean): Tier {
  return risky && tier === 'lookup' ? 'execute' : tier
}
