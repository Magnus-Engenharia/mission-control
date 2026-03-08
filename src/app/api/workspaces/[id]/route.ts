import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';
// GET /api/workspaces/[id] - Get a single workspace
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  
  try {
    const db = getDb();
    
    // Try to find by ID or slug
    const workspace = db.prepare(
      'SELECT * FROM workspaces WHERE id = ? OR slug = ?'
    ).get(id, id);
    
    if (!workspace) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }
    
    return NextResponse.json(workspace);
  } catch (error) {
    console.error('Failed to fetch workspace:', error);
    return NextResponse.json({ error: 'Failed to fetch workspace' }, { status: 500 });
  }
}

// PATCH /api/workspaces/[id] - Update a workspace
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  
  try {
    const body = await request.json();
    const { name, description, icon, default_phase, bypass_tester } = body;
    
    const db = getDb();
    
    // Check workspace exists
    const existing = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id);
    if (!existing) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }
    
    // Build update query dynamically
    const updates: string[] = [];
    const values: unknown[] = [];
    
    if (name !== undefined) {
      updates.push('name = ?');
      values.push(name);
    }
    if (description !== undefined) {
      updates.push('description = ?');
      values.push(description);
    }
    if (icon !== undefined) {
      updates.push('icon = ?');
      values.push(icon);
    }
    if (default_phase !== undefined) {
      const allowed = new Set(['mvp', 'growth', 'stabilizing']);
      if (!allowed.has(default_phase)) {
        return NextResponse.json({ error: 'Invalid default_phase' }, { status: 400 });
      }
      updates.push('default_phase = ?');
      values.push(default_phase);
    }
    if (bypass_tester !== undefined) {
      updates.push('bypass_tester = ?');
      values.push(bypass_tester ? 1 : 0);
    }
    
    if (updates.length === 0) {
      return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
    }
    
    updates.push("updated_at = datetime('now')");
    values.push(id);
    
    db.prepare(`
      UPDATE workspaces SET ${updates.join(', ')} WHERE id = ?
    `).run(...values);
    
    const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id);
    return NextResponse.json(workspace);
  } catch (error) {
    console.error('Failed to update workspace:', error);
    return NextResponse.json({ error: 'Failed to update workspace' }, { status: 500 });
  }
}

// DELETE /api/workspaces/[id] - Delete a workspace
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  
  try {
    const db = getDb();
    
    // Don't allow deleting the default workspace
    if (id === 'default') {
      return NextResponse.json({ error: 'Cannot delete the default workspace' }, { status: 400 });
    }
    
    // Check workspace exists
    const existing = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id);
    if (!existing) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }
    
    const deleteWorkspaceTx = db.transaction((workspaceId: string) => {
      const taskIds = db
        .prepare('SELECT id FROM tasks WHERE workspace_id = ?')
        .all(workspaceId) as { id: string }[];
      const agentIds = db
        .prepare('SELECT id FROM agents WHERE workspace_id = ?')
        .all(workspaceId) as { id: string }[];

      const taskIdList = taskIds.map((t) => t.id);
      const agentIdList = agentIds.map((a) => a.id);

      const deleteByIds = (sqlPrefix: string, ids: string[]) => {
        if (ids.length === 0) return;
        const placeholders = ids.map(() => '?').join(', ');
        db.prepare(`${sqlPrefix} (${placeholders})`).run(...ids);
      };

      // Remove references to workspace-scoped tasks/agents first
      deleteByIds('DELETE FROM openclaw_sessions WHERE task_id IN', taskIdList);
      deleteByIds('DELETE FROM openclaw_sessions WHERE agent_id IN', agentIdList);
      deleteByIds('DELETE FROM events WHERE task_id IN', taskIdList);
      deleteByIds('DELETE FROM events WHERE agent_id IN', agentIdList);
      deleteByIds('DELETE FROM messages WHERE sender_agent_id IN', agentIdList);

      // Conversation rows linked to workspace tasks
      deleteByIds('DELETE FROM conversations WHERE task_id IN', taskIdList);

      // Workspace-scoped rows
      db.prepare('DELETE FROM knowledge_entries WHERE workspace_id = ?').run(workspaceId);

      // Core entities (task child tables cascade via FK)
      db.prepare('DELETE FROM tasks WHERE workspace_id = ?').run(workspaceId);
      db.prepare('DELETE FROM agents WHERE workspace_id = ?').run(workspaceId);

      // Project/idea graph
      db.prepare('DELETE FROM idea_comments WHERE idea_id IN (SELECT id FROM ideas WHERE workspace_id = ?)').run(workspaceId);
      db.prepare('DELETE FROM ideas WHERE workspace_id = ?').run(workspaceId);
      db.prepare('DELETE FROM objectives WHERE workspace_id = ?').run(workspaceId);
      db.prepare('DELETE FROM projects WHERE workspace_id = ?').run(workspaceId);

      // Templates must be removed after tasks (tasks may reference workflow_template_id)
      db.prepare('DELETE FROM workflow_templates WHERE workspace_id = ?').run(workspaceId);

      // Finally remove workspace
      db.prepare('DELETE FROM workspaces WHERE id = ?').run(workspaceId);
    });

    deleteWorkspaceTx(id);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to delete workspace:', error);
    return NextResponse.json({ error: 'Failed to delete workspace' }, { status: 500 });
  }
}
