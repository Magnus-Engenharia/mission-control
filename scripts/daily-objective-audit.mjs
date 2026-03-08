#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

const DB_PATH = '/Users/magnuseng/Projects/mission-control/mission-control.db';
const API_BASE = process.env.MISSION_CONTROL_API_BASE || 'http://127.0.0.1:4000';

const CONTRACT_HINTS = [
  'openapi.yaml',
  'openapi.yml',
  'swagger.yaml',
  'swagger.yml',
  'contracts',
  'api-contracts',
  'schema.graphql',
  'schema.rb',
  'PROJECT_CRITICALS.md',
  'PROJECT_FEATURES.md',
];

function existsAny(repoPath, names) {
  return names.some((name) => fs.existsSync(path.join(repoPath, name)));
}

function findIssues(repoPath) {
  const issues = [];

  if (!fs.existsSync(repoPath)) {
    issues.push('Project repository path does not exist.');
    return issues;
  }

  if (!existsAny(repoPath, ['PROJECT_CRITICALS.md'])) {
    issues.push('Missing PROJECT_CRITICALS.md with architecture and critical constraints.');
  }

  if (!existsAny(repoPath, ['openapi.yml', 'openapi.yaml', 'swagger.yml', 'swagger.yaml', 'contracts', 'api-contracts', 'schema.graphql', 'schema.rb'])) {
    issues.push('Missing explicit API/contract artifact (OpenAPI, contracts folder, GraphQL schema, or schema.rb).');
  }

  if (!existsAny(repoPath, ['PROJECT_FEATURES.md', 'FEATURES.md', 'features.md'])) {
    issues.push('Missing feature inventory document (PROJECT_FEATURES.md / FEATURES.md).');
  }

  return issues;
}

async function createObjective(projectId, title, description, phase = 'mvp', track = 'baseline') {
  const res = await fetch(`${API_BASE}/api/projects/${projectId}/objectives`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, description, phase, track }),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Objective create failed (${res.status}): ${txt}`);
  }

  return res.json();
}

async function main() {
  const db = new Database(DB_PATH, { readonly: true });

  const projects = db.prepare(
    `SELECT p.id, p.name, p.repo_path, p.workspace_id, w.default_phase
     FROM projects p
     JOIN workspaces w ON w.id = p.workspace_id
     WHERE p.is_active = 1`
  ).all();

  const existingObjectiveStmt = db.prepare(
    `SELECT id FROM objectives
     WHERE project_id = ?
       AND title = ?
       AND created_at >= datetime('now','-2 day')
     LIMIT 1`
  );

  let created = 0;
  const logs = [];

  for (const project of projects) {
    const issues = findIssues(project.repo_path || '');
    if (issues.length === 0) continue;

    const baselineTitle = `${project.name}: Baseline Contract & File Audit`;
    const baselineExists = existingObjectiveStmt.get(project.id, baselineTitle);

    const baselineDescription = [
      'Daily automated baseline audit detected gaps that can impact planning quality and delivery reliability.',
      '',
      'Detected baseline issues:',
      ...issues.map((i) => `- ${i}`),
      '',
      'Objective requirements:',
      '- Ensure baseline functionality docs are complete.',
      '- Propose tiny tasks only, with clear acceptance criteria.',
    ].join('\n');

    if (!baselineExists) {
      try {
        await createObjective(project.id, baselineTitle, baselineDescription, project.default_phase || 'mvp', 'baseline');
        created += 1;
        logs.push(`created baseline objective for ${project.name}`);
      } catch (err) {
        logs.push(`error baseline for ${project.name}: ${err.message}`);
      }
    }

    const differentialTitle = `${project.name}: Differential Advantage Audit`;
    const differentialExists = existingObjectiveStmt.get(project.id, differentialTitle);
    const hasAIMarkers = existsAny(project.repo_path || '', ['ai', 'ml', 'models', 'inference']);
    if (!hasAIMarkers && !differentialExists) {
      const differentialDescription = [
        'Daily competitive audit: project lacks explicit differential AI/product edge artifacts.',
        '',
        'Differential opportunity focus:',
        '- Define one measurable competitive advantage objective.',
        '- Avoid baseline parity tasks in this objective.',
        '- Keep tiny tasks and clear acceptance criteria.',
      ].join('\n');
      try {
        await createObjective(project.id, differentialTitle, differentialDescription, project.default_phase || 'mvp', 'differential');
        created += 1;
        logs.push(`created differential objective for ${project.name}`);
      } catch (err) {
        logs.push(`error differential for ${project.name}: ${err.message}`);
      }
    }
  }

  db.close();
  console.log(`[daily-objective-audit] created=${created}`);
  for (const line of logs) console.log(`[daily-objective-audit] ${line}`);
}

main().catch((err) => {
  console.error('[daily-objective-audit] fatal', err);
  process.exit(1);
});
