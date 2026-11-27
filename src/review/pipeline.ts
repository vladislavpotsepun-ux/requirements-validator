import { z } from 'zod';
import { ReviewError } from './errors.js';
import {
  extractPrompt, fintechIndividualAddon, fintechSetAddon, individualPrompt, setPrompt,
} from './prompts.js';
import { individualCriteria, setCriteria } from './rubric.js';
import type {
  Evidence, Finding, Readiness, Requirement, ReviewMode, ReviewModel, ReviewPhase, ReviewProgress, ReviewReport,
  ReviewedRequirement, SourceBlock, SourceDocument,
} from './types.js';

const id = z.string().min(1).max(32);
const explanation = z.string().min(1).max(900);
const optionalText = z.string().max(900).optional();
const extractionSchema = z.strictObject({
  requirements: z.array(z.strictObject({
    candidateId: id,
    summary: z.string().min(1).max(380),
    kind: z.enum(['functional', 'nonfunctional', 'interface', 'data', 'acceptance', 'constraint']),
  })).max(220),
});

const findingFields = {
  kind: z.enum(['defect', 'risk', 'question']),
  severity: z.enum(['blocker', 'major', 'minor']),
  affects: z.enum(['development', 'testing', 'both']),
  owner: z.enum(['product', 'backend', 'qa', 'security']).optional(),
  description: explanation,
  impact: explanation,
  action: explanation,
  suggestedRewrite: optionalText,
  clarifyingQuestion: z.string().max(500).optional(),
};
const itemReview = z.strictObject({
  id,
  feasibility: z.enum(['feasible', 'conditional', 'unknown', 'infeasible']),
  testReadiness: z.enum(['ready', 'conditional', 'blocked']),
  findings: z.array(z.strictObject({ criterion: z.enum(individualCriteria), ...findingFields })).max(8),
});
const individualSchema = z.strictObject({ reviews: z.array(itemReview).max(12) });
const setFinding = z.strictObject({
  criterion: z.enum(setCriteria),
  ...findingFields,
  evidence: z.array(id).min(1).max(4),
});
const setSchema = z.strictObject({ findings: z.array(setFinding).max(12) });

interface Options {
  version: string;
  mode?: ReviewMode;
  date?: Date;
  signal?: AbortSignal;
  onProgress?: (progress: ReviewProgress) => void;
}

type InventoryEntry = Omit<Requirement, 'id'> & { position: number };
type Candidate = { id: string; text: string };
type UnnumberedFinding = Omit<Finding, 'id'>;
const sentences = new Intl.Segmenter('ru', { granularity: 'sentence' });

