import { NextRequest, NextResponse } from 'next/server';
import { getDb, queryAll, queryOne, run } from '@/lib/db';
import { getOpenClawClient } from '@/lib/openclaw/client';
import { broadcast } from '@/lib/events';
import { extractJSON } from '@/lib/planning-utils';
// File system imports removed - using OpenClaw API instead

export const dynamic = 'force-dynamic';

// Default planning session prefix for OpenClaw
// Can be overridden per-agent via the session_key_prefix column on agents table
const DEFAULT_SESSION_KEY_PREFIX = 'agent:main:';

// GET /api/tasks/[id]/planning - Get planning state
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: taskId } = await params;

  try {
    // Get task
    const task = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as {
      id: string;
      title: string;
      description: string;
      status: string;
      planning_session_key?: string;
      planning_messages?: string;
      planning_complete?: number;
      planning_spec?: string;
      planning_agents?: string;
    } | undefined;
    
    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // Parse planning messages from JSON
    const messages = task.planning_messages ? JSON.parse(task.planning_messages) : [];

    // Find the latest question (last assistant message with question structure)
    const lastAssistantMessage = [...messages].reverse().find((m: { role: string }) => m.role === 'assistant');
    let currentQuestion = null;

    if (lastAssistantMessage) {
      // Use extractJSON to handle code blocks and surrounding text
      const parsed = extractJSON(lastAssistantMessage.content);
      if (parsed && 'question' in parsed) {
        currentQuestion = parsed;
      }
    }

    return NextResponse.json({
      taskId,
      sessionKey: task.planning_session_key,
      messages,
      currentQuestion,
      isComplete: !!task.planning_complete,
      spec: task.planning_spec ? JSON.parse(task.planning_spec) : null,
      agents: task.planning_agents ? JSON.parse(task.planning_agents) : null,
      isStarted: messages.length > 0,
    });
  } catch (error) {
    console.error('Failed to get planning state:', error);
    return NextResponse.json({ error: 'Failed to get planning state' }, { status: 500 });
  }
}

