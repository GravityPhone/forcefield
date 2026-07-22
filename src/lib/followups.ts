/** Parsing for the AI chat's ```followups trailer block. The system prompt
 * asks the assistant to end every reply with a JSON array of 3 suggested
 * next questions; the chat view strips the block from the displayed text and
 * renders the questions as tappable buttons. Absent/malformed block = no
 * suggestions, never an error. */

const BLOCK_RE = /```followups\s*\n?([\s\S]*?)```/g
const MAX_SUGGESTIONS = 3
const MAX_LENGTH = 120

export interface ParsedReply {
  text: string
  suggestions: string[]
}

export function extractFollowups(raw: string): ParsedReply {
  const suggestions: string[] = []
  const text = raw
    .replace(BLOCK_RE, (_match, body: string) => {
      try {
        const parsed: unknown = JSON.parse(body.trim())
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (typeof item === 'string' && item.trim()) {
              suggestions.push(item.trim().slice(0, MAX_LENGTH))
            }
          }
        }
      } catch {
        // Not valid JSON — drop the block silently rather than showing raw
        // machinery to the admin.
      }
      return ''
    })
    // A reply cut off by the token limit can end with an unclosed block —
    // never show that machinery to the admin.
    .replace(/```followups[\s\S]*$/, '')
    .trim()
  return { text, suggestions: suggestions.slice(0, MAX_SUGGESTIONS) }
}
