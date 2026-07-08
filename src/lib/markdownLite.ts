/** Minimal markdown for the admin AI chat bubbles. The system prompt tells
 * the assistant it may use exactly **bold**, `code`, and "- " bullets, so
 * this renders only those. All input is HTML-escaped first — the transforms
 * below inject only our own tags, so the output is safe for v-html. */
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

function inline(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
}