// POST /api/tasks/[id]/planning - Start planning session
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: taskId } = await params;

  try {
    // Get task
    const task = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as {
      id: string;
      title: string;
      description: string;
      status: string;
      workspace_id: string;
      workflow_template_id?: string | null;
      project_id?: string | null;
      planning_session_key?: string;
      planning_messages?: string;
    } | undefined;

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // Check if planning already started
    if (task.planning_session_key) {
      return NextResponse.json({ error: 'Planning already started', sessionKey: task.planning_session_key }, { status: 400 });
    }

    // Check if there are other orchestrators available before starting planning with the default master agent
    // Get the default master agent for this workspace
    const defaultMaster = queryOne<{ id: string; role?: string; session_key_prefix?: string }>(
      `SELECT id, role, session_key_prefix
       FROM agents
       WHERE is_master = 1 AND workspace_id = ?
       ORDER BY CASE WHEN role = 'planner' THEN 0 ELSE 1 END, created_at ASC
       LIMIT 1`,
      [task.workspace_id]
    );

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
      [defaultMaster?.id ?? '', task.workspace_id]
    );

    // Keep legacy conflict guard only when planner master is not configured.
    if (defaultMaster?.role !== 'planner' && otherOrchestrators.length > 0) {
      return NextResponse.json({
        error: 'Other orchestrators available',
        message: `There ${otherOrchestrators.length === 1 ? 'is' : 'are'} ${otherOrchestrators.length} other orchestrator${otherOrchestrators.length === 1 ? '' : 's'} available in this workspace: ${otherOrchestrators.map(o => o.name).join(', ')}. Please assign this task to them directly.`,
        otherOrchestrators,
      }, { status: 409 }); // 409 Conflict
    }

    // Create session key for this planning task
    // Use the master agent's session_key_prefix if set, otherwise default to 'agent:main:'
    const planningPrefix = (defaultMaster?.session_key_prefix || DEFAULT_SESSION_KEY_PREFIX) + 'planning:';
    const sessionKey = `${planningPrefix}${taskId}`;

    const planningText = `${task.title} ${task.description || ''}`.toLowerCase();
    const stackAlreadyDefined = /(\bios\b|\bandroid\b|\bflutter\b|\breact native\b|\bvue\b|\brails\b|\bnext\.?(js)?\b|\bnode\b|\bsupabase\b|\bfirebase\b|\bpython\b|\bdjango\b|\bfastapi\b)/i.test(planningText);

    const workspaceMeta = queryOne<{ default_phase?: 'mvp' | 'growth' | 'stabilizing'; name: string }>(
      'SELECT name, default_phase FROM workspaces WHERE id = ?',
      [task.workspace_id]
    );

    const workflowTemplate = task.workflow_template_id
      ? queryOne<{ id: string; name: string; description?: string; stages?: string }>(
          'SELECT id, name, description, stages FROM workflow_templates WHERE id = ?',
          [task.workflow_template_id]
        )
      : null;

    const defaultWorkflowTemplate = !workflowTemplate
      ? queryOne<{ id: string; name: string; description?: string; stages?: string }>(
          'SELECT id, name, description, stages FROM workflow_templates WHERE workspace_id = ? AND is_default = 1 LIMIT 1',
          [task.workspace_id]
        )
      : null;

    const selectedTemplate = workflowTemplate || defaultWorkflowTemplate;

    let templateStagesText = 'N/A';
    if (selectedTemplate?.stages) {
      try {
        const stages = JSON.parse(selectedTemplate.stages) as Array<{ label?: string; role?: string | null; status?: string }>;
        templateStagesText = stages
          .map((s, i) => `${i + 1}. ${s.label || s.status || 'stage'} (${s.role || 'no-role'})`)
          .join('\n');
      } catch {
        templateStagesText = String(selectedTemplate.stages);
      }
    }

    const phase = workspaceMeta?.default_phase || 'mvp';

    // Build the initial planning prompt
    const planningPrompt = `PLANNING REQUEST

Task Title: ${task.title}
Task Description: ${task.description || 'No description provided'}
Workspace: ${workspaceMeta?.name || task.workspace_id}
Workspace default phase: ${phase}
Selected base workflow template: ${selectedTemplate?.name || 'None'}
Template description: ${selectedTemplate?.description || 'N/A'}
Template stages:
${templateStagesText}

Follow the planning protocol in PLANNING.md (repo root) and apply these rules:
- Use the selected base workflow template as the default execution backbone (do not ignore it).
- Ask focused, task-specific multiple-choice questions.
- Include an "Other" option.
- Stop asking once the task is sufficiently specified for execution.
- Final plan must use canonical roles only: planner, builder, tester, reviewer, learner (optional).
- Do NOT use legacy role aliases in outputs (backend-engineer, frontend-engineer, mobile-engineer, verifier, orchestrator, qa).
- If stack/tecnologia já estiver definida no contexto, NÃO pergunte sobre stack novamente; avance para as próximas clarificações relevantes.
- Phase guidance: 
  - mvp: prioritize must-have scope, fastest path to usable delivery
  - growth: prioritize expansion features and measurable impact
  - stabilizing: prioritize reliability, quality, and operational hardening
${stackAlreadyDefined ? '- Stack já identificada no contexto desta task: NÃO faça pergunta de stack.' : ''}

Generate your FIRST question now.

Respond with ONLY valid JSON in this format:
{
  "question": "Your question here?",
  "options": [
    {"id": "A", "label": "First option"},
    {"id": "B", "label": "Second option"},
    {"id": "C", "label": "Third option"},
    {"id": "other", "label": "Other"}
  ]
}`;

    // Connect to OpenClaw and send the planning request
    const client = getOpenClawClient();
    if (!client.isConnected()) {
      await client.connect();
    }

    // Send planning request to the planning session
    await client.call('chat.send', {
      sessionKey: sessionKey,
      message: planningPrompt,
      idempotencyKey: `planning-start-${taskId}-${Date.now()}`,
    });

    // Store the session key and initial message
    const messages = [{ role: 'user', content: planningPrompt, timestamp: Date.now() }];

    getDb().prepare(`
      UPDATE tasks
      SET planning_session_key = ?, planning_messages = ?, status = 'planning'
      WHERE id = ?
    `).run(sessionKey, JSON.stringify(messages), taskId);

    // Return immediately - frontend will poll for updates
    // This eliminates the aggressive polling loop that was making 30+ OpenClaw API calls
    return NextResponse.json({
      success: true,
      sessionKey,
      messages,
      note: 'Planning started. Poll GET endpoint for updates.',
    });
  } catch (error) {
    console.error('Failed to start planning:', error);
    return NextResponse.json({ error: 'Failed to start planning: ' + (error as Error).message }, { status: 500 });
  }
}

// DELETE /api/tasks/[id]/planning - Cancel planning session
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: taskId } = await params;

  try {
    // Get task to check session key
    const task = queryOne<{
      id: string;
      planning_session_key?: string;
      status: string;
    }>(
      'SELECT * FROM tasks WHERE id = ?',
      [taskId]
    );

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // Clear planning-related fields
    run(`
      UPDATE tasks
      SET planning_session_key = NULL,
          planning_messages = NULL,
          planning_complete = 0,
          planning_spec = NULL,
          planning_agents = NULL,
          status = 'inbox',
          updated_at = datetime('now')
      WHERE id = ?
    `, [taskId]);

    // Broadcast task update
    const updatedTask = queryOne('SELECT * FROM tasks WHERE id = ?', [taskId]);
    if (updatedTask) {
      broadcast({
        type: 'task_updated',
        payload: updatedTask as any, // Cast to any to satisfy SSEEvent payload union type
      });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to cancel planning:', error);
    return NextResponse.json({ error: 'Failed to cancel planning: ' + (error as Error).message }, { status: 500 });
  }
}
