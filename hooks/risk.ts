import type { Tier } from '../types'

// Whether a message asks for an irreversible or outward-facing action: push, merge, deploy, release, delete, a forced
// command, production, a pull request, a cherry-pick onto a shared branch, a message to people, or money. Plain code, no
// model: the classifier judges how much thinking the work needs, and this only keeps such an action off Haiku.
// It reads the masked message clause by clause and skips a clause that only asks about one of these words ("what does
// git push do?"), reports one as done ("merged", "I pushed it already", "已经推送了"), or says not to do it ("don't
// push"). A miss leaves the classifier's tier as it was; a false alarm costs a lookup one Sonnet turn.

type Rule = { re: RegExp; zh?: true }

const rules: Rule[] = [
  // English verbs in their base form (and -s/-ing), so "pushed" or "merged" never match.
  { re: /\b(?:force[- ]?push(?:es|ing)?|push(?:es|ing)?(?!\s+notifications?)|merg(?:e|es|ing)|deploy(?:s|ing)?|releas(?:e|es|ing)(?!\s+notes?\b)|delet(?:e|es|ing)|purg(?:e|es|ing)|wip(?:e|es|ing)|roll(?:s|ing)?\s+back)\b/ },
  { re: /\b(?:drop|truncate)\s+(?:the\s+)?(?:table|database|db|column|index|schema|collection)s?\b|\brm\s+-[a-z]*[rf][a-z]*\b|--force\b|\breset\s+--hard\b/ },
  { re: /\bprod(?:uction)?\b/ },
  { re: /\b(?:open|create|raise|submit|merge|decline|approve|close)\b[^.?!\n]{0,40}\b(?:prs?|pull[- ]requests?|merge[- ]requests?)\b/ },
  { re: /\bcherry[- ]?pick\b[^.?!\n]{0,60}\b(?:develop|main|master|staging|release|prod|production)\b/ },
  // A message to people: the verb as an instruction (it starts the clause, or follows please/and/then/to/you) and somewhere
  // it goes, so "fix the error message in the ticket" or "send the request" does not count.
  { re: /(?:^|\b(?:please|pls|and|then|to|you|now|also|go)\s+)(?:send|post|reply|comment|message|email|e-mail|notify|ping|dm|(?:add|leave|write)\s+(?:a\s+)?comment)\b[^.?!\n]{0,60}\b(?:slack|jira|confluence|teams|channel|thread|ticket|issue|prs?|pull[- ]request|customer|client|email|mail|team|everyone|him|her|them)\b/ },
  { re: /\b(?:pay(?!\s+attention)|refund|transfer\s+(?:the\s+)?(?:money|funds)|(?:make|send|process|approve|submit)\s+(?:a\s+|the\s+)?payment)\b/ },
  // Chinese, Simplified and Traditional. Without inflection, a report of something done is caught by 已/刚 before or
  // 了/过 after the word.
  { re: /推送|推上去|推上|推到|push\s*上去|强推|強推|强制推|強制推/, zh: true },
  { re: /合并|合併/, zh: true },
  { re: /部署|上线|上線|发布|發布|發佈|回滚|回滾/, zh: true },
  { re: /删除|刪除|删掉|刪掉|删库|刪庫|清空/, zh: true },
  { re: /生产环境|生產環境|正式环境|正式環境|线上环境|線上環境/, zh: true },
  { re: /(?:开|開|提|建|创建|建立|合|发|發|提交)\s*(?:个|個|一个|一個)?\s*(?:pr|pull request|合并请求|合併請求)/, zh: true },
  { re: /发送|發送|发给|發給|发到|發到|发消息|發訊息|发邮件|發郵件|回复|回覆|回復|留言|评论|評論/, zh: true },
  { re: /付款|转账|轉帳|轉賬|汇款|匯款|退款/, zh: true },
]

// A polite request is a request even when it ends in a question mark.
const REQUEST = /^(?:please|pls|can you|could you|would you|will you|go ahead)\b|请|請|帮我|幫我|麻烦|麻煩|能不能|可不可以|能否/
const QUESTION = /[?？]$|^(?:what|how|why|when|where|which|who|whose|does|did|is|are|was|were|should|shall|explain|tell me|do (?:i|you|we|they))\b|什么|什麼|甚麼|怎么|怎麼|如何|为什么|為什麼|为何|為何|[吗嗎呢]$/
// Just before the word: a negation, or (English) a report of the same thing already done.
const NEGATED = /\b(?:don't|dont|do not|never|not|without|no need to|stop)\b[^.?!\n]{0,20}$|(?:不要|别|別|先不|不用|勿|无需|無需|不必)\S{0,6}$/
const DONE_EN = /\b(?:already|deployed|pushed|merged|released|deleted|sent|posted|shipped)\b/
const DONE_ZH_BEFORE = /(?:已经|已經|已|刚刚|剛剛|刚|剛)\S{0,2}$/
const DONE_ZH_AFTER = /^\s*(?:了|过|過|完了|好了)/

// Clauses: split at sentence ends, commas and line breaks, in both scripts.
function clauses(text: string): string[] {
  return text
    .toLowerCase()
    .split(/(?<=[.!?;,])\s+|[，、。！？；]|\n+/)
    .map(c => c.trim())
    .filter(c => c !== '')
}

function asks(c: string, rule: Rule): boolean {
  for (const m of c.matchAll(new RegExp(rule.re.source, 'g'))) {
    const before = c.slice(0, m.index)
    if (NEGATED.test(before)) continue
    if (rule.zh ? DONE_ZH_BEFORE.test(before) || DONE_ZH_AFTER.test(c.slice(m.index + m[0].length)) : DONE_EN.test(before)) continue
    return true
  }
  return false
}

export function isRisky(text: string): boolean {
  return clauses(text).some(c => (REQUEST.test(c) || !QUESTION.test(c)) && rules.some(r => asks(c, r)))
}

// A risky action runs on at least Sonnet: lookup becomes execute, and a higher tier is left as it is.
export function riskFloor(tier: Tier, risky: boolean): Tier {
  return risky && tier === 'lookup' ? 'execute' : tier
}
