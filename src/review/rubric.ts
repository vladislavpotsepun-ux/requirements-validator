export const individualCriteria = [
  'necessity', 'appropriateness', 'unambiguity', 'completeness', 'singularity',
  'feasibility', 'verifiability', 'correctness', 'conformance',
] as const;

export const setCriteria = [
  'completeness', 'consistency', 'feasibility', 'boundaries', 'traceability',
  'verifiability', 'modifiability', 'understandability', 'prioritization',
] as const;

export type IndividualCriterion = (typeof individualCriteria)[number];
export type SetCriterion = (typeof setCriteria)[number];

export const individualRubric: Record<IndividualCriterion, string> = {
  necessity: 'Justified by the stated goal, higher-level obligation, or explicable constraint.',
  appropriateness: 'At the right abstraction level; mandatory design choices have a stated rationale.',
  unambiguity: 'One interpretation of actor, trigger, terms, units, and timing in context.',
  completeness: 'Specifies applicable preconditions, behavior, and outcomes for the claim.',
  singularity: 'One independently verifiable obligation; necessary conditions stay with the obligation.',
  feasibility: 'Compatible with stated technology and constraints; distinguish prerequisites and missing evidence.',
  verifiability: 'A measurable result or otherwise observable check with a meaningful pass condition.',
  correctness: 'Faithfully represents the stated need, scenario, and decision, using correct domain semantics.',
  conformance: 'Consistent with the document’s adopted format or applicable rules stated in the source.',
};

export const setRubric: Record<SetCriterion, string> = {
  completeness: 'Covers stated business goals, essential behavior, interfaces, data, and relevant failure paths.',
  consistency: 'Rules, examples, data, intervals, state changes, and interface contracts agree across sections.',
  feasibility: 'The set is supportable given dependencies, data, permissions, capacity, people, and time.',
  boundaries: 'Scope, actors, included and excluded behavior, and responsibility across systems are clear.',
  traceability: 'Goals, functional rules, interface clauses and acceptance scenarios can be linked.',
  verifiability: 'Acceptance covers critical flows, boundaries, errors and nonfunctional targets across the set.',
  modifiability: 'Rules are organized and changes can be made without diverging copies or hidden dependencies.',
  understandability: 'Terms, state, units and relationships between parts have a coherent shared meaning.',
  prioritization: 'Decisions about delivery order or trade-offs are visible when the scope requires them.',
};

export const criterionLabels: Record<IndividualCriterion | SetCriterion, string> = {
  necessity: 'Необходимость',
  appropriateness: 'Уместность детализации',
  unambiguity: 'Однозначность',
  completeness: 'Полнота',
  singularity: 'Атомарность',
  feasibility: 'Выполнимость',
  verifiability: 'Проверяемость',
  correctness: 'Корректность',
  conformance: 'Соответствие формату и правилам',
  consistency: 'Непротиворечивость',
  boundaries: 'Границы и ответственность',
  traceability: 'Прослеживаемость',
  modifiability: 'Удобство изменений',
  understandability: 'Понятность',
  prioritization: 'Приоритеты',
};
