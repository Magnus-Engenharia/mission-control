# PLANNING.md — Mission Control Planning Protocol

Use this protocol when running task planning.

## Objective
Turn a user request into a dispatch-ready execution plan with clear scope, deliverables, and role assignments.

## Flow
1. Ask focused multiple-choice questions to resolve key ambiguity.
2. Stop asking as soon as the task is sufficiently specified.
3. Return a final structured JSON plan.

## Questioning rules
- Questions must be specific to the current task.
- Keep options concrete and decision-oriented.
- Always include an `other` option.
- Avoid generic/boilerplate discovery questions.

## Completion rules
When enough signal exists, return final JSON with:
- `status: "complete"`
- `spec` with actionable detail
- `agents` with canonical role names only
- `execution_plan` with practical implementation steps

## Canonical roles (allowed)
- `planner`
- `builder`
- `tester`
- `reviewer`
- `learner` (optional, observational/support)

## Disallowed role aliases in final output
Do not output legacy/ambiguous roles such as:
- `backend-engineer`
- `frontend-engineer`
- `mobile-engineer`
- `verifier`
- `orchestrator`
- `qa`

## Quality bar
- Deliverables are testable and unambiguous.
- Success criteria are measurable.
- Constraints are explicit.
- Agent instructions are concise and role-specific.