export async function analyzeDocument(
  source: SourceDocument,
  model: ReviewModel,
  options: Options,
): Promise<ReviewReport> {
  const started = options.date ?? new Date();
  const mode: ReviewMode = options.mode ?? 'standard';
  const itemInstructions = mode === 'fintech' ? individualPrompt + fintechIndividualAddon : individualPrompt;
  const setInstructions = mode === 'fintech' ? setPrompt + fintechSetAddon : setPrompt;
  const inventory: InventoryEntry[] = [];
  const extractBatches = groupBlocks(source.blocks);
  const generate = makeGenerator(model, options.signal);

  for (const [index, blocks] of extractBatches.entries()) {
    options.onProgress?.({ phase: 'extract', completed: index, total: extractBatches.length });
    const candidates = blocks.map((block) => ({ block, candidates: makeCandidates(block) }));
    inventory.push(...await generate(
      'extract',
      extractPrompt,
      {
        document: source.title,
        section: blocks[0]?.location.section,
        blocks: candidates.map(({ block, candidates }) => {
          const { text: _text, ...attributes } = modelBlock(block);
          return block.kind === 'heading' ? modelBlock(block) : { ...attributes, candidates };
        }),
      },
      extractionSchema,
      ({ requirements }) => verifyExtraction(requirements, candidates),
    ));
  }
  if (!inventory.length) {
    throw new ReviewError('NO_REQUIREMENTS', 'The document did not contain any identifiable requirements.');
  }
  const catalog: Requirement[] = inventory.map(({ position: _position, ...item }, index) => ({
    ...item, id: `REQ-${String(index + 1).padStart(3, '0')}`,
  }));
  const itemBatches = Array.from({ length: Math.ceil(catalog.length / 12) }, (_, index) =>
    catalog.slice(index * 12, (index + 1) * 12));
  const blockIndexes = new Map(source.blocks.map((block, index) => [block.id, index]));
  const itemReviews: z.infer<typeof itemReview>[] = [];
  for (const [index, items] of itemBatches.entries()) {
    options.onProgress?.({ phase: 'individual', completed: index, total: itemBatches.length });
    itemReviews.push(...await generate(
      'individual',
      itemInstructions,
      { items, context: adjacentContext(source.blocks, blockIndexes, items) },
      individualSchema,
      ({ reviews }) => orderReviews(reviews, items),
    ));
  }
  const itemFindings = catalog.flatMap((item, index): UnnumberedFinding[] =>
    itemReviews[index]!.findings.map((finding) => ({
      ...normalizeOptionalFindingFields(finding), scope: 'individual', evidence: [item.source], requirementIds: [item.id],
    })));

  options.onProgress?.({ phase: 'set', completed: 0, total: 1 });
  const setFindings = await generate(
    'set',
    setInstructions,
    {
      document: source.title,
      unreadablePages: source.unreadablePages,
      blocks: source.blocks.map(({ id, kind, text }) => [id, kind, normalizeQuote(text)]),
      earlierFindings: itemFindings.slice(0, 10).map(({ evidence, description }) =>
        [evidence[0]!.blockId, description.slice(0, 110)]),
    },
    setSchema,
    ({ findings }) => verifySetFindings(findings, source.blocks, catalog),
  );
  const findings = prioritizeFindings([...itemFindings, ...setFindings]);
  const requirements = catalog.map((item, index): ReviewedRequirement => ({
    ...item,
    feasibility: itemReviews[index]!.feasibility,
    testReadiness: itemReviews[index]!.testReadiness,
    findingIds: findings.filter((finding) => finding.requirementIds.includes(item.id)).map(({ id }) => id),
  }));
  return {
    run: {
      documentName: source.name,
      documentTitle: source.title,
      documentFormat: source.format,
      sha256: source.sha256,
      date: started.toISOString(),
      provider: model.provider,
      model: model.model,
      version: options.version,
      mode,
    },
    summary: {
      requirements: requirements.length,
      defects: findings.filter(({ kind }) => kind === 'defect').length,
      blockingDefects: findings.filter(({ kind, severity }) => kind === 'defect' && severity === 'blocker').length,
      risks: findings.filter(({ kind }) => kind === 'risk').length,
      questions: findings.filter(({ kind }) => kind === 'question').length,
    },
    readiness: {
      development: determineReadiness('development', findings, requirements, source.unreadablePages),
      testing: determineReadiness('testing', findings, requirements, source.unreadablePages),
    },
    unreadablePages: source.unreadablePages,
    requirements,
    findings,
    sourceBlocks: source.blocks,
  };
}

function normalizeOptionalFindingFields<T extends { suggestedRewrite?: string; clarifyingQuestion?: string }>(
  finding: T,
): T {
  const suggestedRewrite = finding.suggestedRewrite?.trim() || undefined;
  const clarifyingQuestion = finding.clarifyingQuestion?.trim() || undefined;
  return {
    ...finding,
    ...(suggestedRewrite ? { suggestedRewrite } : { suggestedRewrite: undefined }),
    ...(clarifyingQuestion ? { clarifyingQuestion } : { clarifyingQuestion: undefined }),
  };
}

function makeGenerator(model: ReviewModel, signal?: AbortSignal) {
  return async <Schema extends z.ZodType, Result>(
    phase: ReviewPhase,
    instructions: string,
    data: unknown,
    schema: Schema,
    validate: (data: z.output<Schema>) => Result,
  ): Promise<Result> => {
    const jsonSchema = transportSchema(schema);
    let correction = '';
    for (let attempt = 0; attempt < 2; attempt += 1) {
      signal?.throwIfAborted();
      try {
        const result = await model.generate({
          phase, instructions: instructions + correction, data, schema: jsonSchema, signal,
        });
        const parsed = schema.safeParse(result);
        if (!parsed.success) {
          const firstProblem = parsed.error.issues[0];
          const path = firstProblem?.path.filter((part) => typeof part !== 'symbol').join('.') || 'root';
          throw invalidOutput(`The response does not match the required schema at ${path}.`);
        }
        return validate(parsed.data);
      } catch (error) {
        if (!(error instanceof ReviewError) || error.code !== 'INVALID_MODEL_OUTPUT' || attempt === 1) {
          throw error;
        }
        correction = `\nA prior response failed validation: ${error.message} Return a new complete response.`;
      }
    }
    throw invalidOutput('The model did not produce a complete response.');
  };
}

