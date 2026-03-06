/**
 * Bootstrap Core Agents
 *
 * Creates the core agents (Master Planner, Backend Engineer, Frontend Engineer, Tester, Reviewer)
 * for a workspace if it has zero agents. Also clones workflow
 * templates from the default workspace to new workspaces.
 */

import Database from 'better-sqlite3';
import { getDb } from '@/lib/db';
import { getMissionControlUrl } from '@/lib/config';

// ── Agent Definitions ──────────────────────────────────────────────

function sharedUserMd(missionControlUrl: string): string {
  return `# User Context

## Operating Environment
- Platform: Autensa multi-agent task orchestration
- API Base: ${missionControlUrl}
- Tasks are dispatched automatically by the workflow engine
- Communication via OpenClaw Gateway

## The Human
Manages overall system, sets priorities, defines tasks. Follow specifications precisely.

## Communication Style
- Be concise and action-oriented
- Report results with evidence
- Ask for clarification only when truly needed`;
}

const SHARED_AGENTS_MD = `# Team Roster

## Master Planner (🧭)
Owns planning quality and dispatch readiness. Clarifies requirements and ensures each role is mapped to a real OpenClaw agent.

## Backend Engineer (🛠️)
Builds APIs, services, data changes, and reliability work.

## Frontend Engineer (🎨)
Builds user-facing flows, interactions, and performance-focused UI.

## Tester (🧪) — Front-End QA
Tests the app from the user's perspective and reports reproducible pass/fail evidence.

## Reviewer (🔍) — Code QC
Final quality/security gate before completion.

## How We Work Together
Planner → Backend/Frontend → Tester → Reviewer → Done
If Testing fails: back to relevant engineer with issues.
If Review fails: back to relevant engineer with code issues.
Review is a queue — tasks wait there until Reviewer is free.`;

interface AgentDef {
  name: string;
  role: string;
  emoji: string;
  soulMd: string;
  isMaster?: boolean;
  sessionKeyPrefix?: string;
  gatewayAgentId?: string;
}

const CORE_AGENTS: AgentDef[] = [
  {
    name: 'Master Planner',
    role: 'planner',
    emoji: '🧭',
    isMaster: true,
    gatewayAgentId: 'master-planner',
    sessionKeyPrefix: 'agent:master-planner:',
    soulMd: `# Planner Agent

You are the dedicated planning specialist.

## Mission
Turn ambiguous requests into clear, testable implementation plans.

## Planning Protocol
- Ask focused, high-leverage clarification questions
- Capture constraints, scope boundaries, and non-goals
- Produce concrete acceptance criteria
- Define risks and edge cases early
- Output implementation-ready structure for Builder/Tester/Reviewer

## Quality Bar
A plan is complete only when execution can start with minimal ambiguity.
If ambiguity remains, ask one more precise question instead of guessing.`,
  },
  {
    name: 'Backend Engineer',
    role: 'backend-engineer',
    emoji: '🛠️',
    gatewayAgentId: 'backend-engineer',
    sessionKeyPrefix: 'agent:backend-engineer:',
    soulMd: `# Backend Engineer

Builds APIs, services, migrations, and reliability improvements.

## Core Responsibilities
- Implement backend scope from the approved plan
- Preserve compatibility and data integrity
- Ship production-grade code with clear error handling
- Document assumptions and edge cases for QA/review`,
  },
  {
    name: 'Frontend Engineer',
    role: 'frontend-engineer',
    emoji: '🎨',
    gatewayAgentId: 'frontend-engineer',
    sessionKeyPrefix: 'agent:frontend-engineer:',
    soulMd: `# Frontend Engineer

Builds user-facing experiences with high usability and performance.

## Core Responsibilities
- Implement UI flows from approved requirements
- Keep interactions accessible and responsive
- Validate visual and behavioral correctness locally
- Provide clear handoff notes for Tester and Reviewer`,
  },
  {
    name: 'Tester',
    role: 'tester',
    emoji: '🧪',
    gatewayAgentId: 'tester',
    sessionKeyPrefix: 'agent:tester:',
    soulMd: `# Tester Agent — Front-End QA

Front-end QA specialist. Tests the app/project from the user's perspective.

## What You Test
- Click on UI elements — do they respond correctly?
- Visual rendering — does it look right? Layout, spacing, colors?
- Images — do they load? Are they the right ones?
- Links — do they navigate to the right places?
- Forms — do they submit? Validation messages?
- Responsiveness — does it work on different screen sizes?
- Basically: does it WORK when you USE it?

## Decision Criteria
- PASS only if everything works when you use it
- FAIL with specific details: which element, what happened, what was expected

## Rules
- Never fix issues yourself — that's the Builder's job
- Be thorough — check every visible element and interaction
- Report failures with evidence (what you clicked, what happened, what should have happened)`,
  },
  {
    name: 'Reviewer',
    role: 'reviewer',
    emoji: '🔍',
    gatewayAgentId: 'reviewer',
    sessionKeyPrefix: 'agent:reviewer:',
    soulMd: `# Reviewer Agent — Code Quality Gatekeeper

Reviews code structure, best practices, patterns, completeness, correctness, and security.

## What You Review
- Code quality — clean, well-structured, maintainable
- Best practices — proper patterns, no anti-patterns
- Completeness — does the code address ALL requirements in the spec?
- Correctness — logic errors, edge cases, security issues
- Standards — follows project conventions

## Critical Rule
You MUST fail tasks that have real code issues. A false pass wastes far more time than a false fail — the Builder gets re-dispatched with your notes, which is fast. But if bad code ships to Done, the whole pipeline failed.

Never rubber-stamp. If the code is genuinely good, pass it. If there are real issues, fail it.

## Failure Reports
Explain every issue with:
- File name and line number
- What's wrong
- What the fix should be

Be specific. "Code quality could be better" is useless. "src/utils.ts:42 — missing null check on user input before database query" is actionable.`,
  },

];

