/**
 * Slice 6: chunking. Pure string work, no I/O.
 *
 * Target is roughly 500 tokens per chunk with 50 tokens of overlap, using the
 * same ~4 chars/token heuristic as the router. Overlap exists so a sentence
 * that straddles a boundary appears whole in at least one chunk; without it,
 * the answer to a query can fall exactly into the gap between two chunks.
 */
const CHUNK_CHARS = 2000; // ~500 tokens
const OVERLAP_CHARS = 200; // ~50 tokens

export function chunkText(text: string): string[] {
  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + CHUNK_CHARS, text.length);

    // Prefer to cut at a newline instead of mid-sentence, but only if that
    // does not shrink the chunk below half size — a wall of text with no
    // newlines still has to terminate.
    if (end < text.length) {
      const lastBreak = text.lastIndexOf("\n", end);
      if (lastBreak > start + CHUNK_CHARS / 2) {
        end = lastBreak;
      }
    }

    const piece = text.slice(start, end).trim();
    if (piece.length > 0) {
      chunks.push(piece);
    }

    if (end >= text.length) {
      break;
    }
    start = end - OVERLAP_CHARS;
  }

  return chunks;
}
