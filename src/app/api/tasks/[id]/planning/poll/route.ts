import { NextRequest, NextResponse } from 'next/server';
import { queryOne, run, getDb, queryAll } from '@/lib/db';
import { getOpenClawClient } from '@/lib/openclaw/client';
import { broadcast } from '@/lib/events';
import { getMissionControlUrl } from '@/lib/config';
import { extractJSON, getMessagesFromOpenClaw } from '@/lib/planning-utils';
import { Task } from '@/lib/types';

export const dynamic = 'force-dynamic';
// Planning timeout and poll interval configuration with validation
const PLANNING_TIMEOUT_MS = parseInt(process.env.PLANNING_TIMEOUT_MS || '30000', 10);
const PLANNING_POLL_INTERVAL_MS = parseInt(process.env.PLANNING_POLL_INTERVAL_MS || '2000', 10);

// Validate environment variables
if (isNaN(PLANNING_TIMEOUT_MS) || PLANNING_TIMEOUT_MS < 1000) {
  throw new Error('PLANNING_TIMEOUT_MS must be a valid number >= 1000ms');
}
if (isNaN(PLANNING_POLL_INTERVAL_MS) || PLANNING_POLL_INTERVAL_MS < 100) {
  throw new Error('PLANNING_POLL_INTERVAL_MS must be a valid number >= 100ms');
}

