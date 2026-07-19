import type { AgentTeamTemplate } from './types'

export const AGENT_TEAM_TEMPLATES: AgentTeamTemplate[] = [
  {
    id: 'product-delivery', name: 'Product Delivery Team', category: 'delivery',
    summary: 'Plan, implement, test, review, and summarize a production-ready feature.', recommendedPolicy: 'controlled',
    members: [
      { name: 'Delivery Lead', role: 'lead', provider: 'claude', instructions: 'Own scope, sequence the work, resolve conflicting findings, and require concrete evidence before declaring completion.' },
      { name: 'Product Analyst', role: 'researcher', provider: 'claude', instructions: 'Inspect the real product and codebase, clarify user-visible behavior, identify constraints, and prepare an implementation-ready plan.' },
      { name: 'Implementation Engineer', role: 'developer', provider: 'codex', instructions: 'Implement only the approved scope, preserve existing conventions, and keep every change traceable to an acceptance criterion.' },
      { name: 'Quality Engineer', role: 'tester', provider: 'codex', instructions: 'Test normal, edge, and regression paths independently. Report commands, results, and any unverified risk.' },
      { name: 'Code Reviewer', role: 'reviewer', provider: 'claude', instructions: 'Review correctness, maintainability, security, UX impact, and scope. Block completion when evidence is insufficient.' }
    ],
    tasks: [
      { key: 'plan', title: 'Investigate requirements and plan', description: 'Map the objective to the current product, code paths, constraints, and measurable acceptance criteria.', assigneeRole: 'researcher', dependencies: [], acceptanceCriteria: ['Relevant code and behavior are identified', 'Risks and acceptance criteria are explicit'] },
      { key: 'build', title: 'Implement the approved solution', description: 'Implement the smallest complete solution that satisfies the approved plan.', assigneeRole: 'developer', dependencies: ['plan'], acceptanceCriteria: ['Implementation matches the approved scope', 'Code builds and follows project conventions'] },
      { key: 'test', title: 'Validate behavior and regressions', description: 'Run focused and broad validation, including the real user-visible workflow where practical.', assigneeRole: 'tester', dependencies: ['build'], acceptanceCriteria: ['Relevant automated tests pass', 'User-visible behavior is verified'] },
      { key: 'review', title: 'Perform final code review', description: 'Review the implementation and test evidence; identify blocking defects or residual risks.', assigneeRole: 'reviewer', dependencies: ['test'], acceptanceCriteria: ['No blocking findings remain', 'Residual risks are documented'] },
      { key: 'summary', title: 'Synthesize the delivery outcome', description: 'Produce a concise delivery report covering changes, evidence, and remaining risks.', assigneeRole: 'lead', dependencies: ['review'], acceptanceCriteria: ['Outcome and evidence are clear', 'Next actions are unambiguous'] }
    ]
  },
  {
    id: 'bug-response', name: 'Bug Investigation Team', category: 'quality',
    summary: 'Reproduce, isolate, fix, regression-test, and review a defect.', recommendedPolicy: 'controlled',
    members: [
      { name: 'Incident Lead', role: 'lead', provider: 'claude', instructions: 'Keep the investigation evidence-driven, separate symptoms from causes, and prevent speculative fixes.' },
      { name: 'Root Cause Analyst', role: 'researcher', provider: 'claude', instructions: 'Reproduce the failure, trace the exact execution path, and document the smallest defensible root cause.' },
      { name: 'Fix Engineer', role: 'developer', provider: 'codex', instructions: 'Implement a surgical root-cause fix without unrelated refactoring and add a regression guard.' },
      { name: 'Regression Tester', role: 'tester', provider: 'codex', instructions: 'Prove the original failure is fixed and test adjacent behavior, failure paths, and user-visible output.' },
      { name: 'Risk Reviewer', role: 'reviewer', provider: 'claude', instructions: 'Challenge the root-cause claim, inspect regression risk, and reject fixes that only mask symptoms.' }
    ],
    tasks: [
      { key: 'reproduce', title: 'Reproduce and isolate the defect', description: 'Capture the exact failure, inputs, environment, and affected execution path.', assigneeRole: 'researcher', dependencies: [], acceptanceCriteria: ['Failure is reproducible or bounded', 'Root cause is supported by evidence'] },
      { key: 'fix', title: 'Implement the root-cause fix', description: 'Apply a focused fix and add a regression test for the observed failure.', assigneeRole: 'developer', dependencies: ['reproduce'], acceptanceCriteria: ['Original root cause is addressed', 'Regression coverage is added'] },
      { key: 'verify', title: 'Run regression validation', description: 'Re-run the failing path and relevant neighboring tests.', assigneeRole: 'tester', dependencies: ['fix'], acceptanceCriteria: ['Original failure no longer occurs', 'Relevant regression suite passes'] },
      { key: 'review', title: 'Review fix risk and evidence', description: 'Assess correctness, unintended side effects, and evidence quality.', assigneeRole: 'reviewer', dependencies: ['verify'], acceptanceCriteria: ['No symptom-only workaround remains', 'No blocking regression risk remains'] },
      { key: 'summary', title: 'Publish incident outcome', description: 'Summarize cause, fix, validation evidence, and residual risk.', assigneeRole: 'lead', dependencies: ['review'], acceptanceCriteria: ['Cause and fix are clearly linked', 'Verification evidence is concrete'] }
    ]
  },
  {
    id: 'security-audit', name: 'Security Audit Team', category: 'security',
    summary: 'Map attack surfaces, validate findings, harden safely, and verify controls.', recommendedPolicy: 'review',
    members: [
      { name: 'Security Lead', role: 'lead', provider: 'claude', instructions: 'Set threat boundaries, prioritize by exploitability and impact, and require reproducible evidence for findings.' },
      { name: 'Threat Researcher', role: 'researcher', provider: 'claude', instructions: 'Map trust boundaries, sensitive assets, entry points, privilege changes, and realistic abuse cases.' },
      { name: 'Hardening Engineer', role: 'developer', provider: 'codex', instructions: 'Implement approved mitigations with secure defaults and minimal compatibility impact.' },
      { name: 'Security Validator', role: 'tester', provider: 'codex', instructions: 'Validate mitigations, negative paths, authorization boundaries, secret handling, and regression behavior.' },
      { name: 'Security Reviewer', role: 'reviewer', provider: 'claude', instructions: 'Reject unproven findings, review bypass opportunities, and verify severity and remediation completeness.' }
    ],
    tasks: [
      { key: 'threats', title: 'Model threats and audit attack surfaces', description: 'Inspect authentication, authorization, inputs, secrets, filesystem, process, and network boundaries relevant to the objective.', assigneeRole: 'researcher', dependencies: [], acceptanceCriteria: ['Trust boundaries and assets are mapped', 'Findings include evidence and severity'] },
      { key: 'harden', title: 'Implement approved security hardening', description: 'Address validated findings without weakening existing controls.', assigneeRole: 'developer', dependencies: ['threats'], acceptanceCriteria: ['Mitigations address validated attack paths', 'Secure defaults are preserved'] },
      { key: 'validate', title: 'Validate security controls', description: 'Test exploit paths, bypass attempts, negative cases, and regressions.', assigneeRole: 'tester', dependencies: ['harden'], acceptanceCriteria: ['Mitigated paths are no longer exploitable', 'Security and regression tests pass'] },
      { key: 'review', title: 'Review findings and mitigations', description: 'Independently assess severity, coverage, and residual exposure.', assigneeRole: 'reviewer', dependencies: ['validate'], acceptanceCriteria: ['No critical unaddressed path remains', 'Residual risks are explicit'] },
      { key: 'summary', title: 'Produce security audit report', description: 'Summarize threats, findings, mitigations, evidence, and residual risk.', assigneeRole: 'lead', dependencies: ['review'], acceptanceCriteria: ['Report is prioritized and actionable', 'Evidence supports every material claim'] }
    ]
  },
  {
    id: 'performance', name: 'Performance Optimization Team', category: 'performance',
    summary: 'Profile first, optimize measured bottlenecks, and prove gains without regressions.', recommendedPolicy: 'controlled',
    members: [
      { name: 'Performance Lead', role: 'lead', provider: 'claude', instructions: 'Define measurable targets, prevent guess-driven optimization, and compare before-and-after evidence.' },
      { name: 'Profiling Analyst', role: 'researcher', provider: 'claude', instructions: 'Establish a reproducible baseline, profile representative workloads, and rank bottlenecks by measured impact.' },
      { name: 'Optimization Engineer', role: 'developer', provider: 'codex', instructions: 'Optimize only measured bottlenecks, preserve correctness, and keep changes independently measurable.' },
      { name: 'Benchmark Engineer', role: 'tester', provider: 'codex', instructions: 'Run stable benchmarks, correctness checks, stress cases, and report variance and resource usage.' },
      { name: 'Performance Reviewer', role: 'reviewer', provider: 'claude', instructions: 'Review benchmark validity, complexity tradeoffs, regressions, and whether claimed gains are statistically credible.' }
    ],
    tasks: [
      { key: 'profile', title: 'Establish baseline and profile bottlenecks', description: 'Measure representative workloads and identify the dominant cost centers.', assigneeRole: 'researcher', dependencies: [], acceptanceCriteria: ['Baseline is reproducible', 'Bottlenecks are supported by measurements'] },
      { key: 'optimize', title: 'Optimize measured bottlenecks', description: 'Implement focused optimizations against the established baseline.', assigneeRole: 'developer', dependencies: ['profile'], acceptanceCriteria: ['Changes target measured costs', 'Correctness is preserved'] },
      { key: 'benchmark', title: 'Benchmark and regression-test', description: 'Compare before and after results under representative and stress workloads.', assigneeRole: 'tester', dependencies: ['optimize'], acceptanceCriteria: ['Performance change is quantified', 'Correctness and stability tests pass'] },
      { key: 'review', title: 'Review performance evidence', description: 'Validate methodology, tradeoffs, and claimed improvements.', assigneeRole: 'reviewer', dependencies: ['benchmark'], acceptanceCriteria: ['Evidence supports the claimed gain', 'Complexity and regressions are acceptable'] },
      { key: 'summary', title: 'Publish optimization outcome', description: 'Summarize baseline, changes, measured gains, and remaining bottlenecks.', assigneeRole: 'lead', dependencies: ['review'], acceptanceCriteria: ['Before-and-after results are clear', 'Remaining bottlenecks are prioritized'] }
    ]
  },
  {
    id: 'architecture-review', name: 'Architecture Review Team', category: 'architecture',
    summary: 'Assess architecture, alternatives, migration risk, and decision quality without changing code.', recommendedPolicy: 'review',
    members: [
      { name: 'Architecture Lead', role: 'lead', provider: 'claude', instructions: 'Frame the decision, reconcile tradeoffs, and produce a recommendation tied to business and engineering constraints.' },
      { name: 'System Analyst', role: 'researcher', provider: 'claude', instructions: 'Map current components, dependencies, data flow, operational constraints, and known failure modes from the real codebase.' },
      { name: 'Solution Architect', role: 'developer', provider: 'codex', instructions: 'Develop concrete alternatives with interfaces, migration steps, compatibility constraints, and implementation costs.' },
      { name: 'Architecture Reviewer', role: 'reviewer', provider: 'claude', instructions: 'Challenge assumptions, analyze scalability, security, operability, reversibility, and long-term maintenance risk.' }
    ],
    tasks: [
      { key: 'current', title: 'Map the current architecture', description: 'Document components, boundaries, dependencies, data flow, and constraints relevant to the objective.', assigneeRole: 'researcher', dependencies: [], acceptanceCriteria: ['Current architecture is evidence-based', 'Constraints and failure modes are explicit'] },
      { key: 'options', title: 'Design and compare solution options', description: 'Develop viable options including migration and compatibility implications.', assigneeRole: 'developer', dependencies: ['current'], acceptanceCriteria: ['At least two viable options are compared', 'Costs and migration risks are explicit'] },
      { key: 'challenge', title: 'Challenge architecture assumptions', description: 'Review options for scalability, security, operability, reversibility, and maintainability.', assigneeRole: 'reviewer', dependencies: ['options'], acceptanceCriteria: ['Material assumptions are tested', 'Blocking risks are identified'] },
      { key: 'decision', title: 'Produce architecture recommendation', description: 'Synthesize the preferred option, rationale, migration plan, and decision checkpoints.', assigneeRole: 'lead', dependencies: ['challenge'], acceptanceCriteria: ['Recommendation is actionable', 'Tradeoffs and rollback points are documented'] }
    ]
  },
  {
    id: 'release-readiness', name: 'Release Readiness Team', category: 'release',
    summary: 'Audit build, tests, packaging, upgrade behavior, and user-visible release outcomes.', recommendedPolicy: 'controlled',
    members: [
      { name: 'Release Lead', role: 'lead', provider: 'claude', instructions: 'Own the release checklist, stop on blocking evidence, and distinguish built, installed, and publicly shipped states.' },
      { name: 'Release Analyst', role: 'researcher', provider: 'claude', instructions: 'Inspect versioning, changelog, configuration, dependencies, migrations, packaging, and deployment requirements.' },
      { name: 'Release Engineer', role: 'developer', provider: 'codex', instructions: 'Fix release blockers and produce reproducible artifacts using the project release process.' },
      { name: 'Release Validator', role: 'tester', provider: 'codex', instructions: 'Verify tests, artifacts, installation, upgrade, launch, rollback, and exact user-visible version state.' },
      { name: 'Go-live Reviewer', role: 'reviewer', provider: 'claude', instructions: 'Review evidence against release gates and issue an explicit ready or not-ready decision with blockers.' }
    ],
    tasks: [
      { key: 'audit', title: 'Audit release requirements and blockers', description: 'Inspect versioning, build, tests, packaging, migrations, deployment, and release documentation.', assigneeRole: 'researcher', dependencies: [], acceptanceCriteria: ['Release gates are explicit', 'Blockers are evidence-based'] },
      { key: 'prepare', title: 'Resolve blockers and prepare artifacts', description: 'Fix approved blockers and build reproducible release artifacts.', assigneeRole: 'developer', dependencies: ['audit'], acceptanceCriteria: ['Required artifacts are produced', 'Build process is reproducible'] },
      { key: 'validate', title: 'Validate install, upgrade, and launch', description: 'Test artifacts and exact installed or deployed user-visible outcomes.', assigneeRole: 'tester', dependencies: ['prepare'], acceptanceCriteria: ['Artifacts pass integrity checks', 'Install or deployment behavior is verified'] },
      { key: 'gate', title: 'Perform go-live review', description: 'Review all release evidence and identify remaining blockers.', assigneeRole: 'reviewer', dependencies: ['validate'], acceptanceCriteria: ['Readiness decision is evidence-backed', 'All blockers are explicit'] },
      { key: 'summary', title: 'Publish release readiness decision', description: 'State ready or not ready, with artifacts, evidence, and remaining actions.', assigneeRole: 'lead', dependencies: ['gate'], acceptanceCriteria: ['Decision is unambiguous', 'Evidence and remaining actions are listed'] }
    ]
  }
]

export function getAgentTeamTemplate(id?: string): AgentTeamTemplate | undefined {
  return id ? AGENT_TEAM_TEMPLATES.find((template) => template.id === id) : undefined
}
