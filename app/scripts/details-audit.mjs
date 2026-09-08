// Offline inspection of public descriptions. No profile, network or feed mutations.
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import ts from 'typescript';

const app = fileURLToPath(new URL('../', import.meta.url));
const bytes = readFileSync(resolve(process.argv[2] ?? join(app, '../data/feed.json')));
const feed = JSON.parse(bytes);
const temporary = mkdtempSync(join(tmpdir(), 'nightjar-details-'));
const modules = ['classify/types', 'classify/role-taxonomy', 'classify/category-classifier',
  'details/types', 'details/sections', 'details/pay', 'details/graduation', 'details/extract'];
for (const folder of ['classify', 'details']) mkdirSync(join(temporary, folder));
try {
  for (const name of modules) {
    let code = ts.transpileModule(readFileSync(join(app, `src/${name}.ts`), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 },
    }).outputText;
    code = code.replace(/import (\w+) from '(.+\.json)';/g, (_, variable, path) =>
      `const ${variable} = ${readFileSync(join(app, 'src', dirname(name), path), 'utf8')};`);
    code = code.replace(/from '(\.\.?\/[^']+)';/g, "from '$1.mjs';");
    writeFileSync(join(temporary, `${name}.mjs`), code);
  }
  const { extractJobDetails, DETAILS_VERSION } = await import(pathToFileURL(join(temporary, 'details/extract.mjs')));
  const { compensationLabel } = await import(pathToFileURL(join(temporary, 'details/pay.mjs')));
  const { classifyCategory } = await import(pathToFileURL(join(temporary, 'classify/category-classifier.mjs')));
  const { CLASSIFICATION_VERSION } = await import(pathToFileURL(join(temporary, 'classify/role-taxonomy.mjs')));
  const report = { feed_sha256: createHash('sha256').update(bytes).digest('hex'),
    details_version: DETAILS_VERSION, classification_version: CLASSIFICATION_VERSION,
    active: 0, with_description: 0, by_ats: {}, invalid_offsets: 0,
    role_changes: 0, unclassified_before: 0, unclassified_after: 0, review: [] };
  const start = performance.now();
  for (const posting of Object.values(feed.postings)) {
    if (posting.closed_at) continue;
    report.active++;
    if (!posting.description_text) continue;
    report.with_description++;
    report.by_ats[posting.ats] = (report.by_ats[posting.ats] ?? 0) + 1;
    const context = { ...posting.source_metadata, company: posting.company,
      department: posting.department?.trim() || posting.source_metadata?.department };
    const before = classifyCategory(posting.title, null, posting.source_metadata?.category, context);
    const after = classifyCategory(posting.title, posting.description_text, posting.source_metadata?.category, context);
    const details = extractJobDetails(posting.description_text, {
      acquisition: posting.description_status ?? 'unknown',
      structuredCompensation: posting.source_metadata?.source_compensation,
      advertisedCompensation: posting.compensation,
    });
    if (before.category === 'other') report.unclassified_before++;
    if (after.category === 'other') report.unclassified_after++;
    if (JSON.stringify(before.category_tags) !== JSON.stringify(after.category_tags)) report.role_changes++;
    for (const evidence of Object.values(details.sections).flat()) {
      if (details.document.slice(evidence.start, evidence.end) !== evidence.text) report.invalid_offsets++;
    }
    report.review.push({ id: posting.id, title: posting.title, ats: posting.ats, url: posting.url,
      acquisition: details.acquisition, characters: details.document.length,
      before, after, pay_label: compensationLabel(details.compensation),
      sections: details.sections, compensation: details.compensation.ranges,
      authorization: details.authorization, graduation: details.graduation });
  }
  report.extraction_and_classification_ms = Math.round((performance.now() - start) * 100) / 100;
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} finally {
  for (const name of modules) {
    try { unlinkSync(join(temporary, `${name}.mjs`)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const folder of ['classify', 'details']) rmdirSync(join(temporary, folder));
  rmdirSync(temporary);
}
