/**
 * Database Migrations System
 * 
 * Handles schema changes in a production-safe way:
 * 1. Tracks which migrations have been applied
 * 2. Runs new migrations automatically on startup
 * 3. Never runs the same migration twice
 */

import Database from 'better-sqlite3';
import { bootstrapCoreAgentsRaw } from '@/lib/bootstrap-agents';

interface Migration {
  id: string;
  name: string;
  up: (db: Database.Database) => void;
}

// All migrations in order - NEVER remove or reorder existing migrations
const migrations: Migration[] = [
  {
    id: '001',
    name: 'initial_schema',
    up: (db) => {
      // Core tables - these are created in schema.ts on fresh databases
      // This migration exists to mark the baseline for existing databases
      console.log('[Migration 001] Baseline schema marker');
    }
  },
  {
    id: '002',
    name: 'add_workspaces',
    up: (db) => {
      console.log('[Migration 002] Adding workspaces table and columns...');
      
      // Create workspaces table if not exists
      db.exec(`
        CREATE TABLE IF NOT EXISTS workspaces (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          slug TEXT NOT NULL UNIQUE,
          description TEXT,
          icon TEXT DEFAULT '📁',
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );
      `);
      
      // Insert default workspace if not exists
      db.exec(`
        INSERT OR IGNORE INTO workspaces (id, name, slug, description, icon) 
        VALUES ('default', 'Default Workspace', 'default', 'Default workspace', '🏠');
      `);
      
      // Add workspace_id to tasks if not exists
      const tasksInfo = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];
      if (!tasksInfo.some(col => col.name === 'workspace_id')) {
        db.exec(`ALTER TABLE tasks ADD COLUMN workspace_id TEXT DEFAULT 'default' REFERENCES workspaces(id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks(workspace_id)`);
        console.log('[Migration 002] Added workspace_id to tasks');
      }
      
      // Add workspace_id to agents if not exists
      const agentsInfo = db.prepare("PRAGMA table_info(agents)").all() as { name: string }[];
      if (!agentsInfo.some(col => col.name === 'workspace_id')) {
        db.exec(`ALTER TABLE agents ADD COLUMN workspace_id TEXT DEFAULT 'default' REFERENCES workspaces(id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_agents_workspace ON agents(workspace_id)`);
        console.log('[Migration 002] Added workspace_id to agents');
      }
    }
  },
  {
    id: '003',
    name: 'add_planning_tables',
    up: (db) => {
      console.log('[Migration 003] Adding planning tables...');
      
      // Create planning_questions table if not exists
      db.exec(`
        CREATE TABLE IF NOT EXISTS planning_questions (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          category TEXT NOT NULL,
          question TEXT NOT NULL,
          question_type TEXT DEFAULT 'multiple_choice' CHECK (question_type IN ('multiple_choice', 'text', 'yes_no')),
          options TEXT,
          answer TEXT,
          answered_at TEXT,
          sort_order INTEGER DEFAULT 0,
          created_at TEXT DEFAULT (datetime('now'))
        );
      `);
      
      // Create planning_specs table if not exists
      db.exec(`
        CREATE TABLE IF NOT EXISTS planning_specs (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
          spec_markdown TEXT NOT NULL,
          locked_at TEXT NOT NULL,
          locked_by TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        );
      `);
      
      // Create index
      db.exec(`CREATE INDEX IF NOT EXISTS idx_planning_questions_task ON planning_questions(task_id, sort_order)`);
      
      // Update tasks status check constraint to include 'planning'
      // SQLite doesn't support ALTER CONSTRAINT, so we check if it's needed
      const taskSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get() as { sql: string } | undefined;
      if (taskSchema && !taskSchema.sql.includes("'planning'")) {
        console.log('[Migration 003] Note: tasks table needs planning status - will be handled by schema recreation on fresh dbs');
      }
    }
  },
  {
    id: '004',
    name: 'add_planning_session_columns',
    up: (db) => {
      console.log('[Migration 004] Adding planning session columns to tasks...');

      const tasksInfo = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];

      // Add planning_session_key column
      if (!tasksInfo.some(col => col.name === 'planning_session_key')) {
        db.exec(`ALTER TABLE tasks ADD COLUMN planning_session_key TEXT`);
        console.log('[Migration 004] Added planning_session_key');
      }

      // Add planning_messages column (stores JSON array of messages)
      if (!tasksInfo.some(col => col.name === 'planning_messages')) {
        db.exec(`ALTER TABLE tasks ADD COLUMN planning_messages TEXT`);
        console.log('[Migration 004] Added planning_messages');
      }

      // Add planning_complete column
      if (!tasksInfo.some(col => col.name === 'planning_complete')) {
        db.exec(`ALTER TABLE tasks ADD COLUMN planning_complete INTEGER DEFAULT 0`);
        console.log('[Migration 004] Added planning_complete');
      }

      // Add planning_spec column (stores final spec JSON)
      if (!tasksInfo.some(col => col.name === 'planning_spec')) {
        db.exec(`ALTER TABLE tasks ADD COLUMN planning_spec TEXT`);
        console.log('[Migration 004] Added planning_spec');
      }

      // Add planning_agents column (stores generated agents JSON)
      if (!tasksInfo.some(col => col.name === 'planning_agents')) {
        db.exec(`ALTER TABLE tasks ADD COLUMN planning_agents TEXT`);
        console.log('[Migration 004] Added planning_agents');
      }
    }
  },
  {
    id: '005',
    name: 'add_agent_model_field',
    up: (db) => {
      console.log('[Migration 005] Adding model field to agents...');

      const agentsInfo = db.prepare("PRAGMA table_info(agents)").all() as { name: string }[];

      // Add model column
      if (!agentsInfo.some(col => col.name === 'model')) {
        db.exec(`ALTER TABLE agents ADD COLUMN model TEXT`);
        console.log('[Migration 005] Added model to agents');
      }
    }
  },
  {
    id: '006',
    name: 'add_planning_dispatch_error_column',
    up: (db) => {
      console.log('[Migration 006] Adding planning_dispatch_error column to tasks...');

      const tasksInfo = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];

      // Add planning_dispatch_error column
      if (!tasksInfo.some(col => col.name === 'planning_dispatch_error')) {
        db.exec(`ALTER TABLE tasks ADD COLUMN planning_dispatch_error TEXT`);
        console.log('[Migration 006] Added planning_dispatch_error to tasks');
      }
    }
  },
  {
    id: '007',
    name: 'add_agent_source_and_gateway_id',
    up: (db) => {
      console.log('[Migration 007] Adding source and gateway_agent_id to agents...');

      const agentsInfo = db.prepare("PRAGMA table_info(agents)").all() as { name: string }[];

      // Add source column: 'local' for MC-created, 'gateway' for imported from OpenClaw Gateway
      if (!agentsInfo.some(col => col.name === 'source')) {
        db.exec(`ALTER TABLE agents ADD COLUMN source TEXT DEFAULT 'local'`);
        console.log('[Migration 007] Added source to agents');
      }

      // Add gateway_agent_id column: stores the original agent ID/name from the Gateway
      if (!agentsInfo.some(col => col.name === 'gateway_agent_id')) {
        db.exec(`ALTER TABLE agents ADD COLUMN gateway_agent_id TEXT`);
        console.log('[Migration 007] Added gateway_agent_id to agents');
      }
    }
  },
  {
    id: '008',
    name: 'add_status_reason_column',
    up: (db) => {
      console.log('[Migration 008] Adding status_reason column to tasks...');

      const tasksInfo = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];

      if (!tasksInfo.some(col => col.name === 'status_reason')) {
        db.exec(`ALTER TABLE tasks ADD COLUMN status_reason TEXT`);
        console.log('[Migration 008] Added status_reason to tasks');
      }
    }
  },
  {
    id: '009',
    name: 'add_agent_session_key_prefix',
    up: (db) => {
      console.log('[Migration 009] Adding session_key_prefix to agents...');

      const agentsInfo = db.prepare("PRAGMA table_info(agents)").all() as { name: string }[];

      if (!agentsInfo.some(col => col.name === 'session_key_prefix')) {
        db.exec(`ALTER TABLE agents ADD COLUMN session_key_prefix TEXT`);
        console.log('[Migration 009] Added session_key_prefix to agents');
      }
    }
  },
  {
    id: '010',
    name: 'add_workflow_templates_roles_knowledge',
    up: (db) => {
      console.log('[Migration 010] Adding workflow templates, task roles, and knowledge tables...');

      // Create workflow_templates table
      db.exec(`
        CREATE TABLE IF NOT EXISTS workflow_templates (
          id TEXT PRIMARY KEY,
          workspace_id TEXT DEFAULT 'default' REFERENCES workspaces(id),
          name TEXT NOT NULL,
          description TEXT,
          stages TEXT NOT NULL,
          fail_targets TEXT,
          is_default INTEGER DEFAULT 0,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_workflow_templates_workspace ON workflow_templates(workspace_id)`);

      // Create task_roles table
      db.exec(`
        CREATE TABLE IF NOT EXISTS task_roles (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          role TEXT NOT NULL,
          agent_id TEXT NOT NULL REFERENCES agents(id),
          created_at TEXT DEFAULT (datetime('now')),
          UNIQUE(task_id, role)
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_task_roles_task ON task_roles(task_id)`);

      // Create knowledge_entries table
      db.exec(`
        CREATE TABLE IF NOT EXISTS knowledge_entries (
          id TEXT PRIMARY KEY,
          workspace_id TEXT DEFAULT 'default' REFERENCES workspaces(id),
          task_id TEXT REFERENCES tasks(id),
          category TEXT NOT NULL,
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          tags TEXT,
          confidence REAL DEFAULT 0.5,
          created_by_agent_id TEXT REFERENCES agents(id),
          created_at TEXT DEFAULT (datetime('now'))
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_knowledge_entries_workspace ON knowledge_entries(workspace_id, created_at DESC)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_knowledge_entries_task ON knowledge_entries(task_id)`);

      // Add workflow_template_id to tasks
      const tasksInfo = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];
      if (!tasksInfo.some(col => col.name === 'workflow_template_id')) {
        db.exec(`ALTER TABLE tasks ADD COLUMN workflow_template_id TEXT REFERENCES workflow_templates(id)`);
        console.log('[Migration 010] Added workflow_template_id to tasks');
      }

      // Recreate tasks table to add 'verification' + 'pending_dispatch' to status CHECK constraint
      // SQLite doesn't support ALTER CONSTRAINT, so we need table recreation
      const taskSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get() as { sql: string } | undefined;
      if (taskSchema && !taskSchema.sql.includes("'verification'")) {
        console.log('[Migration 010] Recreating tasks table to add verification status...');

        // Get current column names from the old table
        const oldCols = (db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map(c => c.name);
        const hasWorkflowCol = oldCols.includes('workflow_template_id');

        db.exec(`ALTER TABLE tasks RENAME TO _tasks_old_010`);
        db.exec(`
          CREATE TABLE tasks (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            description TEXT,
            status TEXT DEFAULT 'inbox' CHECK (status IN ('pending_dispatch', 'planning', 'inbox', 'assigned', 'in_progress', 'testing', 'review', 'verification', 'done')),
            priority TEXT DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
            assigned_agent_id TEXT REFERENCES agents(id),
            created_by_agent_id TEXT REFERENCES agents(id),
            workspace_id TEXT DEFAULT 'default' REFERENCES workspaces(id),
            business_id TEXT DEFAULT 'default',
            due_date TEXT,
            workflow_template_id TEXT REFERENCES workflow_templates(id),
            planning_session_key TEXT,
            planning_messages TEXT,
            planning_complete INTEGER DEFAULT 0,
            planning_spec TEXT,
            planning_agents TEXT,
            planning_dispatch_error TEXT,
            status_reason TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
          )
        `);

        // Copy data with explicit column mapping
        const sharedCols = 'id, title, description, status, priority, assigned_agent_id, created_by_agent_id, workspace_id, business_id, due_date, planning_session_key, planning_messages, planning_complete, planning_spec, planning_agents, planning_dispatch_error, status_reason, created_at, updated_at';

        if (hasWorkflowCol) {
          db.exec(`
            INSERT INTO tasks (${sharedCols}, workflow_template_id)
            SELECT ${sharedCols}, workflow_template_id FROM _tasks_old_010
          `);
        } else {
          db.exec(`
            INSERT INTO tasks (${sharedCols})
            SELECT ${sharedCols} FROM _tasks_old_010
          `);
        }

        db.exec(`DROP TABLE _tasks_old_010`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_agent_id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks(workspace_id)`);
        console.log('[Migration 010] Tasks table recreated with verification status');
      }

      // Seed default workflow templates for the 'default' workspace
      const existingTemplates = db.prepare('SELECT COUNT(*) as count FROM workflow_templates').get() as { count: number };
      if (existingTemplates.count === 0) {
        const now = new Date().toISOString();
        db.prepare(`
          INSERT INTO workflow_templates (id, workspace_id, name, description, stages, fail_targets, is_default, created_at, updated_at)
          VALUES (?, 'default', ?, ?, ?, ?, ?, ?, ?)
        `).run(
          'tpl-simple',
          'Simple',
          'Builder only — for quick, straightforward tasks',
          JSON.stringify([
            { id: 'build', label: 'Build', role: 'builder', status: 'in_progress' },
            { id: 'done', label: 'Done', role: null, status: 'done' }
          ]),
          JSON.stringify({}),
          0, now, now
        );

        db.prepare(`
          INSERT INTO workflow_templates (id, workspace_id, name, description, stages, fail_targets, is_default, created_at, updated_at)
          VALUES (?, 'default', ?, ?, ?, ?, ?, ?, ?)
        `).run(
          'tpl-standard',
          'Standard',
          'Builder → Tester → Reviewer — for most projects',
          JSON.stringify([
            { id: 'build', label: 'Build', role: 'builder', status: 'in_progress' },
            { id: 'test', label: 'Test', role: 'tester', status: 'testing' },
            { id: 'review', label: 'Review', role: 'reviewer', status: 'review' },
            { id: 'done', label: 'Done', role: null, status: 'done' }
          ]),
          JSON.stringify({ testing: 'in_progress', review: 'in_progress' }),
          1, now, now
        );

        db.prepare(`
          INSERT INTO workflow_templates (id, workspace_id, name, description, stages, fail_targets, is_default, created_at, updated_at)
          VALUES (?, 'default', ?, ?, ?, ?, ?, ?, ?)
        `).run(
          'tpl-strict',
          'Strict',
          'Builder → Tester → Reviewer + Learner — for critical projects',
          JSON.stringify([
            { id: 'build', label: 'Build', role: 'builder', status: 'in_progress' },
            { id: 'test', label: 'Test', role: 'tester', status: 'testing' },
            { id: 'review', label: 'Review', role: null, status: 'review' },
            { id: 'verify', label: 'Verify', role: 'verifier', status: 'verification' },
            { id: 'done', label: 'Done', role: null, status: 'done' }
          ]),
          JSON.stringify({ testing: 'in_progress', review: 'in_progress', verification: 'in_progress' }),
          0, now, now
        );

        console.log('[Migration 010] Seeded default workflow templates');
      }
    }
  },
  {
    id: '011',
    name: 'fix_broken_fk_references',
    up: (db) => {
      // Migration 010 renamed tasks → _tasks_old_010, which caused SQLite to
      // rewrite FK references in ALL child tables to point to "_tasks_old_010".
      // After dropping _tasks_old_010, those FK references became dangling.
      // Fix: recreate affected tables with correct FK references.
      console.log('[Migration 011] Fixing broken FK references from migration 010...');

      const broken = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE '%_tasks_old_010%'`
      ).all() as { name: string }[];

      if (broken.length === 0) {
        console.log('[Migration 011] No broken FK references found — skipping');
        return;
      }

      // Table definitions with correct FK references to tasks(id)
      const tableDefinitions: Record<string, string> = {
        planning_questions: `CREATE TABLE planning_questions (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          category TEXT NOT NULL,
          question TEXT NOT NULL,
          question_type TEXT DEFAULT 'multiple_choice' CHECK (question_type IN ('multiple_choice', 'text', 'yes_no')),
          options TEXT,
          answer TEXT,
          answered_at TEXT,
          sort_order INTEGER DEFAULT 0,
          created_at TEXT DEFAULT (datetime('now'))
        )`,
        planning_specs: `CREATE TABLE planning_specs (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
          spec_markdown TEXT NOT NULL,
          locked_at TEXT NOT NULL,
          locked_by TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        )`,
        conversations: `CREATE TABLE conversations (
          id TEXT PRIMARY KEY,
          title TEXT,
          type TEXT DEFAULT 'direct' CHECK (type IN ('direct', 'group', 'task')),
          task_id TEXT REFERENCES tasks(id),
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        )`,
        events: `CREATE TABLE events (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          agent_id TEXT REFERENCES agents(id),
          task_id TEXT REFERENCES tasks(id),
          message TEXT NOT NULL,
          metadata TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        )`,
        openclaw_sessions: `CREATE TABLE openclaw_sessions (
          id TEXT PRIMARY KEY,
          agent_id TEXT REFERENCES agents(id),
          openclaw_session_id TEXT NOT NULL,
          channel TEXT,
          status TEXT DEFAULT 'active',
          session_type TEXT DEFAULT 'persistent',
          task_id TEXT REFERENCES tasks(id),
          ended_at TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        )`,
        task_activities: `CREATE TABLE task_activities (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          agent_id TEXT REFERENCES agents(id),
          activity_type TEXT NOT NULL,
          message TEXT NOT NULL,
          metadata TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        )`,
        task_deliverables: `CREATE TABLE task_deliverables (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          deliverable_type TEXT NOT NULL,
          title TEXT NOT NULL,
          path TEXT,
          description TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        )`,
        task_roles: `CREATE TABLE task_roles (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          role TEXT NOT NULL,
          agent_id TEXT NOT NULL REFERENCES agents(id),
          created_at TEXT DEFAULT (datetime('now')),
          UNIQUE(task_id, role)
        )`,
      };

      for (const { name } of broken) {
        const newSql = tableDefinitions[name];
        if (!newSql) {
          console.warn(`[Migration 011] No definition for table ${name} — skipping`);
          continue;
        }

        // Get column names from old table
        const cols = (db.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[])
          .map(c => c.name).join(', ');

        const tmpName = `_${name}_fix_011`;
        db.exec(`ALTER TABLE ${name} RENAME TO ${tmpName}`);
        db.exec(newSql);
        db.exec(`INSERT INTO ${name} (${cols}) SELECT ${cols} FROM ${tmpName}`);
        db.exec(`DROP TABLE ${tmpName}`);
        console.log(`[Migration 011] Recreated table: ${name}`);
      }

      // Recreate indexes for affected tables
      db.exec(`CREATE INDEX IF NOT EXISTS idx_planning_questions_task ON planning_questions(task_id, sort_order)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_task_roles_task ON task_roles(task_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at DESC)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_activities_task ON task_activities(task_id, created_at DESC)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_deliverables_task ON task_deliverables(task_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_openclaw_sessions_task ON openclaw_sessions(task_id)`);

      console.log('[Migration 011] All broken FK references fixed');
    }
  },
  {
    id: '012',
    name: 'fix_strict_template_review_queue',
    up: (db) => {
      // Update Strict template: review is a queue (no role), verification is the active QC step.
      // Also fix the seed data in migration 010 for new databases.
      console.log('[Migration 012] Updating Strict workflow template...');

      const strictStages = JSON.stringify([
        { id: 'build', label: 'Build', role: 'builder', status: 'in_progress' },
        { id: 'test', label: 'Test', role: 'tester', status: 'testing' },
        { id: 'review', label: 'Review', role: null, status: 'review' },
        { id: 'verify', label: 'Verify', role: 'verifier', status: 'verification' },
        { id: 'done', label: 'Done', role: null, status: 'done' }
      ]);

      const updated = db.prepare(
        `UPDATE workflow_templates
         SET stages = ?, description = ?, updated_at = datetime('now')
         WHERE id = 'tpl-strict'`
      ).run(strictStages, 'Builder → Tester → Reviewer + Learner — for critical projects');

      if (updated.changes > 0) {
        console.log('[Migration 012] Strict template updated (review is now a queue)');
      } else {
        console.log('[Migration 012] No tpl-strict found — will be correct on fresh seed');
      }
    }
  },
  {
    id: '013',
    name: 'reset_fresh_start',
    up: (db) => {
      console.log('[Migration 013] Fresh start — wiping all data and bootstrapping...');

      // 1. Delete all row data (keep workspaces + workflow_templates infrastructure)
      const tablesToWipe = [
        'task_roles',
        'task_activities',
        'task_deliverables',
        'planning_questions',
        'planning_specs',
        'knowledge_entries',
        'messages',
        'conversation_participants',
        'conversations',
        'events',
        'openclaw_sessions',
        'agents',
        'tasks',
      ];
      for (const table of tablesToWipe) {
        try {
          db.exec(`DELETE FROM ${table}`);
          console.log(`[Migration 013] Wiped ${table}`);
        } catch (err) {
          // Table might not exist on fresh DBs — skip silently
          console.log(`[Migration 013] Table ${table} not found — skipping`);
        }
      }

      // 2. Make Strict the default template, Standard non-default
      db.exec(`UPDATE workflow_templates SET is_default = 0 WHERE id = 'tpl-standard'`);
      db.exec(`UPDATE workflow_templates SET is_default = 1 WHERE id = 'tpl-strict'`);

      // 3. Fix Strict template: verification role → 'reviewer' (was 'verifier')
      const fixedStages = JSON.stringify([
        { id: 'build',  label: 'Build',  role: 'builder',  status: 'in_progress' },
        { id: 'test',   label: 'Test',   role: 'tester',   status: 'testing' },
        { id: 'review', label: 'Review', role: null,        status: 'review' },
        { id: 'verify', label: 'Verify', role: 'reviewer',  status: 'verification' },
        { id: 'done',   label: 'Done',   role: null,        status: 'done' },
      ]);
      db.prepare(
        `UPDATE workflow_templates SET stages = ?, description = ?, updated_at = datetime('now') WHERE id = 'tpl-strict'`
      ).run(fixedStages, 'Builder → Tester → Reviewer + Learner — for critical projects');

      console.log('[Migration 013] Strict template is now default with reviewer role');

      // 4. Bootstrap 4 core agents for the default workspace
      const missionControlUrl = process.env.MISSION_CONTROL_URL || 'http://localhost:4000';
      bootstrapCoreAgentsRaw(db, 'default', missionControlUrl);

      console.log('[Migration 013] Fresh start complete');
    }
  },
  {
    id: '014',
    name: 'ensure_master_planner_agent',
    up: (db) => {
      console.log('[Migration 014] Ensuring each workspace has a master Planner Agent...');

      const workspaces = db.prepare('SELECT id FROM workspaces').all() as { id: string }[];
      const now = new Date().toISOString();
      const missionControlUrl = process.env.MISSION_CONTROL_URL || 'http://localhost:4000';

      const sharedUserMd = `# User Context\n\n## Operating Environment\n- Platform: Autensa multi-agent task orchestration\n- API Base: ${missionControlUrl}\n- Tasks are dispatched automatically by the workflow engine\n- Communication via OpenClaw Gateway\n\n## Communication Style\n- Be concise and action-oriented\n- Report results with evidence\n- Ask for clarification only when truly needed`;

      const plannerSoul = `# Planner Agent\n\nYou are the dedicated planning specialist.\n\n## Mission\nTurn ambiguous requests into clear, testable implementation plans.\n\n## Planning Protocol\n- Ask focused, high-leverage clarification questions\n- Capture constraints, scope boundaries, and non-goals\n- Produce concrete acceptance criteria\n- Define risks and edge cases early\n- Output implementation-ready structure for Builder/Tester/Reviewer\n\n## Quality Bar\nA plan is complete only when execution can start with minimal ambiguity.\nIf ambiguity remains, ask one more precise question instead of guessing.`;

      const insert = db.prepare(`
        INSERT INTO agents (
          id, name, role, description, avatar_emoji, status, is_master, workspace_id,
          soul_md, user_md, agents_md, source, gateway_agent_id, session_key_prefix, mapping_status, mapping_error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'standby', 1, ?, ?, ?, ?, 'gateway', ?, ?, 'mapped', NULL, ?, ?)
      `);

      for (const workspace of workspaces) {
        const existingMaster = db.prepare(
          `SELECT id, role FROM agents WHERE workspace_id = ? AND is_master = 1 ORDER BY CASE WHEN role = 'planner' THEN 0 ELSE 1 END, created_at ASC LIMIT 1`
        ).get(workspace.id) as { id: string; role?: string } | undefined;

        if (existingMaster?.role === 'planner') {
          continue;
        }

        const plannerExists = db.prepare(
          `SELECT id FROM agents WHERE workspace_id = ? AND role = 'planner' ORDER BY created_at ASC LIMIT 1`
        ).get(workspace.id) as { id: string } | undefined;

        if (plannerExists) {
          db.prepare(`UPDATE agents SET is_master = 1, source = COALESCE(source, 'gateway'), gateway_agent_id = COALESCE(gateway_agent_id, 'master-planner'), mapping_status = COALESCE(mapping_status, 'mapped'), session_key_prefix = COALESCE(session_key_prefix, 'agent:master-planner:'), updated_at = ? WHERE id = ?`)
            .run(now, plannerExists.id);
          console.log(`[Migration 014] Promoted existing planner to master for workspace ${workspace.id}`);
          continue;
        }

        const id = crypto.randomUUID();
        insert.run(
          id,
          'Master Planner',
          'planner',
          'Master Planner — dedicated planning specialist',
          '🧭',
          workspace.id,
          plannerSoul,
          sharedUserMd,
          'Master Planner is the default planning orchestrator for this workspace.',
          'master-planner',
          'agent:master-planner:',
          now,
          now,
        );
        console.log(`[Migration 014] Added Planner Agent to workspace ${workspace.id}`);
      }
    }
  },
  {
    id: '015',
    name: 'agent_mapping_states',
    up: (db) => {
      console.log('[Migration 015] Adding agent mapping state columns...');

      const agentsInfo = db.prepare('PRAGMA table_info(agents)').all() as { name: string }[];
      if (!agentsInfo.some(col => col.name === 'mapping_status')) {
        db.exec("ALTER TABLE agents ADD COLUMN mapping_status TEXT DEFAULT 'mapped' CHECK (mapping_status IN ('mapped', 'unmapped', 'failed'))");
      }
      if (!agentsInfo.some(col => col.name === 'mapping_error')) {
        db.exec('ALTER TABLE agents ADD COLUMN mapping_error TEXT');
      }
      if (!agentsInfo.some(col => col.name === 'provisional_from_task_id')) {
        db.exec('ALTER TABLE agents ADD COLUMN provisional_from_task_id TEXT REFERENCES tasks(id)');
      }

      db.exec("UPDATE agents SET mapping_status = COALESCE(mapping_status, 'mapped')");
      db.exec('CREATE INDEX IF NOT EXISTS idx_agents_mapping_status ON agents(mapping_status)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_agents_workspace_role ON agents(workspace_id, role)');
      console.log('[Migration 015] Agent mapping states ready');
    }
  },
  {
    id: '016',
    name: 'normalize_workspace_five_mapped_agents',
    up: (db) => {
      console.log('[Migration 016] Normalizing workspaces to core mapped OpenClaw agents...');

      const now = new Date().toISOString();
      const workspaces = db.prepare('SELECT id FROM workspaces').all() as { id: string }[];

      const targetAgents = [
        { name: 'Master Planner', role: 'planner', avatar: '🧭', gatewayAgentId: 'master-planner', sessionKeyPrefix: 'agent:master-planner:', isMaster: 1 },
        { name: 'Builder Engineer', role: 'builder', avatar: '🛠️', gatewayAgentId: 'cursor', sessionKeyPrefix: 'agent:cursor:', isMaster: 0 },
        { name: 'Tester', role: 'tester', avatar: '🧪', gatewayAgentId: 'tester', sessionKeyPrefix: 'agent:tester:', isMaster: 0 },
        { name: 'Reviewer', role: 'reviewer', avatar: '🔍', gatewayAgentId: 'reviewer', sessionKeyPrefix: 'agent:reviewer:', isMaster: 0 },
      ];

      const selectExisting = db.prepare(`
        SELECT id
        FROM agents
        WHERE workspace_id = ?
          AND (
            gateway_agent_id = ?
            OR lower(role) = lower(?)
            OR lower(name) = lower(?)
          )
        ORDER BY CASE WHEN gateway_agent_id = ? THEN 0 ELSE 1 END, created_at ASC
        LIMIT 1
      `);

      const updateAgent = db.prepare(`
        UPDATE agents
        SET name = ?,
            role = ?,
            avatar_emoji = ?,
            source = 'gateway',
            gateway_agent_id = ?,
            session_key_prefix = ?,
            mapping_status = 'mapped',
            mapping_error = NULL,
            is_master = ?,
            status = CASE WHEN status = 'offline' THEN 'standby' ELSE status END,
            updated_at = ?
        WHERE id = ?
      `);

      const insertAgent = db.prepare(`
        INSERT INTO agents (
          id, name, role, description, avatar_emoji, status, is_master, workspace_id,
          source, gateway_agent_id, session_key_prefix, mapping_status, mapping_error,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'standby', ?, ?, 'gateway', ?, ?, 'mapped', NULL, ?, ?)
      `);

      for (const workspace of workspaces) {
        for (const target of targetAgents) {
          const existing = selectExisting.get(
            workspace.id,
            target.gatewayAgentId,
            target.role,
            target.name,
            target.gatewayAgentId,
          ) as { id: string } | undefined;

          if (existing?.id) {
            updateAgent.run(
              target.name,
              target.role,
              target.avatar,
              target.gatewayAgentId,
              target.sessionKeyPrefix,
              target.isMaster,
              now,
              existing.id,
            );
          } else {
            insertAgent.run(
              crypto.randomUUID(),
              target.name,
              target.role,
              `${target.name} — auto-mapped OpenClaw agent`,
              target.avatar,
              target.isMaster,
              workspace.id,
              target.gatewayAgentId,
              target.sessionKeyPrefix,
              now,
              now,
            );
          }
        }
      }

      // Keep planner as the canonical master in each workspace
      db.exec(`
        UPDATE agents
        SET is_master = CASE WHEN role = 'planner' THEN 1 ELSE 0 END,
            updated_at = datetime('now')
        WHERE workspace_id IN (SELECT id FROM workspaces)
          AND role IN ('planner', 'builder', 'tester', 'reviewer')
      `);

      console.log('[Migration 016] Core mapped agents ensured for all workspaces');
    }
  },
  {
    id: '017',
    name: 'projects_registry_and_task_linkage',
    up: (db) => {
      console.log('[Migration 017] Creating projects registry and task linkage...');

      db.exec(`
        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id),
          name TEXT NOT NULL,
          slug TEXT NOT NULL,
          repo_path TEXT NOT NULL,
          platform TEXT,
          template TEXT,
          is_active INTEGER DEFAULT 1,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now')),
          UNIQUE(workspace_id, slug)
        )
      `);

      const tasksInfo = db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[];
      if (!tasksInfo.some(col => col.name === 'project_id')) {
        db.exec('ALTER TABLE tasks ADD COLUMN project_id TEXT REFERENCES projects(id)');
      }

      db.exec('CREATE INDEX IF NOT EXISTS idx_projects_workspace ON projects(workspace_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id)');

      console.log('[Migration 017] Projects registry ready');
    }
  },
  {
    id: '018',
    name: 'project_template_repo_fields',
    up: (db) => {
      console.log('[Migration 018] Adding project template repo fields...');
      const info = db.prepare('PRAGMA table_info(projects)').all() as { name: string }[];

      if (!info.some((c) => c.name === 'template_frontend_repo')) {
        db.exec('ALTER TABLE projects ADD COLUMN template_frontend_repo TEXT');
      }
      if (!info.some((c) => c.name === 'template_backend_repo')) {
        db.exec('ALTER TABLE projects ADD COLUMN template_backend_repo TEXT');
      }
      if (!info.some((c) => c.name === 'template_app_repo')) {
        db.exec('ALTER TABLE projects ADD COLUMN template_app_repo TEXT');
      }
      if (!info.some((c) => c.name === 'template_extra_repo')) {
        db.exec('ALTER TABLE projects ADD COLUMN template_extra_repo TEXT');
      }

      console.log('[Migration 018] Project template repo fields ready');
    }
  },
  {
    id: '019',
    name: 'ideas_and_comments',
    up: (db) => {
      console.log('[Migration 019] Creating ideas tables...');
      db.exec(`
        CREATE TABLE IF NOT EXISTS ideas (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id),
          title TEXT NOT NULL,
          summary TEXT,
          source TEXT,
          tags_json TEXT,
          status TEXT DEFAULT 'new' CHECK (status IN ('new','reviewing','accepted','rejected')),
          score REAL,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        )
      `);

      db.exec(`
        CREATE TABLE IF NOT EXISTS idea_comments (
          id TEXT PRIMARY KEY,
          idea_id TEXT NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
          author TEXT,
          content TEXT NOT NULL,
          created_at TEXT DEFAULT (datetime('now'))
        )
      `);

      db.exec('CREATE INDEX IF NOT EXISTS idx_ideas_workspace ON ideas(workspace_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_idea_comments_idea ON idea_comments(idea_id)');
      console.log('[Migration 019] Ideas tables ready');
    }
  },


  {
    id: '022',
    name: 'ideas_project_scope',
    up: (db) => {
      console.log('[Migration 022] Extending ideas with project scope columns');
      const info = db.prepare("PRAGMA table_info(ideas)").all() as { name: string }[];
      if (!info.some((c) => c.name === 'project_id')) {
        db.exec('ALTER TABLE ideas ADD COLUMN project_id TEXT REFERENCES projects(id)');
      }
      if (!info.some((c) => c.name === 'is_new_project')) {
        db.exec('ALTER TABLE ideas ADD COLUMN is_new_project INTEGER DEFAULT 0');
      }
      console.log('[Migration 022] ideas_project_scope ready');
    }
  },
  {
    id: '021',
    name: 'task_target_and_project_critical_docs',
    up: (db) => {
      console.log('[Migration 021] Adding tasks.target...');
      const info = db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[];
      if (!info.some((c) => c.name === 'target')) {
        db.exec("ALTER TABLE tasks ADD COLUMN target TEXT DEFAULT 'fullstack' CHECK (target IN ('fullstack', 'web', 'api', 'mobile'))");
      }
      db.exec("UPDATE tasks SET target = COALESCE(target, 'fullstack')");
      console.log('[Migration 021] tasks.target ready');
    }
  },
  {
    id: '027',
    name: 'learner_dispatch_to_codex',
    up: (db) => {
      console.log('[Migration 027] Routing learner agents to codex...');
      db.exec(`
        UPDATE agents
        SET gateway_agent_id = 'cursor',
            session_key_prefix = 'agent:cursor:',
            updated_at = datetime('now')
        WHERE role = 'learner';
      `);
      console.log('[Migration 027] learner agents now route to cursor');
    }
  },
  {
    id: '026',
    name: 'objectives_track',
    up: (db) => {
      console.log('[Migration 026] Adding objectives.track...');
      const info = db.prepare('PRAGMA table_info(objectives)').all() as { name: string }[];
      if (!info.some((c) => c.name === 'track')) {
        db.exec("ALTER TABLE objectives ADD COLUMN track TEXT DEFAULT 'baseline' CHECK (track IN ('baseline','differential'))");
      }
      db.exec("UPDATE objectives SET track = COALESCE(track, 'baseline')");
      console.log('[Migration 026] objectives.track ready');
    }
  },
  {
    id: '025',
    name: 'workspace_bypass_tester',
    up: (db) => {
      console.log('[Migration 025] Adding workspaces.bypass_tester...');
      const info = db.prepare('PRAGMA table_info(workspaces)').all() as { name: string }[];
      if (!info.some((c) => c.name === 'bypass_tester')) {
        db.exec("ALTER TABLE workspaces ADD COLUMN bypass_tester INTEGER DEFAULT 0");
      }
      db.exec("UPDATE workspaces SET bypass_tester = COALESCE(bypass_tester, 0)");
      console.log('[Migration 025] workspaces.bypass_tester ready');
    }
  },
  {
    id: '024',
    name: 'objectives_table',
    up: (db) => {
      console.log('[Migration 024] Creating objectives table...');
      db.exec(`
        CREATE TABLE IF NOT EXISTS objectives (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id),
          project_id TEXT NOT NULL REFERENCES projects(id),
          title TEXT NOT NULL,
          description TEXT,
          phase TEXT DEFAULT 'mvp' CHECK (phase IN ('mvp','growth','stabilizing')),
          status TEXT DEFAULT 'draft' CHECK (status IN ('draft','planning','ready','approved','cancelled')),
          planner_session_key TEXT,
          planner_messages TEXT,
          planner_opinion TEXT,
          viability_score INTEGER,
          draft_tasks_json TEXT,
          approved_at TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );
      `);
      console.log('[Migration 024] objectives table ready');
    }
  },
  {
    id: '023',
    name: 'workspace_default_phase',
    up: (db) => {
      console.log('[Migration 023] Adding workspaces.default_phase...');
      const info = db.prepare('PRAGMA table_info(workspaces)').all() as { name: string }[];
      if (!info.some((c) => c.name === 'default_phase')) {
        db.exec("ALTER TABLE workspaces ADD COLUMN default_phase TEXT DEFAULT 'mvp' CHECK (default_phase IN ('mvp','growth','stabilizing'))");
      }
      db.exec("UPDATE workspaces SET default_phase = COALESCE(default_phase, 'mvp')");
      console.log('[Migration 023] workspaces.default_phase ready');
    }
  },
  {
    id: '020',
    name: 'normalize_default_workflow_templates',
    up: (db) => {
      console.log('[Migration 020] Normalizing default workflow templates...');

      const now = new Date().toISOString();
      const updateTemplate = db.prepare(`
        UPDATE workflow_templates
        SET name = ?, description = ?, stages = ?, fail_targets = ?, is_default = ?, updated_at = ?
        WHERE id = ?
      `);

      updateTemplate.run(
        'Simple',
        'Builder only — for quick, straightforward tasks',
        JSON.stringify([
          { id: 'build', label: 'Build', role: 'builder', status: 'in_progress' },
          { id: 'done', label: 'Done', role: null, status: 'done' },
        ]),
        JSON.stringify({}),
        0,
        now,
        'tpl-simple'
      );

      updateTemplate.run(
        'Standard',
        'Builder → Tester → Reviewer — for most projects',
        JSON.stringify([
          { id: 'build', label: 'Build', role: 'builder', status: 'in_progress' },
          { id: 'test', label: 'Test', role: 'tester', status: 'testing' },
          { id: 'review', label: 'Review', role: 'reviewer', status: 'review' },
          { id: 'done', label: 'Done', role: null, status: 'done' },
        ]),
        JSON.stringify({ testing: 'in_progress', review: 'in_progress' }),
        0,
        now,
        'tpl-standard'
      );

      updateTemplate.run(
        'Strict',
        'Builder → Tester → Reviewer → Learner — end-to-end with documentation',
        JSON.stringify([
          { id: 'build', label: 'Build', role: 'builder', status: 'in_progress' },
          { id: 'test', label: 'Test', role: 'tester', status: 'testing' },
          { id: 'review', label: 'Review', role: 'reviewer', status: 'review' },
          { id: 'learn', label: 'Learn', role: 'learner', status: 'verification' },
          { id: 'done', label: 'Done', role: null, status: 'done' },
        ]),
        JSON.stringify({ testing: 'in_progress', review: 'in_progress', verification: 'in_progress' }),
        1,
        now,
        'tpl-strict'
      );

      console.log('[Migration 020] Default templates normalized');
    }
  }
];

