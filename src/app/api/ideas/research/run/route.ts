import { NextRequest, NextResponse } from 'next/server';
import { run } from '@/lib/db';

export const dynamic = 'force-dynamic';

// Manual trigger endpoint for weekly research ingestion.
// Cron suggestion (America/Sao_Paulo): Saturdays at 08:00.
// Example OpenClaw cron can POST here with generated ideas payload.
export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as {
      workspace_id?: string;
      source?: string;
      ideas?: Array<{ title: string; summary?: string; tags?: string[]; score?: number }>;
    };

    const workspaceId = body.workspace_id || 'default';
    const source = body.source || 'weekly-research';
    const ideas = body.ideas || [];

    if (!ideas.length) {
      return NextResponse.json({ inserted: 0, message: 'No ideas provided' });
    }

    const now = new Date().toISOString();
    let inserted = 0;

    for (const idea of ideas) {
      if (!idea.title?.trim()) continue;
      run(
        `INSERT INTO ideas (id, workspace_id, title, summary, source, tags_json, status, score, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'new', ?, ?, ?)`,
        [
          crypto.randomUUID(),
          workspaceId,
          idea.title.trim(),
          idea.summary || null,
          source,
          JSON.stringify(idea.tags || []),
          idea.score ?? null,
          now,
          now,
        ]
      );
      inserted += 1;
    }

    return NextResponse.json({ inserted, source, workspace_id: workspaceId });
  } catch (error) {
    console.error('Failed to run ideas research import:', error);
    return NextResponse.json({ error: 'Failed to run ideas research import' }, { status: 500 });
  }
}