function transportSchema(schema: z.ZodType): Record<string, unknown> {
  const localBounds = new Set(['$schema', 'minLength', 'maxLength', 'minItems', 'maxItems']);
  // Проверяем ограничения размера в ответе модели, чтобы упростить передаваемую схему.
  return JSON.parse(JSON.stringify(z.toJSONSchema(schema, { target: 'draft-7' }), (key, value) =>
    localBounds.has(key) ? undefined : value));
}

function groupBlocks(blocks: readonly SourceBlock[]): SourceBlock[][] {
  const groups: SourceBlock[][] = [];
  let current: SourceBlock[] = [];
  let length = 0;
  for (const block of blocks) {
    if (current.length >= 50 || length + block.text.length > 13_000) {
      groups.push(current);
      current = [];
      length = 0;
    }
    current.push(block);
    length += block.text.length;
  }
  if (current.length) {
    groups.push(current);
  }
  return groups;
}

function modelBlock({ id, kind, originalId, text }: SourceBlock) {
  return { blockId: id, kind, ...(originalId ? { originalId } : {}), text: normalizeQuote(text) };
}

function makeCandidates(block: SourceBlock): Candidate[] {
  const source = normalizeQuote(block.text);
  if (block.kind === 'heading') {
    return [];
  }
  if (block.kind === 'table' || block.kind === 'code') {
    return [{ id: `${block.id}.1`, text: source }];
  }

  let body = source.replace(/^(?:[-+*]|\d{1,2}[.)])\s+/u, '');
  if (block.originalId) {
    const withoutMarkup = body.replace(/^[*_`]+/u, '');
    if (withoutMarkup.startsWith(block.originalId)) {
      body = withoutMarkup.slice(block.originalId.length).replace(/^[\s.:[\])_*\x60]+/u, '') || body;
    }
  }
  const passages: string[] = [];
  let start = 0;
  for (const { segment, index } of sentences.segment(body)) {
    if (/^[*_`]*\d{3}[.!?]$/u.test(segment.trim())) {
      continue;
    }
    const end = index + segment.length;
    passages.push(body.slice(start, end).trim());
    start = end;
  }
  if (start < body.length) {
    passages.push(body.slice(start).trim());
  }
  return passages.filter(Boolean).map((text, index) => ({ id: `${block.id}.${index + 1}`, text }));
}

function verifyExtraction(
  extracted: z.infer<typeof extractionSchema>['requirements'],
  blocks: readonly { block: SourceBlock; candidates: Candidate[] }[],
): InventoryEntry[] {
  const ordered = blocks.flatMap(({ block, candidates }) => candidates.map((candidate) => ({ block, candidate })));
  const positions = new Map(ordered.map(({ candidate }, index) => [candidate.id, index]));
  const covered = new Set<string>();
  const excerpts = new Map<string, { kind: Requirement['kind']; summary: string }>();
  const inventory = extracted.flatMap((item): InventoryEntry[] => {
    const position = positions.get(item.candidateId);
    const match = position === undefined ? undefined : ordered[position];
    const summary = item.summary.trim();
    if (position === undefined || !match || !summary) {
      throw invalidOutput('Use a listed candidate identifier exactly as written and supply its summary.');
    }
    const previous = excerpts.get(item.candidateId);
    if (previous) {
      if (previous.summary !== summary || previous.kind !== item.kind) {
        throw invalidOutput(`Assign one obligation to candidate ${item.candidateId}, or choose separate candidates.`);
      }
      return [];
    }
    excerpts.set(item.candidateId, { summary, kind: item.kind });
    const { block, candidate } = match;
    covered.add(block.id);
    return [{
      position,
      originalId: block.originalId,
      summary,
      kind: item.kind,
      source: { blockId: block.id, location: block.location, quote: candidate.text },
    }];
  });
  const missing = blocks.find(({ block }) => block.originalId && !covered.has(block.id))?.block;
  if (missing) {
    throw invalidOutput(`An explicitly numbered requirement was missed in ${missing.id}.`);
  }
  return inventory.sort((left, right) => left.position - right.position);
}

function adjacentContext(
  blocks: readonly SourceBlock[],
  indexes: Map<string, number>,
  items: readonly Requirement[],
) {
  const included = new Map<string, SourceBlock>();
  for (const item of items) {
    const index = indexes.get(item.source.blockId)!;
    for (const block of blocks.slice(Math.max(0, index - 1), index + 2)) {
      included.set(block.id, block);
    }
  }
  return Array.from(included.values(), modelBlock);
}

