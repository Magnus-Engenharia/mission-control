import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { queryOne, queryAll, run } from '@/lib/db';
import { getOpenClawClient } from '@/lib/openclaw/client';
import { broadcast } from '@/lib/events';
import { getProjectsPath, getMissionControlUrl } from '@/lib/config';
import { getRelevantKnowledge, formatKnowledgeForDispatch } from '@/lib/learner';
import { getTaskWorkflow } from '@/lib/workflow-engine';
import type { Task, Agent, OpenClawSession, WorkflowStage } from '@/lib/types';

export const dynamic = 'force-dynamic';
interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/tasks/[id]/dispatch
 * 
 * Dispatches a task to its assigned agent's OpenClaw session.
 * Creates session if needed, sends task details to agent.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;

    // Get task with agent info
    const task = queryOne<Task & { assigned_agent_name?: string; workspace_id: string; project_name?: string; project_repo_path?: string }>(
      `SELECT t.*, a.name as assigned_agent_name, a.is_master,
              p.name as project_name, p.repo_path as project_repo_path
       FROM tasks t
       LEFT JOIN agents a ON t.assigned_agent_id = a.id
       LEFT JOIN projects p ON t.project_id = p.id
       WHERE t.id = ?`,
      [id]
    );

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    if (!task.assigned_agent_id) {
      return NextResponse.json(
        { error: 'Task has no assigned agent' },
        { status: 400 }
      );
    }

    const workspaceMeta = queryOne<{ default_phase?: 'mvp' | 'growth' | 'stabilizing' }>(
      'SELECT default_phase FROM workspaces WHERE id = ?',
      [task.workspace_id]
    );
    const workspacePhase = workspaceMeta?.default_phase || 'mvp';

    // Get agent details
    const agent = queryOne<Agent>(
      'SELECT * FROM agents WHERE id = ?',
      [task.assigned_agent_id]
    );

    if (!agent) {
      return NextResponse.json({ error: 'Assigned agent not found' }, { status: 404 });
    }

    if (agent.mapping_status && agent.mapping_status !== 'mapped') {
      return NextResponse.json(
        {
          error: 'Assigned agent is not mapped to an OpenClaw agent',
          mapping_status: agent.mapping_status,
          mapping_error: agent.mapping_error || null,
          message: 'Map this board agent to an OpenClaw agent before dispatching.',
        },
        { status: 409 }
      );
    }

    // Builder execution discipline: one active task at a time.
    if (agent.role === 'builder') {
      const activeBuilderTask = queryOne<{ id: string; title: string; status: string }>(
        `SELECT id, title, status FROM tasks
         WHERE assigned_agent_id = ?
           AND id != ?
           AND status IN ('assigned','in_progress','testing','review','verification')
         ORDER BY updated_at DESC
         LIMIT 1`,
        [agent.id, task.id]
      );

      if (activeBuilderTask) {
        return NextResponse.json(
          {
            error: 'Builder already has an active task',
            message: `Builder must run one task at a time. Active task: ${activeBuilderTask.title} (${activeBuilderTask.status}).`,
            active_task: activeBuilderTask,
          },
          { status: 409 }
        );
      }
    }

    // Check if dispatching to the master agent while there are other orchestrators available
    if (agent.is_master) {
      // Check for other master agents in the same workspace (excluding this one)
      const otherOrchestrators = queryAll<{
        id: string;
        name: string;
        role: string;
      }>(
        `SELECT id, name, role
         FROM agents
         WHERE is_master = 1
         AND id != ?
         AND workspace_id = ?
         AND status != 'offline'`,
        [agent.id, task.workspace_id]
      );

      if (otherOrchestrators.length > 0) {
        return NextResponse.json({
          success: false,
          warning: 'Other orchestrators available',
          message: `There ${otherOrchestrators.length === 1 ? 'is' : 'are'} ${otherOrchestrators.length} other orchestrator${otherOrchestrators.length === 1 ? '' : 's'} available in this workspace: ${otherOrchestrators.map(o => o.name).join(', ')}. Consider assigning this task to them instead.`,
          otherOrchestrators,
        }, { status: 409 }); // 409 Conflict - indicating there's an alternative
      }
    }

    // Connect to OpenClaw Gateway
    const client = getOpenClawClient();
    if (!client.isConnected()) {
      try {
        await client.connect();
      } catch (err) {
        console.error('Failed to connect to OpenClaw Gateway:', err);
        return NextResponse.json(
          { error: 'Failed to connect to OpenClaw Gateway' },
          { status: 503 }
        );
      }
    }

    // Get or create OpenClaw session for this agent
    let session = queryOne<OpenClawSession>(
      'SELECT * FROM openclaw_sessions WHERE agent_id = ? AND status = ?',
      [agent.id, 'active']
    );

    const now = new Date().toISOString();

    if (!session) {
      // Create session record
      const sessionId = uuidv4();
      const openclawSessionId = `mission-control-${agent.name.toLowerCase().replace(/\s+/g, '-')}`;
      
      run(
        `INSERT INTO openclaw_sessions (id, agent_id, openclaw_session_id, channel, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [sessionId, agent.id, openclawSessionId, 'mission-control', 'active', now, now]
      );

      session = queryOne<OpenClawSession>(
        'SELECT * FROM openclaw_sessions WHERE id = ?',
        [sessionId]
      );

      // Log session creation
      run(
        `INSERT INTO events (id, type, agent_id, message, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [uuidv4(), 'agent_status_changed', agent.id, `${agent.name} session created`, now]
      );
    }

    if (!session) {
      return NextResponse.json(
        { error: 'Failed to create agent session' },
        { status: 500 }
      );
    }

    // Build task message for agent
    const priorityEmoji = {
      low: '🔵',
      normal: '⚪',
      high: '🟡',
      urgent: '🔴'
    }[task.priority] || '⚪';

    // Resolve project path for deliverables
    const projectsPath = getProjectsPath();
    const projectDir = task.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const fallbackTaskProjectDir = `${projectsPath}/${projectDir}`;
    const targetSubdir = ((task as Task & { target?: string }).target === 'web') ? 'apps/web' : ((task as Task & { target?: string }).target === 'api') ? 'apps/api' : ((task as Task & { target?: string }).target === 'mobile') ? 'apps/mobile' : '';
    const taskProjectDir = task.project_id && task.project_repo_path
      ? `${task.project_repo_path.replace(/\/$/, '')}${targetSubdir ? `/${targetSubdir}` : ''}`
      : fallbackTaskProjectDir;
    const missionControlUrl = getMissionControlUrl();

    const projectContextSection = task.project_id && task.project_repo_path
      ? `**PROJECT:** ${task.project_name || task.project_id}\n**PROJECT ROOT:** ${task.project_repo_path}\n`
      : '';


    // Parse planning_spec and planning_agents if present (stored as JSON text on the task row)
    const rawTask = task as Task & { assigned_agent_name?: string; workspace_id: string; planning_spec?: string; planning_agents?: string };
    let planningSpecSection = '';
    let agentInstructionsSection = '';

    if (rawTask.planning_spec) {
      try {
        const spec = JSON.parse(rawTask.planning_spec);
        // planning_spec may be an object with spec_markdown, or a raw string
        const specText = typeof spec === 'string' ? spec : (spec.spec_markdown || JSON.stringify(spec, null, 2));
        planningSpecSection = `\n---\n**📋 PLANNING SPECIFICATION:**\n${specText}\n`;
      } catch {
        // If not valid JSON, treat as plain text
        planningSpecSection = `\n---\n**📋 PLANNING SPECIFICATION:**\n${rawTask.planning_spec}\n`;
      }
    }

    if (rawTask.planning_agents) {
      try {
        const agents = JSON.parse(rawTask.planning_agents);
        if (Array.isArray(agents)) {
          // Find instructions for this specific agent, or include all if none match
          const myInstructions = agents.find(
            (a: { agent_id?: string; name?: string; instructions?: string }) =>
              a.agent_id === agent.id || a.name === agent.name
          );
          if (myInstructions?.instructions) {
            agentInstructionsSection = `\n**🎯 YOUR INSTRUCTIONS:**\n${myInstructions.instructions}\n`;
          } else {
            // Include all agent instructions for context
            const allInstructions = agents
              .filter((a: { instructions?: string }) => a.instructions)
              .map((a: { name?: string; role?: string; instructions?: string }) =>
                `- **${a.name || a.role || 'Agent'}:** ${a.instructions}`
              )
              .join('\n');
            if (allInstructions) {
              agentInstructionsSection = `\n**🎯 AGENT INSTRUCTIONS:**\n${allInstructions}\n`;
            }
          }
        }
      } catch {
        // Ignore malformed planning_agents JSON
      }
    }

    // Inject relevant knowledge from the learner knowledge base
    let knowledgeSection = '';
    try {
      const knowledge = getRelevantKnowledge(task.workspace_id, task.title);
      knowledgeSection = formatKnowledgeForDispatch(knowledge);
    } catch {
      // Knowledge injection is best-effort
    }

    // Determine role-specific instructions based on workflow template
    const workflow = getTaskWorkflow(id);
    let currentStage: WorkflowStage | undefined;
    let nextStage: WorkflowStage | undefined;
    if (workflow) {
      let stageIndex = workflow.stages.findIndex(s => s.status === task.status);
      // 'assigned' isn't a workflow stage — resolve to the 'build' stage (in_progress)
      if (stageIndex < 0 && (task.status === 'assigned' || task.status === 'inbox')) {
        stageIndex = workflow.stages.findIndex(s => s.role === 'builder');
      }
      if (stageIndex >= 0) {
        currentStage = workflow.stages[stageIndex];
        nextStage = workflow.stages[stageIndex + 1];
      }
    }

    const isBuilder = !currentStage || currentStage.role === 'builder' || task.status === 'assigned';
    const isTester = currentStage?.role === 'tester';
    const isLearner = currentStage?.role === 'learner';
    const isVerifier = currentStage?.role === 'verifier' || currentStage?.role === 'reviewer';
    const nextStatus = nextStage?.status || 'review';
    const failEndpoint = `POST ${missionControlUrl}/api/tasks/${task.id}/fail`;

    const mvpPushMainInstructions = workspacePhase === 'mvp'
      ? `
MVP RELEASE RULE (mandatory when this stage approves):
- Ensure code is committed and pushed to \`main\` in project root: ${task.project_repo_path || taskProjectDir}
- Required commands (adapt if already clean):
  1. \`git add -A\`
  2. \`git commit -m "feat: finalize ${task.title.replace(/"/g, '\\"')}"\`
  3. \`git push origin main\`
- If push fails, report via fail endpoint with exact reason.`
      : '';

    let completionInstructions: string;
    if (isBuilder) {
      completionInstructions = `**YOUR ROLE: BUILDER** — Read project docs first, then plan and implement.

Before coding:
- Read relevant project docs (e.g. PROJECT_CRITICALS.md, feature docs, task context).
- State your implementation plan briefly in activity logs.

After completing work, you MUST call these APIs:
1. Log activity: POST ${missionControlUrl}/api/tasks/${task.id}/activities
   Body: {"activity_type": "completed", "message": "Description of what was done + key files changed"}
2. Register deliverable: POST ${missionControlUrl}/api/tasks/${task.id}/deliverables
   Body: {"deliverable_type": "file", "title": "File name", "path": "${taskProjectDir}/filename.html"}
3. Update status: PATCH ${missionControlUrl}/api/tasks/${task.id}
   Body: {"status": "${nextStatus}"}

When complete, reply with:
\`TASK_COMPLETE: [brief summary of what you did]\``;
    } else if (isTester) {
      completionInstructions = `**YOUR ROLE: TESTER** — Test based on builder's changes (git diff) and deliverables.

Review builder's changed files / git diff and run applicable tests for impacted surfaces.

**If tests PASS:**
1. Log activity: POST ${missionControlUrl}/api/tasks/${task.id}/activities
   Body: {"activity_type": "completed", "message": "Tests passed: [summary]"}
2. Update status: PATCH ${missionControlUrl}/api/tasks/${task.id}
   Body: {"status": "${nextStatus}"}

**If tests FAIL:**
1. ${failEndpoint}
   Body: {"reason": "Detailed description of what failed and what needs fixing"}

Reply with: \`TEST_PASS: [summary]\` or \`TEST_FAIL: [what failed]\``;
    } else if (isLearner) {
      completionInstructions = `**YOUR ROLE: LEARNER (EXECUTION MODE)** — Produce concrete documentation artifacts from actual code changes.

NON-NEGOTIABLE RULES:
- Do NOT only "discuss" or brainstorm with the model.
- Inspect real implementation evidence (files changed, tests, task activities, deliverables).
- Write/update concrete docs in repo path: ${taskProjectDir}

Minimum required actions before completion:
1) Inspect what changed (builder/reviewer outputs + changed files)
2) Update ${taskProjectDir}/PROJECT_CRITICALS.md with a new section:
   "## Learner Notes — Task ${task.id}"
   Include:
   - what was implemented
   - key technical decisions and trade-offs
   - known risks / follow-ups
   - reusable checklist/pattern
3) If API/contracts involved, also update/create ${taskProjectDir}/PROJECT_FEATURES.md with a concise delta note.

Completion criteria (must satisfy all):
- Documentation file(s) actually updated in repo
- Notes are specific to this task (not generic)
- At least one reusable pattern/checklist extracted

If documentation is sufficient:
1. Log activity: POST ${missionControlUrl}/api/tasks/${task.id}/activities
   Body: {"activity_type": "completed", "message": "Learner summary: docs updated with concrete implementation notes"}
2. Register deliverable: POST ${missionControlUrl}/api/tasks/${task.id}/deliverables
   Body: {"deliverable_type": "documentation", "title": "Learner Notes", "path": "${taskProjectDir}/PROJECT_CRITICALS.md"}
3. Update status: PATCH ${missionControlUrl}/api/tasks/${task.id}
   Body: {"status": "${nextStatus}"}
${mvpPushMainInstructions}

If documentation is missing critical context or files were not updated:
1. ${failEndpoint}
   Body: {"reason": "Learner did not produce concrete documentation artifacts"}

Reply with: \`LEARN_DONE: [summary + files updated]\` or \`LEARN_FAIL: [what is missing]\``;
    } else if (isVerifier) {
      completionInstructions = `**YOUR ROLE: VERIFIER** — Verify that all work meets quality standards.

Review deliverables, test results, and task requirements.

**If verification PASSES:**
1. Log activity: POST ${missionControlUrl}/api/tasks/${task.id}/activities
   Body: {"activity_type": "completed", "message": "Verification passed: [summary]"}
2. Update status: PATCH ${missionControlUrl}/api/tasks/${task.id}
   Body: {"status": "${nextStatus}"}
${mvpPushMainInstructions}

**If verification FAILS:**
1. ${failEndpoint}
   Body: {"reason": "Detailed description of what failed and what needs fixing"}

Reply with: \`VERIFY_PASS: [summary]\` or \`VERIFY_FAIL: [what failed]\``;
    } else {
      // Fallback for unknown roles
      completionInstructions = `**IMPORTANT:** After completing work:
1. Update status: PATCH ${missionControlUrl}/api/tasks/${task.id}
   Body: {"status": "${nextStatus}"}`;
    }

    const roleLabel = currentStage?.label || 'Task';
    const taskMessage = `${priorityEmoji} **${isBuilder ? 'NEW TASK ASSIGNED' : `${roleLabel.toUpperCase()} STAGE — ${task.title}`}**

**Title:** ${task.title}
${task.description ? `**Description:** ${task.description}\n` : ''}
**Priority:** ${task.priority.toUpperCase()}
**Target:** ${((task as Task & { target?: string }).target || 'fullstack').toUpperCase()}
${task.due_date ? `**Due:** ${task.due_date}\n` : ''}
**Task ID:** ${task.id}
${projectContextSection}${planningSpecSection}${agentInstructionsSection}${knowledgeSection}
${isBuilder ? `**OUTPUT DIRECTORY:** ${taskProjectDir}\nUse this project directory as your working/output path. Create it only if it does not exist.\n` : `**OUTPUT DIRECTORY:** ${taskProjectDir}\n`}
${completionInstructions}

If you need help or clarification, ask the orchestrator.`;

    // Send message to agent's session using chat.send
    try {
      // Use sessionKey for routing to the agent's session
      // Format: {prefix}{openclaw_session_id}. Do NOT fallback to main.
      const normalizedAgentName = agent.name?.toLowerCase().replace(/\s+/g, '-') || '';
      const derivedPrefix =
        agent.gateway_agent_id ? `agent:${agent.gateway_agent_id}:` :
        (agent.source === 'gateway' && normalizedAgentName ? `agent:${normalizedAgentName}:` : null);
      const prefix = agent.session_key_prefix || derivedPrefix;
      if (!prefix) {
        return NextResponse.json(
          { error: `Agent ${agent.name} is missing session_key_prefix; refusing dispatch to avoid main-model fallback.` },
          { status: 400 }
        );
      }

      // Persist auto-derived prefix for future dispatches
      if (!agent.session_key_prefix && derivedPrefix) {
        run('UPDATE agents SET session_key_prefix = ?, updated_at = ? WHERE id = ?', [derivedPrefix, now, agent.id]);
      }

      const sessionKey = `${prefix}${session.openclaw_session_id}`;
      await client.call('chat.send', {
        sessionKey,
        message: taskMessage,
        idempotencyKey: `dispatch-${task.id}-${Date.now()}`
      });

      // Only move to in_progress for builder dispatch (task is in 'assigned' status)
      // For tester/reviewer/verifier, the task status is already correct
      if (task.status === 'assigned') {
        run(
          'UPDATE tasks SET status = ?, planning_dispatch_error = NULL, updated_at = ? WHERE id = ?',
          ['in_progress', now, id]
        );
      } else {
        run(
          'UPDATE tasks SET planning_dispatch_error = NULL, updated_at = ? WHERE id = ?',
          [now, id]
        );
      }

      // Broadcast task update
      const updatedTask = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [id]);
      if (updatedTask) {
        broadcast({
          type: 'task_updated',
          payload: updatedTask,
        });
      }

      // Update agent status to working
      run(
        'UPDATE agents SET status = ?, updated_at = ? WHERE id = ?',
        ['working', now, agent.id]
      );

      // Log dispatch event to events table
      const eventId = uuidv4();
      run(
        `INSERT INTO events (id, type, agent_id, task_id, message, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [eventId, 'task_dispatched', agent.id, task.id, `Task "${task.title}" dispatched to ${agent.name}`, now]
      );

      // Log dispatch activity to task_activities table (for Activity tab)
      const activityId = crypto.randomUUID();
      run(
        `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [activityId, task.id, agent.id, 'status_changed', `Task dispatched to ${agent.name} - Agent is now working on this task`, now]
      );

      return NextResponse.json({
        success: true,
        task_id: task.id,
        agent_id: agent.id,
        session_id: session.openclaw_session_id,
        message: 'Task dispatched to agent'
      });
    } catch (err) {
      console.error('Failed to send message to agent:', err);
      return NextResponse.json(
        { error: 'Internal server error' },
        { status: 500 }
      );
    }
  } catch (error) {
    console.error('Failed to dispatch task:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