/**
 * Run all pending migrations
 */
export function runMigrations(db: Database.Database): void {
  // Create migrations tracking table
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Get already applied migrations
  const applied = new Set(
    (db.prepare('SELECT id FROM _migrations').all() as { id: string }[]).map(m => m.id)
  );

  // Run pending migrations in order
  for (const migration of migrations) {
    if (applied.has(migration.id)) {
      continue;
    }

    console.log(`[DB] Running migration ${migration.id}: ${migration.name}`);

    try {
      // Disable FK checks during migrations (required for table recreation).
      // PRAGMA foreign_keys must be set outside a transaction in SQLite.
      db.pragma('foreign_keys = OFF');
      // Prevent ALTER TABLE RENAME from rewriting FK references in other tables.
      db.pragma('legacy_alter_table = ON');

      db.transaction(() => {
        migration.up(db);
        db.prepare('INSERT INTO _migrations (id, name) VALUES (?, ?)').run(migration.id, migration.name);
      })();

      // Re-enable FK checks and legacy alter table
      db.pragma('legacy_alter_table = OFF');
      db.pragma('foreign_keys = ON');

      console.log(`[DB] Migration ${migration.id} completed`);
    } catch (error) {
      // Re-enable FK checks even on failure
      db.pragma('foreign_keys = ON');
      console.error(`[DB] Migration ${migration.id} failed:`, error);
      throw error;
    }
  }
}

/**
 * Get migration status
 */
export function getMigrationStatus(db: Database.Database): { applied: string[]; pending: string[] } {
  const applied = (db.prepare('SELECT id FROM _migrations ORDER BY id').all() as { id: string }[]).map(m => m.id);
  const pending = migrations.filter(m => !applied.includes(m.id)).map(m => m.id);
  return { applied, pending };
}
