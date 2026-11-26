import type { IndividualCriterion, SetCriterion } from './rubric.js';
import type { ReviewErrorCode } from './errors.js';

export type SourceFormat = 'pdf' | 'markdown' | 'text';
export type BlockKind = 'heading' | 'paragraph' | 'list' | 'table' | 'code';
export type RequirementKind =
  | 'functional' | 'nonfunctional' | 'interface' | 'data' | 'acceptance' | 'constraint';

export interface Location {
  section: string[];
  startLine: number;
  endLine: number;
  page?: number;
}

export interface Evidence {
  blockId: string;
  quote: string;
  location: Location;
}

export interface SourceBlock {
  id: string;
  originalId: string | null;
  kind: BlockKind;
  text: string;
  location: Location;
}

export interface SourceDocument {
  name: string;
  title: string;
  format: SourceFormat;
  sha256: string;
  blocks: SourceBlock[];
  unreadablePages: number[];
}

export interface Requirement {
  id: string;
  originalId: string | null;
  summary: string;
  kind: RequirementKind;
  source: Evidence;
}

export type Feasibility = 'feasible' | 'conditional' | 'unknown' | 'infeasible';
export type Readiness = 'ready' | 'conditional' | 'blocked';
export type Severity = 'blocker' | 'major' | 'minor';
export type FindingKind = 'defect' | 'risk' | 'question';
export type ReviewPhase = 'extract' | 'individual' | 'set';

export interface Finding {
  id: string;
  scope: 'individual' | 'set';
  criterion: IndividualCriterion | SetCriterion;
  kind: FindingKind;
  severity: Severity;
  affects: 'development' | 'testing' | 'both';
  description: string;
  impact: string;
  action: string;
  evidence: Evidence[];
  requirementIds: string[];
}

export interface ReviewedRequirement extends Requirement {
  feasibility: Feasibility;
  testReadiness: Readiness;
  findingIds: string[];
}

export interface ReviewReport {
  run: {
    documentName: string;
    documentTitle: string;
    documentFormat: SourceFormat;
    sha256: string;
    date: string;
    provider: 'Gemini' | 'Local' | 'Codex CLI';
    model: string;
    version: string;
  };
  summary: {
    requirements: number;
    defects: number;
    blockingDefects: number;
    risks: number;
    questions: number;
  };
  readiness: { development: Readiness; testing: Readiness };
  unreadablePages: number[];
  requirements: ReviewedRequirement[];
  findings: Finding[];
}

export interface ModelRequest {
  phase: ReviewPhase;
  instructions: string;
  data: unknown;
  schema: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface ReviewModel {
  provider: ReviewReport['run']['provider'];
  model: string;
  generate(request: ModelRequest): Promise<unknown>;
}

export interface ReviewProgress {
  phase: ReviewPhase;
  completed: number;
  total: number;
}

export type WebErrorCode = ReviewErrorCode | 'ACCESS_DENIED' | 'INTERNAL_ERROR';

export interface DownloadableReport {
  name: string;
  contentType: string;
  base64: string;
}

export type ReviewEvent =
  | ({ type: 'progress' } & ReviewProgress)
  | { type: 'report'; report: ReviewReport; file: DownloadableReport }
  | { type: 'error'; code: WebErrorCode }
  | { type: 'heartbeat' };

export interface WebInfo {
  configured: boolean;
  model?: string;
  provider?: ReviewModel['provider'];
  maxBytes: number;
  requiresAccessCode: boolean;
}