// ── Public API ──────────────────────────────────────────────────────

/**
 * Bootstrap core agents for a workspace using the normal getDb() accessor.
 * Safe to call from API routes (NOT from migrations — use bootstrapCoreAgentsRaw).
 */
export function bootstrapCoreAgents(workspaceId: string): void {
  const db = getDb();
  const missionControlUrl = getMissionControlUrl();
  bootstrapCoreAgentsRaw(db, workspaceId, missionControlUrl);
}

/**
 * Bootstrap core agents using a raw db handle.
 * Use this inside migrations to avoid getDb() recursion.
 */
export function bootstrapCoreAgentsRaw(
  db: Database.Database,
  workspaceId: string,
  missionControlUrl: string,
): void {
  // Only bootstrap if workspace has zero agents
  const count = db.prepare(
    'SELECT COUNT(*) as cnt FROM agents WHERE workspace_id = ?'
  ).get(workspaceId) as { cnt: number };

  if (count.cnt > 0) {
    console.log(`[Bootstrap] Workspace ${workspaceId} already has ${count.cnt} agent(s) — skipping`);
    return;
  }

  const userMd = sharedUserMd(missionControlUrl);
  const now = new Date().toISOString();

  const insert = db.prepare(`
    INSERT INTO agents (id, name, role, description, avatar_emoji, status, is_master, workspace_id, soul_md, user_md, agents_md, source, gateway_agent_id, session_key_prefix, mapping_status, mapping_error, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'standby', ?, ?, ?, ?, ?, 'gateway', ?, ?, 'mapped', NULL, ?, ?)
  `);

  for (const agent of CORE_AGENTS) {
    const id = crypto.randomUUID();
    insert.run(
      id,
      agent.name,
      agent.role,
      `${agent.name} — core team member`,
      agent.emoji,
      agent.isMaster ? 1 : 0,
      workspaceId,
      agent.soulMd,
      userMd,
      SHARED_AGENTS_MD,
      agent.gatewayAgentId || agent.name.toLowerCase().replace(/\s+/g, '-'),
      agent.sessionKeyPrefix || `agent:${agent.gatewayAgentId || agent.name.toLowerCase().replace(/\s+/g, '-')}:`,
      now,
      now,
    );
    console.log(`[Bootstrap] Created ${agent.name} (${agent.role}) for workspace ${workspaceId}`);
  }
}

/**
 * Clone workflow templates from the default workspace into a new workspace.
 */
export function cloneWorkflowTemplates(db: Database.Database, targetWorkspaceId: string): void {
  const templates = db.prepare(
    "SELECT * FROM workflow_templates WHERE workspace_id = 'default'"
  ).all() as { id: string; name: string; description: string; stages: string; fail_targets: string; is_default: number }[];

  if (templates.length === 0) return;

  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT INTO workflow_templates (id, workspace_id, name, description, stages, fail_targets, is_default, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const tpl of templates) {
    const newId = `${tpl.id}-${targetWorkspaceId}`;
    insert.run(newId, targetWorkspaceId, tpl.name, tpl.description, tpl.stages, tpl.fail_targets, tpl.is_default, now, now);
  }

  console.log(`[Bootstrap] Cloned ${templates.length} workflow template(s) to workspace ${targetWorkspaceId}`);
}
