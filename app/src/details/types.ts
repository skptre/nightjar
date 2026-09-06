export type SectionKind = 'responsibilities' | 'required' | 'preferred' | 'authorization'
  | 'compensation' | 'timing' | 'company' | 'other';
export interface Evidence {
  text: string;
  start: number;
  end: number;
  section: SectionKind;
}
export interface PayRange {
  min: number;
  max: number;
  currency: string;
  period: 'hour' | 'day' | 'week' | 'month' | 'year';
  kind: 'base' | 'bonus' | 'equity' | 'stipend' | 'unspecified';
  evidence: Evidence;
  source: 'description' | 'structured';
  label?: string;
}
export interface GraduationWindow {
  start: string;
  end: string;
  evidence: Evidence;
  mandatory: boolean;
}
export type AcquisitionStatus = 'available' | 'stale' | 'partial' | 'unavailable' | 'unsupported' | 'unknown';
export interface JobDetails {
  version: number;
  document: string;
  acquisition: AcquisitionStatus;
  sections: Record<SectionKind, Evidence[]>;
  authorization: Evidence[];
  compensation: { status: 'listed' | 'not_listed' | 'unavailable'; ranges: PayRange[]; passages: Evidence[] };
  graduation: GraduationWindow[];
}
export interface RequirementAssessment {
  exclude: boolean;
  exclusionEvidence: Evidence[];
  outsideGradWindow: boolean;
  graduationEvidence: Evidence[];
}
