// Public source text only. The resulting strings must be rendered as text, never HTML.
const BLOCKS = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'BLOCKQUOTE',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'DL', 'DT', 'DD', 'TABLE']);
const IGNORE = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD']);

export function unescapeHtml(text: string): string {
  return text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/').replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_match, dec: string) => codePoint(Number(dec)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex: string) => codePoint(parseInt(hex, 16)));
}

function codePoint(value: number): string {
  return value > 0 && value <= 0x10FFFF ? String.fromCodePoint(value) : '\uFFFD';
}

export function htmlToPlaintext(rawHtml: string): string {
  if (!rawHtml) return '';
  let text = rawHtml;
  for (let i = 0; i < 5; i++) {
    const decoded = unescapeHtml(text);
    if (decoded === text) break;
    text = decoded;
  }
  // Template contents remain inert: no scripts execute or resources get attached to the page.
  const template = document.createElement('template');
  template.innerHTML = text;
  const parts: string[] = [];
  const visit = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) { parts.push(node.textContent ?? ''); return; }
    const tag = node instanceof Element ? node.tagName : '';
    if (IGNORE.has(tag)) return;
    if (BLOCKS.has(tag)) parts.push('\n\n');
    else if (tag === 'LI') parts.push('\n- ');
    else if (['BR', 'HR', 'TR'].includes(tag)) parts.push('\n');
    else if (['TD', 'TH'].includes(tag)) parts.push(' ');
    node.childNodes.forEach(visit);
    if (BLOCKS.has(tag)) parts.push('\n\n');
    else if (tag === 'TR') parts.push('\n');
    else if (['TD', 'TH'].includes(tag)) parts.push(' ');
  };
  visit(template.content);
  return parts.join('').replace(/\r\n/g, '\n').split('\n')
    .map(line => line.replace(/[^\S\n]+/g, ' ').trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n').trim()
    .replace(/^-[ \t]*\n+(?=[^\s-])/gm, '- ');
}

export function descriptionField(data: Record<string, unknown>, htmlKey: string, plainKey: string): string {
  const values = [htmlKey, plainKey].map(key => {
    const value = data[key];
    return typeof value === 'string' ? htmlToPlaintext(value) : '';
  });
  const rich = values[0] ?? '';
  const plain = values[1] ?? '';
  if (rich && plain) {
    const compactRich = rich.replace(/\s+/g, ' ').toLowerCase();
    const compactPlain = plain.replace(/\s+/g, ' ').toLowerCase();
    if (compactRich !== compactPlain && compactPlain.includes(compactRich)) return plain;
  }
  return rich || plain;
}

export function leverDescription(data: Record<string, unknown>): string {
  const parts = [descriptionField(data, 'description', 'descriptionPlain')];
  if (Array.isArray(data['lists'])) {
    for (const section of data['lists']) {
      if (typeof section !== 'object' || section === null) continue;
      const { text, content } = section as Record<string, unknown>;
      if (typeof content !== 'string' || !content.trim()) continue;
      if (typeof text === 'string' && text.trim()) parts.push(htmlToPlaintext(text));
      parts.push(htmlToPlaintext(content));
    }
  }
  parts.push(descriptionField(data, 'additional', 'additionalPlain'),
    descriptionField(data, 'salaryDescription', 'salaryDescriptionPlain'));
  return parts.filter(Boolean).join('\n\n');
}

export function smartRecruitersDescription(data: Record<string, unknown>): string {
  const jobAd = data['jobAd'];
  const sections = typeof jobAd === 'object' && jobAd !== null
    ? (jobAd as Record<string, unknown>)['sections'] : null;
  const legacy = data['jobDescription'];
  const legacySections = typeof legacy === 'object' && legacy !== null
    ? (legacy as Record<string, unknown>)['sections'] : null;
  const sources = [typeof sections === 'object' && sections !== null && !Array.isArray(sections)
    ? Object.values(sections) : [], legacySections];
  for (const source of sources) {
    if (!Array.isArray(source)) continue;
    const parts: string[] = [];
    for (const section of source) {
      if (typeof section !== 'object' || section === null) continue;
      const { title, text } = section as Record<string, unknown>;
      const body = typeof text === 'string' ? htmlToPlaintext(text) : '';
      if (!body) continue;
      if (typeof title === 'string' && title.trim()) parts.push(htmlToPlaintext(title));
      parts.push(body);
    }
    if (parts.length) return parts.join('\n\n');
  }
  return '';
}
