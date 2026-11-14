/**
 * Text preparation for speech synthesis: light Markdown cleanup and splitting
 * into request-sized pieces. The speech API also strips Markdown, but chunking
 * has to happen on text whose length we control.
 *
 * @module dsh-tts-mp3/lib/text
 */

/** Characters billed as two units, matching the API's Chinese-character rule. */
const WIDE = /[\u2e80-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/u

/** Count billed characters: wide (CJK) characters count 2, everything else 1. */
export function billedChars(text) {
  let total = 0
  for (const char of text) total += WIDE.test(char) ? 2 : 1
  return total
}

/**
 * Turn raw file or message text into speakable text: drop Markdown escapes and
 * code-fence markers, normalize whitespace, and collapse ragged blank lines.
 *
 * @param source - raw text, possibly Markdown.
 * @returns trimmed text with no fence markers and at most one blank line between blocks.
 */
export function normalizeSource(source) {
  if (typeof source !== 'string') return ''
  let text = source.replace(/\r\n?/g, '\n')
  // A literal "\#" or "\*" in a Markdown file means the character itself.
  text = text.replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, '$1')
  // Fence markers are structural; the code inside them is still speakable.
  text = text.replace(/^[ \t]*```[^\n]*$/gm, '')
  text = text.replace(/^[ \t]*>[ \t]?/gm, '')
  text = text.replace(/[ \t]+$/gm, '')
  text = text.replace(/\n{3,}/g, '\n\n')
  return text.trim()
}

/**
 * Split text into requests that each stay inside the billed-character budget,
 * preferring paragraph and sentence boundaries.
 *
 * @param text - normalized text.
 * @param budget - maximum billed characters per request.
 * @returns one or more non-empty pieces, in order.
 */
export function splitForRequests(text, budget) {
  if (billedChars(text) <= budget) return [text]

  const units = []
  for (const paragraph of text.split(/\n{2,}/)) {
    const trimmed = paragraph.trim()
    if (trimmed.length === 0) continue
    const sentences = trimmed.match(/[^。！？!?；;…\n]+[。！？!?；;…\n]*/gu)
    for (const sentence of sentences ?? [trimmed]) {
      const piece = sentence.trim()
      if (piece.length > 0) units.push(piece)
    }
  }

  const chunks = []
  let current = ''
  let currentChars = 0
  const flush = () => {
    const done = current.trim()
    if (done.length > 0) chunks.push(done)
    current = ''
    currentChars = 0
  }

  for (const unit of units) {
    const cost = billedChars(unit) + 1
    if (cost <= budget) {
      if (currentChars + cost > budget) flush()
      current += unit
      currentChars += cost
      continue
    }
    // A single sentence longer than the budget: cut it on character boundaries.
    flush()
    let piece = ''
    let pieceChars = 0
    for (const char of unit) {
      const charCost = WIDE.test(char) ? 2 : 1
      if (pieceChars + charCost > budget) {
        chunks.push(piece)
        piece = ''
        pieceChars = 0
      }
      piece += char
      pieceChars += charCost
    }
    if (piece.length > 0) chunks.push(piece)
  }
  flush()
  return chunks.length > 0 ? chunks : [text]
}