// Helper to handle planning completion with proper error handling
async function handlePlanningCompletion(taskId: string, parsed: any, messages: any[]) {
  const db = getDb();

  const taskMeta = queryOne<{ title?: string; description?: string; workspace_id?: string }>(
    'SELECT title, description, workspace_id FROM tasks WHERE id = ?',
    [taskId]
  );
  const taskText = `${taskMeta?.title || ''} ${taskMeta?.description || ''}`.toLowerCase();
  const mobileIntent = /(\bios\b|\biphone\b|\bipad\b|\bswift\b|\bswiftui\b|\bmobile\b|\bandroid\b|react native|flutter)/i.test(taskText);

  const normalizeRole = (role: string | undefined): string => {
    const r = (role || '').trim().toLowerCase();
    if (!r) return 'unmapped';

    const aliases: Record<string, string> = {
      planner: 'planner',
      'master-planner': 'planner',
      orchestrator: 'planner',

      backend: 'backend-engineer',
      'backend-engineer': 'backend-engineer',
      'back-end': 'backend-engineer',
      builder: 'backend-engineer',

      frontend: 'frontend-engineer',
      'front-end': 'frontend-engineer',
      'frontend-engineer': 'frontend-engineer',
      ui: 'frontend-engineer',

      mobile: 'mobile-engineer',
      'mobile-engineer': 'mobile-engineer',
      ios: 'mobile-engineer',

      tester: 'tester',
      qa: 'tester',
      'quality-assurance': 'tester',

      reviewer: 'reviewer',
      verifier: 'reviewer',
      'code-reviewer': 'reviewer',
    };

    return aliases[r] || r;
  };
  let dispatchError: string | null = null;
  let firstAgentId: string | null = null;
  let firstDispatchableAgentId: string | null = null;

  // Transaction 1: Save planning data, create agents, AND assign agent to task
  // (Assigning before dispatch fixes the chicken-and-egg bug where dispatch
  // checks assigned_agent_id and fails because it wasn't set yet)
  const transaction = db.transaction(() => {
    const allowDynamicAgents = process.env.ALLOW_DYNAMIC_AGENTS !== 'false';
    const workspace = db.prepare('SELECT workspace_id FROM tasks WHERE id = ?').get(taskId) as { workspace_id: string } | undefined;
    const workspaceId = workspace?.workspace_id;

    if (parsed.agents && parsed.agents.length > 0 && workspaceId) {
      const findMappedByRole = db.prepare(`
        SELECT id, mapping_status
        FROM agents
        WHERE workspace_id = ?
          AND lower(role) = lower(?)
          AND mapping_status = 'mapped'
        ORDER BY created_at ASC
        LIMIT 1
      `);

      const findMappedMobile = db.prepare(`
        SELECT id
        FROM agents
        WHERE workspace_id = ?
          AND mapping_status = 'mapped'
          AND (lower(role) = 'mobile-engineer' OR lower(name) = 'mobile-engineer')
        ORDER BY created_at ASC
        LIMIT 1
      `);

      const resolveRoleForTask = (normalizedRole: string): string => {
        if (!mobileIntent) return normalizedRole;
        if (normalizedRole === 'backend-engineer' || normalizedRole === 'frontend-engineer') {
          const mobile = findMappedMobile.get(workspaceId) as { id: string } | undefined;
          if (mobile?.id) return 'mobile-engineer';
        }
        return normalizedRole;
      };

      const insertProvisional = db.prepare(`
        INSERT INTO agents (
          id, workspace_id, name, role, description, avatar_emoji, status, source,
          mapping_status, mapping_error, provisional_from_task_id, soul_md, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, 'offline', 'provisional', 'failed', ?, ?, ?, datetime('now'), datetime('now'))
      `);

      for (const plannedAgent of parsed.agents) {
        const normalizedRole = normalizeRole(plannedAgent.role);
        const effectiveRole = resolveRoleForTask(normalizedRole);
        const mapped = findMappedByRole.get(workspaceId, effectiveRole) as { id: string; mapping_status: string } | undefined;

        if (mapped?.id) {
          if (!firstAgentId) firstAgentId = mapped.id;
          if (!firstDispatchableAgentId) firstDispatchableAgentId = mapped.id;
          continue;
        }

        if (!allowDynamicAgents) {
          continue;
        }

        const provisionalId = crypto.randomUUID();
        if (!firstAgentId) firstAgentId = provisionalId;

        const role = effectiveRole || normalizedRole || 'unmapped';
        insertProvisional.run(
          provisionalId,
          workspaceId,
          plannedAgent.name || `${role} (unmapped)`,
          role,
          plannedAgent.instructions || 'Planned agent created in failed state pending manual OpenClaw mapping.',
          plannedAgent.avatar_emoji || '⚠️',
          `Unmapped planned role "${plannedAgent.role || role}" (normalized: "${role}"). Map this board agent to an OpenClaw agent to activate.`,
          taskId,
          plannedAgent.soul_md || ''
        );
      }
    } else if (!allowDynamicAgents && parsed.agents && parsed.agents.length > 0) {
      console.log(`[Planning Poll] Dynamic agent generation disabled (ALLOW_DYNAMIC_AGENTS=false), skipping creation of ${parsed.agents.length} agent(s)`);
    }

    const taskStatus = firstAgentId ? 'assigned' : 'inbox';

    // Save planning data + assign first planned/mapped agent + mark complete in one atomic step
    db.prepare(`
      UPDATE tasks
      SET planning_messages = ?,
          planning_spec = ?,
          planning_agents = ?,
          planning_complete = 1,
          assigned_agent_id = ?,
          status = ?,
          planning_dispatch_error = NULL,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(
      JSON.stringify(messages),
      JSON.stringify(parsed.spec),
      JSON.stringify(parsed.agents),
      firstAgentId,
      taskStatus,
      taskId
    );

    return firstAgentId;
  });

  firstAgentId = transaction();

  if (firstAgentId && !firstDispatchableAgentId) {
    dispatchError = 'Planned agent was created in failed state (unmapped). Map it to an OpenClaw agent before dispatch.';
  }

  // Re-check for other orchestrators before dispatching
  if (firstDispatchableAgentId) {
    const task = queryOne<{ workspace_id: string }>('SELECT workspace_id FROM tasks WHERE id = ?', [taskId]);
    if (task) {
      const defaultMaster = queryOne<{ id: string }>(
        `SELECT id
         FROM agents
         WHERE is_master = 1 AND workspace_id = ?
         ORDER BY CASE WHEN role = 'planner' THEN 0 ELSE 1 END, created_at ASC
         LIMIT 1`,
        [task.workspace_id]
      );
      const otherOrchestrators = queryAll<{ id: string; name: string }>(
        `SELECT id, name FROM agents WHERE is_master = 1 AND id != ? AND workspace_id = ? AND status != 'offline'`,
        [defaultMaster?.id ?? '', task.workspace_id]
      );

      if (otherOrchestrators.length > 0) {
        dispatchError = `Cannot auto-dispatch: ${otherOrchestrators.length} other orchestrator(s) available in workspace`;
        console.warn(`[Planning Poll] ${dispatchError}:`, otherOrchestrators.map(o => o.name).join(', '));
        firstDispatchableAgentId = null;
      }
    }
  }

  // Idempotency check
  let skipDispatch = false;
  if (firstDispatchableAgentId) {
    const currentTask = queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [taskId]);
    if (currentTask?.status === 'in_progress') {
      console.log('[Planning Poll] Task already in progress, skipping dispatch');
      skipDispatch = true;
    }
  }

  // Trigger dispatch using proper URL resolution
  if (firstDispatchableAgentId && !skipDispatch) {
    const missionControlUrl = getMissionControlUrl();
    const dispatchUrl = `${missionControlUrl}/api/tasks/${taskId}/dispatch`;
    console.log(`[Planning Poll] Triggering dispatch: ${dispatchUrl}`);

    try {
      const dispatchHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
      if (process.env.MC_API_TOKEN) {
        dispatchHeaders['Authorization'] = `Bearer ${process.env.MC_API_TOKEN}`;
      }

      const dispatchRes = await fetch(dispatchUrl, {
        method: 'POST',
        headers: dispatchHeaders,
      });

      if (dispatchRes.ok) {
        console.log(`[Planning Poll] Dispatch successful`);
      } else {
        const errorText = await dispatchRes.text();
        dispatchError = `Dispatch failed (${dispatchRes.status}): ${errorText}`;
        console.error(`[Planning Poll] ${dispatchError}`);
      }
    } catch (err) {
      dispatchError = `Dispatch error: ${(err as Error).message}`;
      console.error(`[Planning Poll] ${dispatchError}`);
    }
  }

  // On dispatch failure: keep planning data intact, just record the error.
  // Task stays in 'assigned' so user can retry dispatch without re-planning.
  if (dispatchError) {
    run(
      `UPDATE tasks SET planning_dispatch_error = ?, status_reason = ?, updated_at = datetime('now') WHERE id = ?`,
      [dispatchError, 'Dispatch failed: ' + dispatchError, taskId]
    );
    console.log(`[Planning Poll] Dispatch failed for task ${taskId}, planning data preserved: ${dispatchError}`);
  } else if (!firstAgentId) {
    // No agent created — move to inbox for manual assignment
    run(
      `UPDATE tasks SET status = 'inbox', planning_dispatch_error = NULL, updated_at = datetime('now') WHERE id = ?`,
      [taskId]
    );
  }

  // Broadcast task update
  const updatedTask = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
  if (updatedTask) {
    broadcast({ type: 'task_updated', payload: updatedTask });
  }

  return { firstAgentId, firstDispatchableAgentId, parsed, dispatchError };
}

// GET /api/tasks/[id]/planning/poll - Check for new messages from OpenClaw
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: taskId } = await params;

  try {
    const task = queryOne<{
      id: string;
      planning_session_key?: string;
      planning_messages?: string;
      planning_complete?: number;
      planning_dispatch_error?: string;
    }>('SELECT * FROM tasks WHERE id = ?', [taskId]);

    if (!task || !task.planning_session_key) {
      return NextResponse.json({ error: 'Planning session not found' }, { status: 404 });
    }

    if (task.planning_complete) {
      return NextResponse.json({ hasUpdates: false, isComplete: true });
    }

    // Return dispatch error if present (allows user to see/ retry failed dispatch)
    if (task.planning_dispatch_error) {
      return NextResponse.json({
        hasUpdates: true,
        dispatchError: task.planning_dispatch_error,
      });
    }

    const messages = task.planning_messages ? JSON.parse(task.planning_messages) : [];
    // Count only assistant messages for comparison, since OpenClaw only returns assistant messages
    const initialAssistantCount = messages.filter((m: any) => m.role === 'assistant').length;

    console.log('[Planning Poll] Task', taskId, 'has', messages.length, 'total messages,', initialAssistantCount, 'assistant messages');

    // Check OpenClaw for new messages (lightweight check, not a loop)
    const openclawMessages = await getMessagesFromOpenClaw(task.planning_session_key);

    console.log('[Planning Poll] Comparison: stored_assistant=', initialAssistantCount, 'openclaw_assistant=', openclawMessages.length);

    if (openclawMessages.length > initialAssistantCount) {
      let currentQuestion = null;
      const newMessages = openclawMessages.slice(initialAssistantCount);
      console.log('[Planning Poll] Processing', newMessages.length, 'new messages');

      // Find new assistant messages
      for (const msg of newMessages) {
        console.log('[Planning Poll] Processing new message, role:', msg.role, 'content length:', msg.content?.length || 0);

        if (msg.role === 'assistant') {
          const lastMessage = { role: 'assistant', content: msg.content, timestamp: Date.now() };
          messages.push(lastMessage);

          // Check if this message contains completion status or a question
          const parsed = extractJSON(msg.content) as {
            status?: string;
            question?: string;
            options?: Array<{ id: string; label: string }>;
            spec?: object;
            agents?: Array<{
              name: string;
              role: string;
              avatar_emoji?: string;
              soul_md?: string;
              instructions?: string;
            }>;
            execution_plan?: object;
          } | null;

          console.log('[Planning Poll] Parsed message content:', {
            hasStatus: !!parsed?.status,
            hasQuestion: !!parsed?.question,
            hasOptions: !!parsed?.options,
            status: parsed?.status,
            question: parsed?.question?.substring(0, 50),
            rawPreview: msg.content?.substring(0, 200)
          });

          if (parsed && parsed.status === 'complete') {
            // Handle completion
            console.log('[Planning Poll] Planning complete, handling...');
            const { firstAgentId, firstDispatchableAgentId, parsed: fullParsed, dispatchError } = await handlePlanningCompletion(taskId, parsed, messages);

            return NextResponse.json({
              hasUpdates: true,
              complete: true,
              spec: fullParsed.spec,
              agents: fullParsed.agents,
              executionPlan: fullParsed.execution_plan,
              messages,
              autoDispatched: !!firstDispatchableAgentId,
              dispatchError,
            });
          }

          // Extract current question if present (be tolerant if options are missing)
          if (parsed && parsed.question) {
            const normalizedOptions = Array.isArray(parsed.options) && parsed.options.length > 0
              ? parsed.options
              : [
                  { id: 'continue', label: 'Continue' },
                  { id: 'other', label: 'Other' },
                ];
            console.log('[Planning Poll] Found question with', normalizedOptions.length, 'options');
            currentQuestion = {
              question: parsed.question,
              options: normalizedOptions,
            };
          }
        }
      }

      console.log('[Planning Poll] Returning updates: currentQuestion =', currentQuestion ? 'YES' : 'NO');

      // Update database
      run('UPDATE tasks SET planning_messages = ? WHERE id = ?', [JSON.stringify(messages), taskId]);

      return NextResponse.json({
        hasUpdates: true,
        complete: false,
        messages,
        currentQuestion,
      });
    }

    console.log('[Planning Poll] No new messages found');
    return NextResponse.json({ hasUpdates: false });
  } catch (error) {
    console.error('Failed to poll for updates:', error);
    return NextResponse.json({ error: 'Failed to poll for updates' }, { status: 500 });
  }
}
