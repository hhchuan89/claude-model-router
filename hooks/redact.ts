// Masks anything that looks like a credential before it is logged or sent for analysis.
const PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[REDACTED:private-key]'],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/g, '[REDACTED:anthropic-key]'],
  [/\bsk-(proj-)?[A-Za-z0-9_-]{20,}/g, '[REDACTED:openai-key]'],
  [/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/g, '[REDACTED:github-token]'],
  [/\bgithub_pat_[A-Za-z0-9_]{30,}/g, '[REDACTED:github-token]'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, '[REDACTED:slack-token]'],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, '[REDACTED:aws-key]'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[REDACTED:google-key]'],
  [/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g, '[REDACTED:telegram-bot-token]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[REDACTED:jwt]'],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{16,}/gi, '$1 [REDACTED]'],
  [/\b(0x)?[0-9a-fA-F]{64}\b/g, '[REDACTED:hex-secret]'],
  [
    /\b([A-Za-z_]*(api[_-]?key|secret|token|passw(or)?d|pwd)[A-Za-z_]*)(\s*[:=]\s*)(["']?)[^\s"']{6,}\5/gi,
    '$1$4$5[REDACTED]$5',
  ],
]

export function redact(text: string): string {
  return PATTERNS.reduce((out, [re, sub]) => out.replace(re, sub), text)
}
