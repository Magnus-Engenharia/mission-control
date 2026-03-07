import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { queryAll, queryOne, run } from '@/lib/db';
import type { Idea, IdeaComment } from '@/lib/types';

export const dynamic = 'force-dynamic';
interface RouteParams { params: Promise<{ id: string }> }

export async function GET(_request: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const comments = queryAll<IdeaComment>('SELECT * FROM idea_comments WHERE idea_id = ? ORDER BY created_at ASC', [id]);
  return NextResponse.json(comments);
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const body = await request.json() as { author?: string; content?: string };
    const content = (body.content || '').trim();
    if (!content) return NextResponse.json({ error: 'content is required' }, { status: 400 });

    const idea = queryOne<Idea>('SELECT * FROM ideas WHERE id = ?', [id]);
    if (!idea) {
      return NextResponse.json({ error: 'Idea not found' }, { status: 404 });
    }

    const commentId = crypto.randomUUID();
    const now = new Date().toISOString();
    const author = body.author || 'you';

    run(
      'INSERT INTO idea_comments (id, idea_id, author, content, created_at) VALUES (?, ?, ?, ?, ?)',
      [commentId, id, author, content, now]
    );

    // Mark idea as being reviewed by Sophie
    run("UPDATE ideas SET status = 'reviewing', updated_at = ? WHERE id = ?", [now, id]);

    // Add to live events feed
    run(
      `INSERT INTO events (id, type, task_id, message, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        'idea_comment_added',
        null,
        `Novo comentário na ideia: ${idea.title}`,
        JSON.stringify({ idea_id: id, workspace_id: idea.workspace_id, author, content }),
        now,
      ]
    );

    // Wake assistant (best effort) so it can review/respond about the idea changes.
    const text = `Mission Control: novo comentário na ideia "${idea.title}" (id: ${id}) por ${author}. Comentário: ${content}. Contexto da ideia: ${idea.summary || 'sem resumo'}. Faça avaliação cruzando comentário + ideia e responda ao Magnus com recomendação (ajustar ou manter).`;
    const openclawBin = process.env.OPENCLAW_BIN || '/opt/homebrew/bin/openclaw';
    execFile(openclawBin, ['system', 'event', '--text', text, '--mode', 'now'], (err) => {
      if (err) {
        console.warn('[ideas] failed to emit system event:', err.message);
        try {
          run(
            `INSERT INTO events (id, type, task_id, message, metadata, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
              crypto.randomUUID(),
              'idea_review_wake_failed',
              null,
              `Falha ao acordar assistente para ideia: ${idea.title}`,
              JSON.stringify({ idea_id: id, error: err.message }),
              new Date().toISOString(),
            ]
          );
        } catch {}
      }
    });

    // Temporary in-app Sophie evaluation so the card doesn't stay stuck in "reviewing".
    // (Can be replaced later by async agent pipeline calling /sophie-response.)
    const lower = content.toLowerCase();
    const suggestions: string[] = [];

    if (lower.includes('supabase') || lower.includes('firebase') || lower.includes('backend')) {
      suggestions.push('Faz sentido começar com backend leve (Supabase/Firebase) para reduzir custo e manutenção no MVP.');
    }
    if (lower.includes('ia') || lower.includes('intelig')) {
      suggestions.push('IA agrega valor de marketing; sugiro limitar ao recurso com maior impacto inicial (ex.: recomendações de refeições).');
    }
    if (lower.includes('prefer') || lower.includes('dieta')) {
      suggestions.push('Personalização por preferências/restrições é um ótimo diferencial e deve entrar no escopo do MVP.');
    }
    if (suggestions.length === 0) {
      suggestions.push('Comentário recebido e considerado. Minha recomendação: manter a ideia e refinar escopo/hipóteses de validação.');
    }

    const sophieComment = `Avaliação da Sophie: ${suggestions.join(' ')}`;
    run(
      'INSERT INTO idea_comments (id, idea_id, author, content, created_at) VALUES (?, ?, ?, ?, ?)',
      [crypto.randomUUID(), id, 'Sophie', sophieComment, new Date().toISOString()]
    );

    run("UPDATE ideas SET status = 'new', updated_at = ? WHERE id = ?", [new Date().toISOString(), id]);

    const comments = queryAll<IdeaComment>('SELECT * FROM idea_comments WHERE idea_id = ? ORDER BY created_at ASC', [id]);
    return NextResponse.json(comments, { status: 201 });
  } catch (error) {
    console.error('Failed to create comment:', error);
    return NextResponse.json({ error: 'Failed to create comment' }, { status: 500 });
  }
}
