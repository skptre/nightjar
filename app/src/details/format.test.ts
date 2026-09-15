import { describe, expect, it } from 'vitest';
import { formatDescription, buildHighlights } from './format';

const cats = (blocks: ReturnType<typeof formatDescription>): string[] => blocks.map(b => b.category);
const text = (blocks: ReturnType<typeof formatDescription>): string =>
  blocks.map(b => b.text ?? (b.items ?? []).join(' | ')).join('\n');

describe('formatDescription', () => {
  it('groups bullets separated by blank lines into a single list', () => {
    const blocks = formatDescription('Responsibilities\n\n- One\n\n- Two\n\n- Three');
    const lists = blocks.filter(b => b.kind === 'list');
    expect(lists).toHaveLength(1);
    expect(lists[0]!.items).toEqual(['One', 'Two', 'Three']);
  });

  it('strips the "Read more" acquisition artifact and bare URLs', () => {
    const blocks = formatDescription('We build drones. Read more Read more\n\nSee https://example.com/apply for details.');
    expect(text(blocks)).not.toMatch(/read more/i);
    expect(text(blocks)).not.toMatch(/https?:\/\//);
  });

  it('detects unmarked headings that precede content', () => {
    const blocks = formatDescription('About the role\n\nWe need an intern.\n\nBasic Qualifications\n\n- A degree');
    expect(blocks[0]).toMatchObject({ kind: 'heading', text: 'About the role' });
    expect(blocks.filter(b => b.kind === 'heading').map(b => b.text)).toContain('Basic Qualifications');
  });

  it('drops a stray empty bullet marker', () => {
    const blocks = formatDescription('Basic Qualifications\n\n-\n\n- Real requirement');
    const list = blocks.find(b => b.kind === 'list');
    expect(list!.items).toEqual(['Real requirement']);
  });
});

describe('buildHighlights', () => {
  const SKYDIO = `Skydio is the world leader in autonomous flight.\n\nAbout the role\n\nSkydio is looking for an intern to join the Hardware team.\n\nHow you'll make an impact\n\n- Support hardware programs\n\n- Maintain schedules\n\nWhat makes you a good fit\n\n- Pursuing a bachelor's or master's degree in engineering`;

  const SIERRA = `About us\n\nAt Sierra, we're building a platform for customer experiences with AI.\n\nAs a Software Engineer Intern, you'll work directly on production AI agents.\n\nWhat you'll bring\n\n- Pursuing a degree in computer science\n\nIntern qualifications\n\n- The intern program is open to students graduating December 2027 - June 2028\n\nOur values\n\n- Trust: we build trust with our customers`;

  it('keeps role, responsibilities and qualifications; drops company marketing', () => {
    const hl = buildHighlights(formatDescription(SKYDIO));
    expect(cats(hl.blocks)).not.toContain('company');
    expect(hl.blocks.some(b => b.category === 'role')).toBe(true);
    expect(hl.blocks.some(b => b.category === 'responsibilities')).toBe(true);
    expect(hl.blocks.some(b => b.category === 'qualifications')).toBe(true);
    expect(hl.qualificationsMissing).toBe(false);
  });

  it('recovers an unlabeled role paragraph and preserves the graduation line verbatim while dropping values', () => {
    const hl = buildHighlights(formatDescription(SIERRA));
    expect(hl.blocks[0]).toMatchObject({ kind: 'heading', category: 'role' });
    expect(text(hl.blocks)).toContain("you'll work directly on production AI agents");
    expect(text(hl.blocks)).toContain('graduating December 2027 - June 2028');
    expect(text(hl.blocks)).not.toMatch(/we build trust/i);
  });

  it('flags qualifications as missing when no requirements section exists', () => {
    const hl = buildHighlights(formatDescription('About the role\n\nYou will build things.\n\nResponsibilities\n\n- Do work'));
    expect(hl.qualificationsMissing).toBe(true);
  });

  it('returns empty highlights for short unstructured text so the UI can fall back to full', () => {
    const hl = buildHighlights(formatDescription('Build aircraft engines.'));
    expect(hl.blocks).toHaveLength(0);
  });

  it('drops SMS/text-messaging consent boilerplate while keeping real qualifications', () => {
    const ASTRANIS = [
      'Qualifications',
      '',
      "- Currently pursuing a B.S. in either mechanical, aerospace, or an equivalent technical degree",
      '- Experience with SolidWorks',
      '- Experience with GD&T and engineering drawings',
      '- When you opt in to receive SMS messages from Astranis Space Technologies Corp., we may send you messages related to your job application',
      '- You can cancel the SMS service at any time by replying with any of the following industry standard keywords:',
      '- STOP',
      '- STOPALL',
      '- OPTOUT',
      '- CANCEL',
      '- END',
      '- QUIT',
      '- UNSUBSCRIBE',
      '- REVOKE',
      '- For help, reply HELP or contact us at EMAIL or PHONE NUMBER',
      '- Carriers are not liable for delayed or undelivered messages.',
      '- Message and data rates may apply. Message frequency may vary. Contact your wireless provider for details.',
      '- For more information on how we handle your data, please review our Privacy Policy at:',
    ].join('\n');
    const hl = buildHighlights(formatDescription(ASTRANIS));
    const body = text(hl.blocks);
    expect(body).toContain('SolidWorks');
    expect(body).toContain('GD&T');
    expect(body).not.toMatch(/SMS/i);
    expect(body).not.toMatch(/opt in/i);
    expect(body).not.toMatch(/UNSUBSCRIBE/);
    expect(body).not.toMatch(/data rates/i);
    expect(body).not.toMatch(/privacy policy/i);
    expect(body).not.toMatch(/carriers are not liable/i);
  });

  it('raises an auth flag only for a real requirement, not EEO boilerplate', () => {
    const eeo = buildHighlights(formatDescription("Qualifications\n\n- A degree\n\nWe hire without regard to race, gender, or citizenship."));
    expect(eeo.authFlag).toBeNull();
    const itar = buildHighlights(formatDescription('Qualifications\n\n- A degree\n\nThis role is subject to ITAR; must be a U.S. citizen.'));
    expect(itar.authFlag).not.toBeNull();
  });
});
