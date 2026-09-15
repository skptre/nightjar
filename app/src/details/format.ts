// Structured, general rendering for job descriptions.
//
// Descriptions arrive as plain text with wildly varying structure. Rather than
// recognise a fixed list of known headings — which cannot survive unseen ones —
// this engine works from general signals in the *content* of each block:
//   • requirement language  ("must", "pursuing a degree", "experience with")
//   • duty / action language ("design", "build", "you will support")
//   • money / benefits       ("$", "salary", "stipend", "will vary")
//   • legal / EEO            ("equal opportunity", "without regard to", "E-Verify")
//   • tracking junk          ("#LI-DK1", bare hashtags, requisition ids)
//
// Headings are treated only as a weak hint, and the current section persists
// across unknown sub-headings. Boilerplate is removed by what it *is*, not where
// it sits, so trailing compensation/EEO text is dropped even when it inherits a
// "Qualifications" heading. Everything is deterministic and offline: no model.

export type BlockKind = 'heading' | 'paragraph' | 'list';

export type HeadingCategory =
  | 'role' | 'responsibilities' | 'qualifications' | 'exclude' | 'other';

export interface DescBlock {
  kind: BlockKind;
  text?: string;
  items?: string[];
  category: HeadingCategory;
}

export interface Highlights {
  blocks: DescBlock[];
  qualificationsMissing: boolean;
  authFlag: string | null;
}

