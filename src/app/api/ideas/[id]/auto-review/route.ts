import { NextRequest, NextResponse } from 'next/server';
import { queryAll, queryOne, run } from '@/lib/db';
import type { Idea, IdeaComment } from '@/lib/types';

export const dynamic = 'force-dynamic';
interface RouteParams { params: Promise<{ id: string }> }

function buildSophieEvaluation(idea: Idea, latestUserComment: string) {
  const text = `${idea.title} ${idea.summary || ''} ${latestUserComment}`.toLowerCase();

  const points: string[] = [];
  let score = idea.score ?? 7.5;

  if (/ia|intelig/.test(text)) {
    points.push('IA pode aumentar percepção de valor, desde que entre de forma incremental no MVP.');
    score += 0.4;
  }
  if (/supabase|firebase|backend leve|sem backend/.test(text)) {
    points.push('Backend leve (Supabase/Firebase) é adequado para reduzir manutenção inicial.');
    score += 0.3;
  }
  if (/prefer|dieta|restri/.test(text)) {
    points.push('Personalização por preferências/restrições é diferencial importante para retenção.');
    score += 0.4;
  }

  if (points.length === 0) {
    points.push('Sugiro manter a ideia e refinar escopo com hipótese + métrica de validação para o MVP.');
  }

  const finalScore = Math.max(0, Math.min(10, Number(score.toFixed(1))));
  const comment = `Avaliação da Sophie: ${points.join(' ')} Recomendo ${finalScore >= 7.5 ? 'manter e avançar para task de MVP' : 'ajustar o escopo antes de executar'}.`;

  const tags = (() => {
    try {
      const parsed = JSON.parse(idea.tags_json || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  })();

  const mergedTags = Array.from(new Set([...tags, 'avaliado-sophie']));

  return {
    comment,
    score: finalScore,
    status: finalScore >= 7.5 ? ('accepted' as const) : ('new' as const),
    tags: mergedTags,
  };
}

// POST /api/ideas/[id]/auto-review
// Async worker endpoint: evaluates latest comment + idea, posts Sophie response, clears reviewing.
export async function POST(_request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const idea = queryOne<Idea>('SELECT * FROM ideas WHERE id = ?', [id]);
    if (!idea) return NextResponse.json({ error: 'Idea not found' }, { status: 404 });

    if (idea.status !== 'reviewing') {
      return NextResponse.json({ ok: true, skipped: true, reason: 'idea not in reviewing status' });
    }

    const comments = queryAll<IdeaComment>(
      "SELECT * FROM idea_comments WHERE idea_id = ? ORDER BY created_at DESC",
      [id]
    );

    const latestUserComment = comments.find((c) => (c.author || '').toLowerCase() !== 'sophie')?.content || '';
    const evalResult = buildSophieEvaluation(idea, latestUserComment);
    const now = new Date().toISOString();

    run(
      'INSERT INTO idea_comments (id, idea_id, author, content, created_at) VALUES (?, ?, ?, ?, ?)',
      [crypto.randomUUID(), id, 'Sophie', evalResult.comment, now]
    );

    run(
      `UPDATE ideas
       SET status = ?,
           score = ?,
           tags_json = ?,
           updated_at = ?
       WHERE id = ?`,
      [evalResult.status, evalResult.score, JSON.stringify(evalResult.tags), now, id]
    );

    run(
      `INSERT INTO events (id, type, task_id, message, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        'idea_review_completed',
        null,
        `Sophie concluiu revisão da ideia: ${idea.title}`,
        JSON.stringify({ idea_id: id, final_status: evalResult.status, score: evalResult.score }),
        now,
      ]
    );

    return NextResponse.json({ ok: true, idea_id: id, ...evalResult });
  } catch (error) {
    console.error('Failed to auto-review idea:', error);
    return NextResponse.json({ error: 'Failed to auto-review idea' }, { status: 500 });
  }
}