function orderReviews(reviews: z.infer<typeof itemReview>[], items: readonly Requirement[]) {
  const byId = new Map(reviews.map((review) => [review.id, review]));
  if (reviews.length !== items.length || byId.size !== items.length || items.some(({ id }) => !byId.has(id))) {
    throw invalidOutput('Provide exactly one individual review for every requested ID, without duplicates.');
  }
  return items.map(({ id }) => {
    const review = byId.get(id)!;
    for (const finding of review.findings) {
      verifyFindingProse(finding);
    }
    const hasBlocker = (area: 'development' | 'testing') => review.findings.some((finding) =>
      finding.kind === 'defect' && finding.severity === 'blocker'
      && (finding.affects === area || finding.affects === 'both'));
    if ((review.feasibility === 'infeasible' && !hasBlocker('development'))
      || (review.testReadiness === 'blocked' && !hasBlocker('testing'))) {
      throw invalidOutput(`${id} needs a blocker defect with an explanation and an action for any blocked area.`);
    }
    return review;
  });
}

function verifySetFindings(
  findings: z.infer<typeof setFinding>[],
  blocks: readonly SourceBlock[],
  catalog: readonly Requirement[],
): UnnumberedFinding[] {
  const byId = new Map(blocks.map((block) => [block.id, block]));
  const requirementsByBlock = new Map<string, string[]>();
  for (const { id, source } of catalog) {
    const ids = requirementsByBlock.get(source.blockId) ?? [];
    ids.push(id);
    requirementsByBlock.set(source.blockId, ids);
  }
  return findings.map(({ evidence, ...finding }) => {
    verifyFindingProse(finding);
    const references = [...new Set(evidence)];
    if (finding.kind === 'defect' && finding.criterion === 'consistency' && references.length < 2) {
      throw invalidOutput('A conflict between requirements must identify both independent source passages.');
    }
    const linked = references.map((key): Evidence => {
      const block = byId.get(key);
      if (!block) {
        throw invalidOutput('Every set finding must cite existing block IDs from the supplied document.');
      }
      return { blockId: block.id, quote: normalizeQuote(block.text), location: block.location };
    });
    if (finding.kind === 'defect' && references.every((key) => byId.get(key)?.kind === 'heading')) {
      throw invalidOutput('A defect must cite a source statement or a template placeholder as evidence.');
    }
    return {
      ...normalizeOptionalFindingFields(finding),
      scope: 'set',
      evidence: linked,
      requirementIds: references.flatMap((key) => {
        const ids = requirementsByBlock.get(key);
        return ids?.length === 1 ? ids : [];
      }),
    };
  });
}

function verifyFindingProse({ description, impact, action }: Pick<Finding, 'description' | 'impact' | 'action'>) {
  if (![description, impact, action].every((value) => value.trim())) {
    throw invalidOutput('Each finding needs a description, impact, and a proposed action.');
  }
}

function normalizeQuote(text: string) {
  return text.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

function invalidOutput(message: string) {
  return new ReviewError('INVALID_MODEL_OUTPUT', message);
}

function prioritizeFindings(findings: UnnumberedFinding[]): Finding[] {
  const unique = new Map<string, UnnumberedFinding>();
  const severityRank = { blocker: 0, major: 1, minor: 2 };
  const kindRank = { defect: 0, risk: 1, question: 2 };
  for (const finding of findings) {
    const references = finding.evidence.map(({ blockId, quote }) => `${blockId}.${quote}`).sort();
    const prose = [finding.description, finding.impact, finding.action].map(normalizeQuote);
    const key = JSON.stringify([
      finding.scope, finding.criterion, finding.kind, finding.severity, finding.affects,
      [...finding.requirementIds].sort(), references, prose,
    ]);
    if (!unique.has(key)) {
      unique.set(key, finding);
    }
  }
  return Array.from(unique.values())
    .sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || kindRank[a.kind] - kindRank[b.kind])
    .map((finding, index) => ({ ...finding, id: `F-${String(index + 1).padStart(3, '0')}` }));
}

function determineReadiness(
  area: 'development' | 'testing',
  findings: readonly Finding[],
  requirements: readonly ReviewedRequirement[],
  unreadablePages: readonly number[],
): Readiness {
  const relevant = findings.filter(({ affects }) => affects === area || affects === 'both');
  if (relevant.some(({ kind, severity }) => kind === 'defect' && severity === 'blocker')) {
    return 'blocked';
  }
  const itemConditions = area === 'development'
    ? requirements.some(({ feasibility }) => feasibility !== 'feasible')
    : requirements.some(({ testReadiness }) => testReadiness !== 'ready');
  return itemConditions || unreadablePages.length || relevant.some(({ severity }) => severity !== 'minor')
    ? 'conditional' : 'ready';
}