// ── content signals (general, not tied to specific employers) ──────────────
// A block is a pay disclosure if it carries a dollar figure or explicit
// compensation vocabulary — this holds even when the sentence also references a
// degree or experience ("$55/hr for Bachelors", "will vary based on experience"),
// which is why it must not be gated behind the requirement signal.
const STRONG_MONEY = /\$\s?[\d,]|\b(?:pay|salary|compensation|hourly) (?:range|rate)\b|\bbase (?:pay|salary)\b|\bwill vary\b|\bper (?:hour|year)\b|\/\s?(?:hr|hour|yr|year)\b|\bannual(?:ized)? (?:base|salary|pay)\b|\bestimated (?:hourly|pay|salary|range|compensation)\b|\bcompensation\b|\bsalary\b/i;
const BENEFITS_SOFT = /\b(?:benefits?|401\(?k\)?|PTO|paid time off|health insurance|equity|perks|relocation|reimbursement|stipend)\b/i;
function isMoneyNoise(text: string): boolean {
  return STRONG_MONEY.test(text) || (BENEFITS_SOFT.test(text) && !REQ.test(text) && !DUTY.test(text));
}
const EEO = /\bequal (?:employment )?opportunity\b|without regard to|\bE-?Verify\b|protected veteran|anti-?discrimination|reasonable accommodation|\bEEO\b|diversity,? (?:and )?(?:equity|inclusion)|committed to (?:creating|building|fostering|a )[^.]*\b(?:diverse|inclusive)\b|qualified applicants will receive|we (?:celebrate|value|embrace) (?:diversity|differences)|regardless of (?:race|gender|religion)|drug[- ]free workplace|background check|diversity drives|diverse perspectives|inclusive (?:culture|environment|workplace)|sense of belonging/i;
const TRACK = /^#[A-Za-z][\w-]*$|#LI-[A-Za-z0-9]+|\brequisition (?:id|number|#)|\bjob id\b|\bR\d{4,}\b|^\s*ID[:#]/i;
const REQ = /\b(?:must|required|minimum|pursuing|enrolled|currently (?:a |an )?(?:junior|senior|student|enrolled)|bachelor|master|ph\.?d|degree|years? of|experience (?:with|in|building|working)|proficien\w+|familiar(?:ity)?|ability to|strong [\w /]{0,24}skills?|comfortable (?:with|using|working)|knowledge of|background in|coursework|juniors? or seniors?|graduating|expected graduation|able to|you (?:have|are)|we require|understanding of|passion for|track record)\b/i;
const DUTY = /^\s*(?:you(?:'|’)?ll |we(?:'|’)?ll |help(?:ing)? |support(?:ing)? |design|develop|build|create|implement|test|collaborat|document|analy[sz]e|research|maintain|work(?:ing)? (?:with|on|along)|contribut|drive|own(?:ing)? |prototyp|integrat|communicat|assist|coordinat|improv|deliver|writ|conduct|perform|iterat|enabl|lead|manage|partner|participat|explor|identif|ensur|debug|ship|architect|optimi[sz]e)/i;
const ROLE_INTRO = /\b(?:as an? [\w ,/&-]{0,40}?\b(?:intern|engineer|analyst|scientist|researcher|associate|developer|designer|role)|you(?:'|’)?ll (?:work|join|be|help|gain|own|architect|design|build|learn|contribute|spend)|you will (?:work|join|be|help|gain|own|architect|design|build|learn|contribute)|in this (?:role|internship|position)|we(?:'|’)?re looking for|we are (?:looking for|seeking|hiring)|this (?:role|position|internship|team) (?:is|will|offers|sits))\b/i;
const COMPANY = /\b(?:is (?:the |a |an )?(?:leading|world(?:'|’)?s|largest|#1|global|premier)|founded (?:in|by)|headquarter|backed by|our mission is|we are building|we(?:'|’)?re building|our investors|series [A-E]\b|raised \$|customers include|our (?:customers|clients) (?:include|are)|we (?:design|manufacture|operate|build) [\w ,/-]{0,40}(?:in-house|at scale))\b/i;
// Work-authorization / export-control legalese. A concise, reworded flag stands
// in for this in Highlights, so the raw paragraph is dropped there (kept in full).
const AUTH_LEGAL = /\bitar\b|export[- ](?:control|regulation|license)|u\.?s\.? government export|department of state|\bu\.?s\.? citizens?\b|\bcitizenship\b|permanent resident|green card|lawful permanent|\bu\.?s\.? persons?\b|refugee under|asylee|8 u\.?s\.?c|security clearance|authorized to work|work authorization|visa sponsorship|export[- ]controlled|sponsorship (?:is )?(?:not|un)available/i;
// Program logistics, cohort dates and application/interview process — never a
// role, responsibility or qualification, so excluded from Highlights.
const TIMING_PROCESS = /\bapply early\b|rolling interview|first-come|reach(?:es)? capacity|as soon as possible|reviewed before|interview slots?|upcoming cohorts?|term opportunities|cohort availability|application (?:review|process|deadline|receipt|window)|typical projects|projects (?:include|you (?:may|might|will|could) work on)|^(?:fall|spring|summer|winter)\s+\d{4}\b/i;
// SMS / text-messaging consent boilerplate (TCPA disclosures). Companies append
// a whole opt-in/opt-out script — "reply STOP", "message and data rates may
// apply", the privacy-policy footer — that inherits the qualifications heading
// and leaks into Highlights. This is legal consent copy, never a requirement.
const SMS_CONSENT = /\bSMS\b|\btext messag\w*|\btexting\b|\bopt(?:ed)?[- ]?(?:in|out|back in)\b|\breply(?:ing)?\b[^.]{0,60}\b(?:STOP|HELP|START|YES|UNSTOP|UNSUBSCRIBE|CANCEL|QUIT|END|REVOKE)\b|message (?:and|&) data rates|message frequency|carriers? are not liable|industry[- ]standard keywords|recruiting (?:sms|text) messages|\bprivacy policy\b|wireless (?:carrier|provider)/i;
// A bare opt-out keyword on its own bullet ("STOP", "END", "YES", "UNSUBSCRIBE").
const SMS_KEYWORD = /^(?:stop|stopall|opt[- ]?out|cancel|end|quit|unsubscribe|revoke|start|unstop|yes|help)$/i;
function isSmsConsent(text: string): boolean {
  return SMS_CONSENT.test(text) || SMS_KEYWORD.test(text.trim());
}

// heading hints (checked in order; role before company keeps "About the role")
// Note: these use a leading word boundary and stem prefixes, but no trailing
// boundary — "responsibilit", "qualificat" and "requirement" must still match
// their plural forms ("Responsibilities", "Qualifications", "Requirements").
const ROLE_H = /\b(?:about (?:the|this) (?:role|position|job|internship)|the role\b|role overview|role summary|the opportunity|position summary|^overview$|the position|what you(?:'|’)?ll be working on)/i;
const RESP_H = /\b(?:responsibilit|what you(?:'|’)?ll (?:do|be doing|work on)|how you(?:'|’)?ll (?:make an impact|contribute|spend)|in this role|day.to.day|duties|key (?:responsibilit|duties)|the impact you|what you will do|your impact)/i;
const QUAL_H = /\b(?:qualificat|requirement|what (?:you(?:'|’)?ll|we(?:'|’)?re looking|makes you)|who you are|you(?:'|’)?ll (?:have|need|bring)|what you bring|your background|skills|experience (?:&|and) |even better|nice[- ]to[- ]have|bonus|preferred|desired|minimum|basic qualif|eligibility|looking for|candidates? who|what we(?:'|’)?re after|must have)/i;
// Legal / authorization headings must resolve before QUAL_H, since "ITAR
// Requirements" and "Work Authorization" otherwise match "requirement".
const LEGAL_H = /\b(?:itar|export control|work authorization|authorization requirement|visa|sponsorship|citizenship|security clearance|e-?verify|equal (?:employment )?opportunity|\beeo\b|legal|disclaimer)\b/i;
const EXCLUDE_H = /\b(?:about (?:us|our|the team|the company|[a-z]+ ?$)|who we are|our (?:mission|story|values|culture|team|company|program|process)|why (?:join|work|us)|compensation|salary|\bpay\b|benefits|perks|what we offer|what you(?:'|’)?ll (?:gain|get)|equal (?:employment )?opportunity|\beeo\b|e-?verify|legal|disclaimer|diversity|life at|our benefits|accommodation|internship program|application (?:review|process|window|instructions)|how to apply|important dates|timeline|program (?:details|dates|overview|runs)|what to expect|hiring process|interview process|selection process|next steps|projects you (?:may|might|will|could) work on|typical projects|example projects)/i;

function headingHint(text: string): HeadingCategory | null {
  if (LEGAL_H.test(text)) return 'exclude';
  if (ROLE_H.test(text)) return 'role';
  if (RESP_H.test(text)) return 'responsibilities';
  // Exclude (benefits, perks, program, process…) is tested before qualifications
  // so a heading like "Workplace Experience & Perks" is not caught by the loose
  // "experience &" qualifications cue.
  if (EXCLUDE_H.test(text)) return 'exclude';
  if (QUAL_H.test(text)) return 'qualifications';
  return null;
}

const BULLET = /^\s*(?:[-–—•*▪·◦‣▸►]|\d+[.)]|[a-z][.)])\s+(.*\S)\s*$/i;
const EMPTY_BULLET = /^\s*[-–—•*▪·◦‣▸►]\s*$/;

function isBullet(line: string): boolean {
  return BULLET.test(line) || EMPTY_BULLET.test(line);
}

// A heading is a short standalone line that does not read as a sentence: a
// trailing colon strongly signals one; sentence punctuation rules it out; a
// title-cased short line before content is accepted. No keyword list required.
function isHeading(line: string, next: string | null): boolean {
  const text = line.trim();
  if (!text || isBullet(line)) return false;
  const words = text.split(/\s+/).length;
  if (words > 12 || text.length > 80) return false;
  if (/:\s*$/.test(text)) return true;
  if (/[.!?;,]\s*$/.test(text)) return false;
  if (headingHint(text) !== null) return true;
  // Title-ish line (most words start uppercase) directly followed by content.
  const significant = text.replace(/[^A-Za-z0-9 ]/g, '').split(/\s+/).filter(Boolean);
  const capical = significant.filter(w => /^[A-Z0-9]/.test(w)).length;
  if (next !== null && significant.length > 0 && capical / significant.length >= 0.6
    && (isBullet(next) || /^[A-Z]/.test(next))) return true;
  return false;
}

function sanitize(text: string): string {
  let out = text.replace(/\r\n?/g, '\n');
  out = out.replace(/\[([^\]]+)]\((?:https?:|mailto:)[^)]*\)/gi, '$1'); // md links → label
  out = out.replace(/\bhttps?:\/\/\S+/gi, '');
  out = out.replace(/\bwww\.\S+/gi, '');
  out = out.replace(/\b[\w.+-]+@[\w.-]+\.\w{2,}\b/gi, '');
  out = out.replace(/#LI-[A-Za-z0-9]+/gi, '');          // LinkedIn tracking tags
  out = out.replace(/(?:\bread\s+more\b[ \t]*)+/gi, ''); // "Read more Read more" artifact
  const lines = out.split('\n');
  const kept: string[] = [];
  let prevSignificant = '';
  for (const raw of lines) {
    const line = raw.replace(/[ \t]+$/, '');
    const trimmed = line.trim();
    if (/^#[A-Za-z][\w-]*$/.test(trimmed)) continue;    // bare hashtag line
    if (/^(?:apply now|click here|see (?:more|less)|show (?:more|less)|read less|learn more)$/i.test(trimmed)) continue;
    // Drop a line identical to the previous non-blank one (e.g. "Thought process" twice).
    if (trimmed && trimmed.toLowerCase() === prevSignificant) continue;
    if (trimmed) prevSignificant = trimmed.toLowerCase();
    kept.push(line);
  }
  return kept.join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Parse plain text into ordered blocks (headings, paragraphs, grouped lists). */
export function formatDescription(raw: string | null | undefined): DescBlock[] {
  if (!raw) return [];
  const text = sanitize(raw);
  if (!text) return [];
  const lines = text.split('\n');

  const blocks: DescBlock[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length) { blocks.push({ kind: 'paragraph', text: paragraph.join(' ').trim(), category: 'other' }); paragraph = []; }
  };
  const flushList = (): void => {
    if (list.length) { blocks.push({ kind: 'list', items: list.slice(), category: 'other' }); list = []; }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    let next: string | null = null;
    for (let j = i + 1; j < lines.length; j++) { if (lines[j]!.trim()) { next = lines[j]!.trim(); break; } }

    if (!trimmed) { flushParagraph(); continue; }
    if (isHeading(line, next)) {
      flushParagraph(); flushList();
      blocks.push({ kind: 'heading', text: trimmed.replace(/:\s*$/, ''), category: 'other' });
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet) { flushParagraph(); list.push(bullet[1]!.trim()); continue; }
    if (EMPTY_BULLET.test(line)) continue;
    flushList();
    paragraph.push(trimmed);
  }
  flushParagraph();
  flushList();
  return blocks;
}

/**
 * For display: drop headings that have no content before the next heading (a
 * stray "Thought process" label, or a parent heading immediately followed by a
 * sub-heading). Section labelling keeps the full block list; this is cosmetic.
 */
export function pruneHeadings(blocks: DescBlock[]): DescBlock[] {
  return blocks.filter((block, index) => {
    if (block.kind !== 'heading') return true;
    const following = blocks[index + 1];
    return following !== undefined && following.kind !== 'heading';
  });
}

// ── semantic labelling of content blocks ───────────────────────────────────
function itemIsNoise(text: string): boolean {
  return TRACK.test(text) || EEO.test(text) || AUTH_LEGAL.test(text) || TIMING_PROCESS.test(text) || isSmsConsent(text) || isMoneyNoise(text);
}

function labelBlock(block: DescBlock, declared: HeadingCategory): HeadingCategory {
  const text = block.text ?? (block.items ?? []).join('\n');
  if (block.kind === 'paragraph') {
    if (TRACK.test(text.trim()) || EEO.test(text) || AUTH_LEGAL.test(text) || TIMING_PROCESS.test(text) || isSmsConsent(text) || isMoneyNoise(text)) return 'exclude';
    if (ROLE_INTRO.test(text) && !COMPANY.test(text)) return 'role';
    if (COMPANY.test(text) && !ROLE_INTRO.test(text)) return 'exclude';
    if (declared === 'role') return 'role';
    // Responsibilities and qualifications are bulleted; a bare prose paragraph
    // there is almost always boilerplate (legal, comp footnote) unless it clearly
    // states a duty or a requirement.
    if (declared === 'responsibilities' || declared === 'qualifications') {
      return REQ.test(text) || DUTY.test(text) ? declared : 'exclude';
    }
    return 'exclude';
  }
  // list: vote requirement vs duty over the meaningful (non-noise) items only
  const items = (block.items ?? []).filter(item => !itemIsNoise(item));
  if (!items.length) return 'exclude';
  let req = 0, duty = 0;
  for (const item of items) { if (REQ.test(item)) req++; if (DUTY.test(item)) duty++; }
  if (req > duty) return 'qualifications';
  if (duty > req) return 'responsibilities';
  return declared === 'role' || declared === 'responsibilities' || declared === 'qualifications' ? declared : 'exclude';
}

const AUTH_REQUIREMENT = /\b(?:itar|export[- ]control|active (?:security )?clearance|(?:must|required to) (?:be|hold|possess|obtain)[^.]{0,40}\b(?:clearance|u\.?s\.?\s+citizen|citizenship|us person)|only (?:hire|employ)[^.]{0,40}\b(?:u\.?s\.?\s+persons?|citizens?)|must be (?:a )?(?:u\.?s\.?|united states) (?:citizen|person))\b/i;

const CANON_LABEL: Record<'role' | 'responsibilities' | 'qualifications', string> = {
  role: 'The role', responsibilities: 'Responsibilities', qualifications: 'Qualifications',
};

/**
 * Build consistent Highlights: exactly the role, responsibilities and
 * qualifications, each under a canonical heading, with company marketing,
 * compensation, benefits, legal/EEO text and tracking junk removed by content —
 * regardless of the source's own headings. Bullet text is preserved verbatim.
 */
export function buildHighlights(blocks: DescBlock[]): Highlights {
  const buckets: Record<'role' | 'responsibilities' | 'qualifications', DescBlock[]> = {
    role: [], responsibilities: [], qualifications: [],
  };
  let declared: HeadingCategory = 'other';

  for (const block of blocks) {
    if (block.kind === 'heading') {
      const hint = headingHint(block.text ?? '');
      if (hint) declared = hint; // unknown sub-headings keep the current section
      continue;
    }
    const label = labelBlock(block, declared);
    if (label !== 'role' && label !== 'responsibilities' && label !== 'qualifications') continue;
    if (block.kind === 'list') {
      const items = (block.items ?? []).filter(item => !itemIsNoise(item));
      if (items.length) buckets[label].push({ kind: 'list', items, category: label });
    } else if (block.text) {
      buckets[label].push({ kind: 'paragraph', text: block.text, category: label });
    }
  }

  const out: DescBlock[] = [];
  for (const key of ['role', 'responsibilities', 'qualifications'] as const) {
    const group = buckets[key];
    if (!group.length) continue;
    out.push({ kind: 'heading', text: CANON_LABEL[key], category: key });
    // Merge adjacent lists into one so a section reads as a single list.
    for (const block of group) {
      const last = out[out.length - 1];
      if (block.kind === 'list' && last && last.kind === 'list') {
        last.items = [...(last.items ?? []), ...(block.items ?? [])];
      } else {
        out.push(block);
      }
    }
  }

  const qualificationsMissing = buckets.qualifications.length === 0;
  const joined = blocks.map(b => b.text ?? (b.items ?? []).join(' ')).join('\n');
  const authFlag = AUTH_REQUIREMENT.test(joined)
    ? 'May require U.S. citizenship or a green card — see the full description.'
    : null;

  return { blocks: out, qualificationsMissing, authFlag };
}
