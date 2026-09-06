import { describe, expect, it } from 'vitest';
import { classifyCategory } from './category-classifier';

// Reviewed title-level examples, independent of any employer or vendor label.
// These are regression cases, not an estimate of production accuracy.
const cases = [
  ['Avionics Software Engineering Co-op', 'swe'],
  ['Software Engineer, Guidance Navigation and Control', 'swe'],
  ['Software Developer (Satellite Systems)', 'swe'],
  ['Full–Stack Web Development Intern', 'swe'],
  ['Back-End Engineer Intern', 'swe'],
  ['Core Developer - Intern', 'swe'],
  ['Quantitative Developer Summer Intern', 'swe'],
  ['Quant Software Engineering Intern', 'swe'],
  ['Quantitative Researcher Intern', 'quant'],
  ['Systematic Trading Intern', 'quant'],
  ['Trading Systems Engineer Intern', 'swe'],
  ['Machine Learning Engineer Intern', 'data-ml'],
  ['Data Governance Intern', 'data-ml'],
  ['Business Intelligence Intern', 'data-ml'],
  ['Data Analysis Co-op', 'data-ml'],
  ['Applied Science Intern - PhD', 'data-ml'],
  ['FPGA Design Verification Intern', 'hardware'],
  ['ASIC Physical Design Intern', 'hardware'],
  ['Embedded Software Intern', 'hardware'],
  ['Firmware Engineer Intern', 'hardware'],
  ['Electrical Engineering Co-op', 'ECE'],
  ['Power Electronics Intern', 'ECE'],
  ['Optical Engineering Intern', 'ECE'],
  ['RF Design Intern', 'ECE'],
  ['Mechanical Design Intern, Spacecraft', 'mechE'],
  ['Thermal Engineering Intern', 'mechE'],
  ['Manufacturing Engineering Intern', 'mechE'],
  ['Gas Turbine Products Engineering Intern', 'mechE'],
  ['Aerospace Systems Intern', 'aero'],
  ['Flight Dynamics Intern', 'aero'],
  ['Guidance, Navigation, and Control Intern', 'aero'],
  ['Aerodynamics Engineering Intern', 'aero'],
  ['Geotechnical Engineering Intern', 'civil'],
  ['Water Resources Intern', 'civil'],
  ['Chemical Engineering Co-op', 'chemE'],
  ['Biomedical Engineering Intern', 'bioE'],
  ['Bioinformatics Intern', 'bioE'],
  ['Financial Analyst Summer Intern', 'finance'],
  ['Investment Banking Summer Analyst', 'finance'],
  ['Equity Research Summer Analyst', 'finance'],
  ['Actuarial Intern', 'finance'],
  ['Tax Accounting Intern', 'accounting'],
  ['Audit Intern', 'accounting'],
  ['Technology Consulting Intern', 'consulting'],
  ['Associate Consultant Intern', 'consulting'],
  ['Research Assistant Intern', 'research'],
  ['Molecular Biology Intern', 'research'],
  ['Product Design Intern', 'design'],
  ['UX Researcher Intern', 'design'],
  ['Industrial Designer Intern', 'design'],
  ['Product Management Co-op', 'product'],
  ['Software Product Manager Intern', 'product'],
  ['Supply Chain Analyst Intern', 'supply-chain'],
  ['Warehouse Operations Intern', 'supply-chain'],
  ['Business Operations Intern', 'operations'],
  ['Information Technology Intern', 'it'],
  ['IT Technician Intern', 'it'],
  ['Marketing Strategy Intern', 'marketing'],
  ['Talent and Recruiting Intern', 'people'],
  ['Human Resources Intern', 'people'],
  ['Contracts Intern - Deals', 'legal'],
  ['Legal Intern', 'legal'],
  ['Customer Success Intern', 'sales'],
  ['Sales Intern', 'sales'],
  ['Nursing Intern', 'healthcare'],
  ['Pharmacy Intern', 'healthcare'],
  ['Engineering Intern', 'other'],
  ['Systems Engineering Intern', 'other'],
  ['Quality Assurance Intern', 'other'],
  ['Summer 2027 Intern', 'other'],
  ['Design and Development Co-op', 'other'],
  ['Graduate Engineer Internship', 'other'],
] as const;

describe('reviewed occupation corpus', () => {
  it.each(cases)('%s → %s', (title, category) => {
    expect(classifyCategory(title, null).category).toBe(category);
  });
  it.each(cases)('does not change %s when unrelated company boilerplate is appended', (title, category) => {
    const result = classifyCategory(title,
      'We are a leading aerospace software company serving finance and healthcare. '
      + 'Qualifications: a degree in electrical engineering, mechanical engineering or computer science. '
      + 'You will collaborate with our machine learning research team.');
    expect(result.category).toBe(category);
    expect(result.category_tags).toEqual(classifyCategory(title, null).category_tags);
    expect(result.domain_tags).toEqual(classifyCategory(title, null).domain_tags);
  });
});
