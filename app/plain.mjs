// plain.mjs - take the Markdown out of a payload that is going into a form.
//
// The result roles are told to write plain text, and mostly they do. "Mostly" is not good
// enough for something the person pastes without reading every character: a form that has
// no Markdown renderer shows `**like this**` with the asterisks, and the person has to
// clean it up by hand — which is exactly the work the payload was supposed to save.
//
// So the instruction is the first line of defence and this is the second. It is deliberately
// conservative. Asterisks inside code are content, not formatting, so fenced blocks and
// indented blocks are copied through untouched.
const FENCE = /^\s*(```|~~~)/;

/** Is this line part of a fenced or indented code block? */
function* classify(lines) {
  let fenced = false;
  for (const line of lines) {
    if (FENCE.test(line)) { fenced = !fenced; yield [line, true]; continue; }
    // Four spaces or a tab is an indented code block in every Markdown dialect.
    yield [line, fenced || /^(?: {4}|\t)/.test(line)];
  }
}

/**
 * Strip Markdown emphasis and structure markers, leaving the words.
 *
 * What it removes, outside code: paired ** __ * _ emphasis, heading hashes, blockquote
 * markers, and backticks around a short span. What it rewrites: * and + bullets become -.
 * What it never touches: anything inside a code fence or an indented block, and a bare
 * asterisk that is not part of a pair (a footnote marker, a glob, a multiplication sign).
 */
export function plainText(s) {
  if (!s) return s;
  const out = [];
  for (const [line, isCode] of classify(String(s).split('\n'))) {
    if (isCode) { out.push(line); continue; }
    let t = line;
    // Paired emphasis first, longest marker first so ** is not eaten as two *.
    t = t.replace(/\*\*\*(\S(?:[^*]*\S)?)\*\*\*/g, '$1');
    t = t.replace(/\*\*(\S(?:[^*]*\S)?)\*\*/g, '$1');
    t = t.replace(/__(\S(?:[^_]*\S)?)__/g, '$1');
    // Single-character emphasis, but only when it wraps a span on one line. A lone
    // asterisk with no partner is left where it is: it is probably content.
    t = t.replace(/(^|[\s(])\*(\S(?:[^*]*\S)?)\*(?=[\s.,;:!?)]|$)/g, '$1$2');
    t = t.replace(/(^|[\s(])_(\S(?:[^_]*\S)?)_(?=[\s.,;:!?)]|$)/g, '$1$2');
    // A short backticked span reads better as itself. Anything long is likely a snippet
    // that someone will copy, so leave its delimiters alone.
    t = t.replace(/`([^`\n]{1,60})`/g, '$1');
    // Structure markers.
    t = t.replace(/^(\s*)#{1,6}\s+/, '$1');
    t = t.replace(/^(\s*)>\s?/, '$1');
    t = t.replace(/^(\s*)[*+]\s+/, '$1- ');
    out.push(t);
  }
  return out.join('\n');
}

/** What was removed, for a log line that says so rather than changing things silently. */
export function countMarkdown(before, after) {
  const marks = (s) => (String(s).match(/\*\*|__|^#{1,6}\s|^\s*[*+]\s/gm) || []).length;
  return Math.max(0, marks(before) - marks(after));
}
