/** Minimal markdown for the admin AI chat bubbles. The system prompt tells
 * the assistant it may use exactly **bold**, `code`, "- " bullets, and
 * [[Street Name]] links, so this renders only those. All input is HTML-escaped
 * first — the transforms below inject only our own tags, so the output is safe
 * for v-html. (Because escaping runs first, a street name is already entity-safe
 * by the time it lands in a data- attribute.) */
export function renderMarkdownLite(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

  const out: string[] = []
  let inList = false
  for (const line of escaped.split('\n')) {
    const bullet = /^\s*[-•]\s+(.*)$/.exec(line)
    if (bullet) {
      if (!inList) {
        out.push('<ul>')
        inList = true
      }
      out.push(`<li>${inline(bullet[1])}</li>`)
    } else {
      if (inList) {
        out.push('</ul>')
        inList = false
      }
      if (line.trim()) out.push(`<p>${inline(line)}</p>`)
    }
  }
  if (inList) out.push('</ul>')
  return out.join('')
}

/** [[Grove St]] — the assistant's cheapest way to hand over a place: four
 * extra characters in its output, and the chat view turns it into a button
 * that opens Scout with that street searched. Deliberately street-only — the
 * search matches across cities, so naming one would narrow nothing and only
 * cost prompt tokens to explain. A <button> rather than an <a> so it's
 * keyboard-reachable without inventing an href; AdminChatView delegates the
 * click, since v-html content can't carry @click. */
const STREET_LINK_RE = /\[\[([^\][\n]{2,60})\]\]/g

function inline(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(STREET_LINK_RE, (_m, street: string) => {
      const name = street.trim()
      return `<button type="button" class="street-link" data-street="${name}">${name}</button>`
    })
}
