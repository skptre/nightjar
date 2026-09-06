// Offline audit of public postings. No profile data, network, or feed mutations.
import { readFileSync, writeFileSync, mkdtempSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import ts from 'typescript';

const app = fileURLToPath(new URL('../', import.meta.url));
const feedPath = resolve(process.argv[2] ?? join(app, '../data/feed.json'));
const feedBytes = readFileSync(feedPath);
const feed = JSON.parse(feedBytes);
const temporary = mkdtempSync(join(tmpdir(), 'nightjar-classification-'));
const modules = ['types', 'role-taxonomy', 'category-classifier'];
try {
  for (const name of modules) {
    const source = readFileSync(join(app, `src/classify/${name}.ts`), 'utf8');
    let code = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 },
    }).outputText;
    code = code.replace(/import (\w+) from '(.+\.json)';/g, (_, variable, path) =>
      `const ${variable} = ${readFileSync(join(app, 'src/classify', path), 'utf8')};`);
    code = code.replace(/from '(\.\/[^']+)';/g, "from '$1.mjs';");
    writeFileSync(join(temporary, `${name}.mjs`), code);
  }
  const { classifyCategory } = await import(pathToFileURL(join(temporary, 'category-classifier.mjs')));
  const report = {
    feed_sha256: createHash('sha256').update(feedBytes).digest('hex'),
    feed_updated_at: feed.updated_at,
    active: 0, unclassified: 0, by_role: {}, by_field: {}, by_confidence: {},
    by_source: {}, unmapped_source_categories: {}, conflicts: 0,
    review_queue: [],
  };
  const increment = (object, key) => { object[key] = (object[key] ?? 0) + 1; };
  for (const posting of Object.values(feed.postings)) {
    if (posting.closed_at) continue;
    report.active++;
    const result = classifyCategory(posting.title, posting.description_text ?? null,
      posting.source_metadata?.category, posting.source_metadata);
    increment(report.by_role, result.category);
    increment(report.by_confidence, result.confidence);
    for (const domain of result.domain_tags) increment(report.by_field, domain);
    const source = report.by_source[posting.source] ??= { active: 0, unclassified: 0, fallback: 0 };
    source.active++;
    if (result.category === 'other') { report.unclassified++; source.unclassified++; }
    if (result.confidence === 'low') source.fallback++;
    for (const warning of result.warnings) {
      if (warning.startsWith('Unmapped')) increment(report.unmapped_source_categories, posting.source_metadata.category);
      else report.conflicts++;
    }
    if (result.confidence === 'unknown' || result.confidence === 'low' || result.warnings.length) {
      report.review_queue.push({ id: posting.id, title: posting.title, company: posting.company,
        source: posting.source, source_category: posting.source_metadata?.category,
        category: result.category, confidence: result.confidence, warnings: result.warnings });
    }
  }
  report.unclassified_percent = Math.round(report.unclassified / report.active * 10000) / 100;
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} finally {
  // Only the known generated module files in this unique temporary directory.
  for (const name of modules) {
    try { unlinkSync(join(temporary, `${name}.mjs`)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  rmdirSync(temporary);
}
