'use client';

import { useEffect, useMemo, useState } from 'react';
import type { Idea, IdeaComment, Project } from '@/lib/types';

export function IdeasPanel({ workspaceId = 'default', scope = 'dashboard', fullHeight = false }: { workspaceId?: string; scope?: 'dashboard' | 'global'; fullHeight?: boolean }) {
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [selected, setSelected] = useState<Idea | null>(null);
  const [comments, setComments] = useState<IdeaComment[]>([]);
  const [commentText, setCommentText] = useState('');
  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newIdea, setNewIdea] = useState({ title: '', summary: '', tags: '', score: '', isNewDashboard: false, project_id: '', phase: 'mvp' as 'mvp' | 'growth' | 'stabilizing' });
  const [projects, setProjects] = useState<Project[]>([]);
  const [phaseFilter, setPhaseFilter] = useState<'all' | 'mvp' | 'growth' | 'stabilizing'>('all');
  const [workspaceDefaultPhase, setWorkspaceDefaultPhase] = useState<'mvp' | 'growth' | 'stabilizing'>('mvp');
  const [activeSection, setActiveSection] = useState<'ideas' | 'objectives'>('ideas');
  const [showObjectiveCreate, setShowObjectiveCreate] = useState(false);
  const [objectiveLoading, setObjectiveLoading] = useState(false);
  const [objectivePreview, setObjectivePreview] = useState<any | null>(null);
  const [currentObjectiveId, setCurrentObjectiveId] = useState<string>('');
  const [objectives, setObjectives] = useState<any[]>([]);
  const [objectiveMessage, setObjectiveMessage] = useState('');
  const [objectiveRunning, setObjectiveRunning] = useState(false);
  const [newObjective, setNewObjective] = useState({ title: '', description: '', phase: 'mvp' as 'mvp' | 'growth' | 'stabilizing', track: 'baseline' as 'baseline' | 'differential', project_id: '' });

  const loadIdeas = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/ideas?workspace_id=${workspaceId}&scope=${scope}`);
      if (res.ok) {
        const data = await res.json();
        setIdeas(Array.isArray(data) ? data : []);
      }
    } finally {
      setLoading(false);
    }
  };

  const loadComments = async (ideaId: string) => {
    const res = await fetch(`/api/ideas/${ideaId}/comments`);
    if (res.ok) {
      const data = await res.json();
      setComments(Array.isArray(data) ? data : []);
    }
  };

  const hydrateObjectivePreview = (obj: any) => {
    if (!obj) return;
    let drafts: any[] = [];
    try { drafts = JSON.parse(obj.draft_tasks_json || '[]'); } catch { drafts = []; }
    if ((obj.planner_opinion || obj.viability_score !== null || drafts.length > 0) && obj.status !== 'planning') {
      setObjectivePreview({
        hasUpdates: true,
        status: obj.status,
        viability_opinion: obj.planner_opinion || null,
        viability_score: obj.viability_score ?? null,
        task_drafts: drafts,
      });
    }
  };

  const loadProjects = async () => {
    const res = await fetch(`/api/projects?workspace_id=${workspaceId}`);
    if (res.ok) {
      const data = await res.json();
      setProjects(Array.isArray(data) ? data : []);
      if (Array.isArray(data) && data.length > 0 && !newObjective.project_id) {
        setNewObjective((prev) => ({ ...prev, project_id: data[0].id }));
      }
    } else {
      setProjects([]);
    }
  };

  const loadObjectives = async (projectId?: string) => {
    const pid = projectId || newObjective.project_id;
    if (!pid) return;
    const res = await fetch(`/api/projects/${pid}/objectives`);
    if (res.ok) {
      const data = await res.json();
      const list = Array.isArray(data) ? data : [];
      setObjectives(list);
      if (currentObjectiveId) {
        const selectedObj = list.find((o: any) => o.id === currentObjectiveId);
        if (selectedObj) hydrateObjectivePreview(selectedObj);
      }
    }
  };

  const createObjective = async () => {
    if (!newObjective.project_id || !newObjective.title.trim()) return;
    setObjectiveLoading(true);
    try {
      const res = await fetch(`/api/projects/${newObjective.project_id}/objectives`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: newObjective.title.trim(),
          description: newObjective.description.trim(),
          phase: newObjective.phase,
          track: newObjective.track,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(err?.error || 'Failed to create objective');
        return;
      }
      const data = await res.json();
      setCurrentObjectiveId(data.id);
      setObjectivePreview(null);
      setShowObjectiveCreate(false);
      await loadObjectives(newObjective.project_id);
    } finally {
      setObjectiveLoading(false);
    }
  };

  const pollObjective = async () => {
    if (!currentObjectiveId) return;
    setObjectiveLoading(true);
    try {
      const res = await fetch(`/api/objectives/${currentObjectiveId}/poll`);
      if (!res.ok) return;
      const data = await res.json();
      if (data?.hasUpdates) {
        setObjectivePreview(data);
        if (data?.status === 'ready') setObjectiveRunning(false);
      }
    } finally {
      setObjectiveLoading(false);
    }
  };

  const requestObjectivePlannerRun = async () => {
    if (!currentObjectiveId) return;
    setObjectiveRunning(true);
    setObjectiveLoading(true);
    try {
      // Ask planner to execute immediately for this objective preview
      await fetch(`/api/objectives/${currentObjectiveId}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'Run objective viability analysis now and return tiny task draft preview immediately.',
        }),
      });

      // Short active polling window to surface result quickly in UI
      for (let i = 0; i < 12; i++) {
        const res = await fetch(`/api/objectives/${currentObjectiveId}/poll`);
        if (res.ok) {
          const data = await res.json();
          if (data?.hasUpdates) setObjectivePreview(data);
          if (data?.status === 'ready' || Array.isArray(data?.task_drafts)) {
            setObjectiveRunning(false);
            return;
          }
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
    } finally {
      setObjectiveLoading(false);
    }
  };

  const sendObjectiveMessage = async () => {
    if (!currentObjectiveId || !objectiveMessage.trim()) return;
    setObjectiveLoading(true);
    try {
      const res = await fetch(`/api/objectives/${currentObjectiveId}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: objectiveMessage.trim() }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(err?.error || 'Failed to send message');
        return;
      }
      setObjectiveMessage('');
      await pollObjective();
    } finally {
      setObjectiveLoading(false);
    }
  };

  const deleteObjective = async (objectiveId: string) => {
    if (!confirm('Delete this objective?')) return;
    setObjectiveLoading(true);
    try {
      const res = await fetch(`/api/objectives/${objectiveId}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(data?.error || 'Failed to delete objective');
        return;
      }
      if (currentObjectiveId === objectiveId) {
        setCurrentObjectiveId('');
        setObjectivePreview(null);
      }
      await loadObjectives();
    } finally {
      setObjectiveLoading(false);
    }
  };

  const approveObjective = async () => {
    if (!currentObjectiveId) return;
    setObjectiveLoading(true);
    try {
      const res = await fetch(`/api/objectives/${currentObjectiveId}/approve`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(data?.error || 'Failed to approve objective');
        return;
      }
      alert(`Created ${data?.created_count || 0} tasks from objective`);
      await loadIdeas();
      await loadObjectives();
      setCurrentObjectiveId('');
      setObjectivePreview(null);
    } finally {
      setObjectiveLoading(false);
    }
  };

  useEffect(() => {
    loadIdeas();
    loadProjects();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  useEffect(() => {
    if (scope !== 'dashboard') return;
    if (!newObjective.project_id) return;
    loadObjectives(newObjective.project_id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newObjective.project_id, scope]);

  useEffect(() => {
    if (!currentObjectiveId) return;
    const local = objectives.find((o: any) => o.id === currentObjectiveId);
    if (local) hydrateObjectivePreview(local);
  }, [currentObjectiveId, objectives]);

  useEffect(() => {
    const loadWorkspaceMeta = async () => {
      try {
        const res = await fetch(`/api/workspaces/${workspaceId}`);
        if (!res.ok) return;
        const ws = await res.json();
        const phase = ws?.default_phase;
        if (phase === 'mvp' || phase === 'growth' || phase === 'stabilizing') {
          setWorkspaceDefaultPhase(phase);
          setNewIdea((prev) => ({ ...prev, phase }));
        }
      } catch {
        // ignore
      }
    };
    loadWorkspaceMeta();
  }, [workspaceId]);

  useEffect(() => {
    if (!selected) return;
    loadComments(selected.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  useEffect(() => {
    if (scope === 'global') {
      if (newIdea.project_id) setNewIdea((prev) => ({ ...prev, project_id: '' }));
      return;
    }
    if (newIdea.project_id && !projects.some((p) => p.id === newIdea.project_id)) {
      setNewIdea((prev) => ({ ...prev, project_id: '' }));
    }
  }, [projects, newIdea.project_id]);

  const selectedTags = useMemo(() => {
    if (!selected?.tags_json) return [] as string[];
    try { return JSON.parse(selected.tags_json); } catch { return []; }
  }, [selected?.tags_json]);

  const filteredIdeas = useMemo(() => {
    if (phaseFilter === 'all') return ideas;
    return ideas.filter((idea) => {
      try {
        const tags: string[] = JSON.parse(idea.tags_json || '[]');
        return tags.includes(`phase:${phaseFilter}`);
      } catch {
        return false;
      }
    });
  }, [ideas, phaseFilter]);

  const createTask = async (ideaId: string) => {
    const res = await fetch(`/api/ideas/${ideaId}/create-task`, { method: 'POST' });
    if (res.ok) {
      await loadIdeas();
      alert('Task criada a partir da ideia ✅');
    }
  };

  const requestReview = async (ideaId: string) => {
    const res = await fetch(`/api/ideas/${ideaId}/review-request`, { method: 'POST' });
    if (res.ok) {
      alert('Revisão da Sophie solicitada ✅');
    }
  };

  const discardIdea = async (ideaId: string) => {
    const ok = window.confirm('Tem certeza que deseja descartar esta ideia? Esta ação pode ser revertida mudando o status depois.');
    if (!ok) return;

    const res = await fetch(`/api/ideas/${ideaId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'rejected' }),
    });

    if (res.ok) {
      if (selected?.id === ideaId) {
        const updated = await res.json();
        setSelected(updated);
      }
      await loadIdeas();
      alert('Ideia descartada.');
    }
  };

  const addComment = async () => {
    if (!selected || !commentText.trim()) return;
    const res = await fetch(`/api/ideas/${selected.id}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author: 'Magnus', content: commentText.trim() }),
    });
    if (res.ok) {
      const data = await res.json();
      setComments(Array.isArray(data) ? data : []);
      setCommentText('');
      await loadIdeas();
    }
  };

  const createIdea = async () => {
    if (!newIdea.title.trim()) return;
    const tags = newIdea.tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    if (!tags.some((t) => t.startsWith('phase:'))) {
      tags.push(`phase:${newIdea.phase}`);
    }

    const res = await fetch('/api/ideas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspace_id: workspaceId,
        title: newIdea.title.trim(),
        summary: newIdea.summary.trim() || null,
        tags,
        score: newIdea.score ? Number(newIdea.score) : null,
        source: 'manual-dashboard',
        project_id: newIdea.project_id || null,
        is_new_project: scope === 'global' ? true : newIdea.isNewDashboard,
      }),
    });

    if (res.ok) {
      setShowCreate(false);
      setNewIdea({ title: '', summary: '', tags: '', score: '', isNewDashboard: false, project_id: '', phase: 'mvp' });
      await loadIdeas();
    }
  };

  return (
    <div className={`h-${fullHeight ? 'full' : 'full'} min-h-0 flex min-w-0${fullHeight ? '' : ''}`}>
      <div className="w-[42%] min-w-[300px] min-h-0 border-r border-mc-border p-3 overflow-y-auto">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-1">
            <button
              onClick={() => setActiveSection('ideas')}
              className={`min-h-8 px-2 text-xs rounded border ${activeSection === 'ideas' ? 'bg-mc-accent/20 border-mc-accent text-mc-accent' : 'bg-mc-bg border-mc-border text-mc-text-secondary'}`}
            >
              Ideias
            </button>
            {scope === 'dashboard' && (
              <button
                onClick={() => setActiveSection('objectives')}
                className={`min-h-8 px-2 text-xs rounded border ${activeSection === 'objectives' ? 'bg-mc-accent/20 border-mc-accent text-mc-accent' : 'bg-mc-bg border-mc-border text-mc-text-secondary'}`}
              >
                Objetivos
              </button>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            {activeSection === 'objectives' && scope === 'dashboard' ? (
              <button
                onClick={() => setShowObjectiveCreate((v) => !v)}
                className="min-h-9 px-2.5 text-xs bg-mc-accent text-mc-bg rounded hover:bg-mc-accent/90"
              >
                + Novo Objetivo
              </button>
            ) : (
              <button
                onClick={() => setShowCreate((v) => !v)}
                className="min-h-9 px-2.5 text-xs bg-mc-accent-pink text-mc-bg rounded hover:bg-mc-accent-pink/90"
              >
                + Nova Ideia
              </button>
            )}
          </div>
        </div>

        {activeSection === 'objectives' && scope === 'dashboard' && showObjectiveCreate && (
          <div className="mb-3 p-2.5 border border-mc-border rounded bg-mc-bg-secondary space-y-2">
            <input
              value={newObjective.title}
              onChange={(e) => setNewObjective((p) => ({ ...p, title: e.target.value }))}
              placeholder="Objective title"
              className="w-full min-h-10 bg-mc-bg border border-mc-border rounded px-2 text-sm"
            />
            <textarea
              value={newObjective.description}
              onChange={(e) => setNewObjective((p) => ({ ...p, description: e.target.value }))}
              placeholder="Objective details"
              className="w-full min-h-16 bg-mc-bg border border-mc-border rounded px-2 py-1.5 text-sm"
            />
            <div className="grid grid-cols-3 gap-2">
              <select
                value={newObjective.project_id}
                onChange={(e) => setNewObjective((p) => ({ ...p, project_id: e.target.value }))}
                className="w-full min-h-10 bg-mc-bg border border-mc-border rounded px-2 text-sm"
              >
                <option value="">Select project</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>{project.name}</option>
                ))}
              </select>
              <select
                value={newObjective.phase}
                onChange={(e) => setNewObjective((p) => ({ ...p, phase: e.target.value as 'mvp' | 'growth' | 'stabilizing' }))}
                className="w-full min-h-10 bg-mc-bg border border-mc-border rounded px-2 text-sm"
              >
                <option value="mvp">MVP</option>
                <option value="growth">Growth</option>
                <option value="stabilizing">Stabilizing</option>
              </select>
              <select
                value={newObjective.track}
                onChange={(e) => setNewObjective((p) => ({ ...p, track: e.target.value as 'baseline' | 'differential' }))}
                className="w-full min-h-10 bg-mc-bg border border-mc-border rounded px-2 text-sm"
              >
                <option value="baseline">Track: Baseline</option>
                <option value="differential">Track: Differential</option>
              </select>
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowObjectiveCreate(false)} className="min-h-10 px-3 text-xs border border-mc-border rounded">Cancel</button>
              <button onClick={createObjective} disabled={objectiveLoading} className="min-h-10 px-3 text-xs bg-mc-accent text-mc-bg rounded">Start Objective</button>
            </div>
          </div>
        )}

        {activeSection === 'objectives' && scope === 'dashboard' && currentObjectiveId && (
          <div className="mb-3 p-2.5 border border-mc-border rounded bg-mc-bg-secondary space-y-2">
            <div className="text-xs text-mc-text-secondary">Objective session: {currentObjectiveId.slice(0, 8)}...</div>
            <div className="flex gap-2 items-center flex-wrap">
              <button onClick={requestObjectivePlannerRun} disabled={objectiveLoading || objectiveRunning} className="min-h-9 px-2 text-xs border border-mc-border rounded">
                {objectiveRunning ? 'Master Planner running…' : 'Solicitar ação do Master Planner'}
              </button>
              <button onClick={pollObjective} disabled={objectiveLoading} className="min-h-9 px-2 text-xs border border-mc-border rounded">Atualizar Preview</button>
              <button onClick={approveObjective} disabled={objectiveLoading || !objectivePreview?.task_drafts?.length} className="min-h-9 px-2 text-xs bg-mc-accent text-mc-bg rounded">Approve & Create Tasks</button>
              {objectiveRunning && <span className="text-[11px] text-amber-300 animate-pulse">Analisando objetivo agora…</span>}
            </div>
            {objectivePreview && (
              <div className="text-xs space-y-1 text-mc-text-secondary">
                <div><b>Viability:</b> {objectivePreview.viability_score ?? 'N/A'} — {objectivePreview.viability_opinion || '-'}</div>
                <div><b>Draft tasks:</b> {Array.isArray(objectivePreview.task_drafts) ? objectivePreview.task_drafts.length : 0}</div>
              </div>
            )}
            <div className="flex gap-2">
              <input
                value={objectiveMessage}
                onChange={(e) => setObjectiveMessage(e.target.value)}
                placeholder="Discuss with Master Planner (e.g. split task 3 smaller)"
                className="flex-1 min-h-10 bg-mc-bg border border-mc-border rounded px-2 text-sm"
              />
              <button onClick={sendObjectiveMessage} disabled={objectiveLoading || !objectiveMessage.trim()} className="min-h-10 px-3 text-xs bg-mc-accent-pink text-mc-bg rounded">Send</button>
            </div>
          </div>
        )}

        {activeSection === 'objectives' && scope === 'dashboard' && (
          <div className="mb-3 space-y-1.5">
            {objectives.length === 0 ? (
              <div className="text-xs text-mc-text-secondary">Nenhum objetivo ainda.</div>
            ) : (
              objectives.slice(0, 8).map((obj) => (
                <div
                  key={obj.id}
                  className={`w-full p-2 rounded border ${currentObjectiveId === obj.id ? 'border-mc-accent bg-mc-accent/10' : 'border-mc-border bg-mc-bg-secondary'} hover:border-mc-accent/60`}
                >
                  <button
                    onClick={() => { setCurrentObjectiveId(obj.id); }}
                    className="w-full text-left"
                  >
                    <div className="text-sm text-mc-text">{obj.title}</div>
                    <div className="text-xs text-mc-text-secondary">{(obj.phase || 'mvp').toUpperCase()} · {(obj.track || 'baseline').toUpperCase()} · {obj.status || 'draft'}</div>
                  </button>
                  <div className="mt-1 flex justify-end">
                    <button
                      onClick={() => deleteObjective(obj.id)}
                      className="text-[10px] px-1.5 py-0.5 rounded border border-mc-border hover:border-red-500/50 text-mc-text-secondary hover:text-red-300"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {activeSection === 'ideas' && (
        <>
        <div className="mb-3 flex flex-wrap gap-1.5">
          {(['all', 'mvp', 'growth', 'stabilizing'] as const).map((phase) => (
            <button
              key={phase}
              onClick={() => setPhaseFilter(phase)}
              className={`px-2 py-1 rounded text-xs border ${phaseFilter === phase ? 'bg-mc-accent/20 border-mc-accent text-mc-accent' : 'bg-mc-bg border-mc-border text-mc-text-secondary'}`}
            >
              {phase === 'all' ? 'All' : phase.toUpperCase()}
            </button>
          ))}
        </div>

        {showCreate && (
          <div className="mb-3 p-2.5 border border-mc-border rounded bg-mc-bg-secondary space-y-2">
            <input
              value={newIdea.title}
              onChange={(e) => setNewIdea((p) => ({ ...p, title: e.target.value }))}
              placeholder="Título da ideia"
              className="w-full min-h-10 bg-mc-bg border border-mc-border rounded px-2 text-sm"
            />
            <textarea
              value={newIdea.summary}
              onChange={(e) => setNewIdea((p) => ({ ...p, summary: e.target.value }))}
              placeholder="Resumo (opcional)"
              className="w-full min-h-16 bg-mc-bg border border-mc-border rounded px-2 py-1.5 text-sm"
            />
            {scope === 'dashboard' ? (
              <div className="flex items-center gap-2">
                <input
                  id="idea-new-dashboard"
                  type="checkbox"
                  checked={newIdea.isNewDashboard}
                  onChange={(e) => setNewIdea((prev) => ({ ...prev, isNewDashboard: e.target.checked, project_id: e.target.checked ? '' : prev.project_id }))}
                />
                <label htmlFor="idea-new-dashboard" className="text-sm">Ideia para novo dashboard</label>
              </div>
            ) : null}

            {scope === 'dashboard' && !newIdea.isNewDashboard && (
              <div className="space-y-1">
                <label className="text-xs text-mc-text-secondary">Vincular a qual projeto desse dashboard?</label>
                <select
                  value={newIdea.project_id}
                  onChange={(e) => setNewIdea((p) => ({ ...p, project_id: e.target.value }))}
                  className="w-full min-h-10 bg-mc-bg border border-mc-border rounded px-2 text-sm"
                >
                  <option value="">Projetos do dashboard selecionado (opcional)</option>
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="grid grid-cols-3 gap-2">
              <input
                value={newIdea.tags}
                onChange={(e) => setNewIdea((p) => ({ ...p, tags: e.target.value }))}
                placeholder="tags separadas por vírgula"
                className="w-full min-h-10 bg-mc-bg border border-mc-border rounded px-2 text-sm"
              />
              <select
                value={newIdea.phase}
                onChange={(e) => setNewIdea((p) => ({ ...p, phase: e.target.value as 'mvp' | 'growth' | 'stabilizing' }))}
                className="w-full min-h-10 bg-mc-bg border border-mc-border rounded px-2 text-sm"
              >
                <option value="mvp">Phase: MVP{workspaceDefaultPhase === 'mvp' ? ' (default)' : ''}</option>
                <option value="growth">Phase: Growth</option>
                <option value="stabilizing">Phase: Stabilizing</option>
              </select>
              <input
                value={newIdea.score}
                onChange={(e) => setNewIdea((p) => ({ ...p, score: e.target.value }))}
                placeholder="score (0-10)"
                className="w-full min-h-10 bg-mc-bg border border-mc-border rounded px-2 text-sm"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowCreate(false)} className="min-h-10 px-3 text-xs border border-mc-border rounded">
                Cancelar
              </button>
              <button onClick={createIdea} className="min-h-10 px-3 text-xs bg-mc-accent text-mc-bg rounded">
                Salvar Ideia
              </button>
            </div>
          </div>
        )}
        {loading && <div className="text-sm text-mc-text-secondary">Carregando...</div>}
        {!loading && filteredIdeas.length === 0 && (
          <div className="text-sm text-mc-text-secondary">Nenhuma ideia para este filtro.</div>
        )}
        <div className="space-y-2">
          {filteredIdeas.map((idea) => {
            const tags: string[] = (() => { try { return JSON.parse(idea.tags_json || '[]'); } catch { return []; } })();
            return (
              <button
                key={idea.id}
                onClick={() => setSelected(idea)}
                className={`w-full text-left border rounded-lg p-3 ${selected?.id === idea.id ? 'border-mc-accent bg-mc-bg-secondary' : 'border-mc-border bg-mc-bg'}`}
              >
                <div className="font-medium text-sm line-clamp-2">{idea.title}</div>
                {idea.summary && <div className="text-xs text-mc-text-secondary mt-1 line-clamp-3">{idea.summary}</div>}
                <div className="mt-2 flex items-center gap-2 text-[11px] text-mc-text-secondary">
                  <span>Status: {idea.status}</span>
                  {idea.status === 'reviewing' && (
                    <span className="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">
                      Sophie pensando…
                    </span>
                  )}
                  {typeof idea.score === 'number' && <span>Score: {idea.score}</span>}
                </div>
                {tags.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {tags.slice(0, 4).map((t) => (
                      <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-mc-bg-tertiary border border-mc-border">#{t}</span>
                    ))}
                  </div>
                )}
              </button>
            );
          })}
        </div>
        </>
        )}
      </div>

      <div className="flex-1 min-h-0 p-4 overflow-y-auto pb-24">
        {activeSection === 'objectives' ? (
          <div className="space-y-3">
            <h3 className="text-lg font-semibold">Objetivos do Projeto</h3>
            {!currentObjectiveId ? (
              <div className="text-sm text-mc-text-secondary">Selecione ou crie um objetivo para ver o preview do Master Planner.</div>
            ) : !objectivePreview ? (
              <div className="text-sm text-mc-text-secondary">Ainda sem preview. Clique em &quot;Refresh Preview&quot; para buscar resposta do planner.</div>
            ) : (
              <div className="space-y-2">
                <div className="text-sm"><span className="text-mc-text-secondary">Viability:</span> {objectivePreview.viability_score ?? 'N/A'}</div>
                <div className="text-sm text-mc-text-secondary">{objectivePreview.viability_opinion || 'No opinion yet.'}</div>
                <div className="text-xs text-mc-text-secondary">Tasks propostas: {Array.isArray(objectivePreview.task_drafts) ? objectivePreview.task_drafts.length : 0}</div>
                <div className="space-y-1">
                  {(objectivePreview.task_drafts || []).slice(0, 20).map((t: any, idx: number) => (
                    <div key={idx} className="p-2 border border-mc-border rounded bg-mc-bg-secondary">
                      <div className="text-sm font-medium">{t.title}</div>
                      <div className="text-xs text-mc-text-secondary">{t.summary || 'No summary'}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : !selected ? (
          <div className="text-sm text-mc-text-secondary">Selecione uma ideia para ver detalhes.</div>
        ) : (
          <div className="space-y-4">
            <div>
              <h3 className="text-lg font-semibold">{selected.title}</h3>
              <p className="text-sm text-mc-text-secondary mt-1">{selected.summary || 'Sem resumo'}</p>
              <div className="mt-2 text-xs text-mc-text-secondary">Fonte: {selected.source || 'manual'}</div>
              {selected.status === 'reviewing' && (
                <div className="mt-2 inline-flex items-center px-2 py-1 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 text-xs">
                  Sophie recebeu e está pensando…
                </div>
              )}
              {selectedTags.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {selectedTags.map((t: string) => <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-mc-bg-tertiary border border-mc-border">#{t}</span>)}
                </div>
              )}
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={() => createTask(selected.id)}
                className="min-h-11 px-4 bg-mc-accent-pink text-mc-bg rounded text-sm font-medium hover:bg-mc-accent-pink/90"
              >
                Criar Task
              </button>
              <button
                onClick={() => requestReview(selected.id)}
                className="min-h-11 px-4 bg-mc-accent text-mc-bg rounded text-sm font-medium hover:bg-mc-accent/90"
              >
                Pedir revisão da Sophie
              </button>
              <button
                onClick={() => discardIdea(selected.id)}
                className="min-h-11 px-4 bg-red-500/15 border border-red-500/30 text-red-300 rounded text-sm font-medium hover:bg-red-500/25"
              >
                Descartar ideia
              </button>
              <button
                onClick={loadIdeas}
                className="min-h-11 px-3 bg-mc-bg border border-mc-border rounded text-sm"
              >
                Atualizar
              </button>
            </div>

            <div className="border-t border-mc-border pt-3">
              <h4 className="text-sm font-medium mb-2">Comentários</h4>
              <div className="space-y-2 mb-3">
                {comments.map((c) => (
                  <div key={c.id} className="bg-mc-bg-secondary border border-mc-border rounded p-2">
                    <div className="text-xs text-mc-text-secondary">{c.author || 'anônimo'}</div>
                    <div className="text-sm">{c.content}</div>
                  </div>
                ))}
                {comments.length === 0 && <div className="text-sm text-mc-text-secondary">Sem comentários ainda.</div>}
              </div>
              <div className="flex gap-2">
                <input
                  value={commentText}
                  onChange={(e) => setCommentText(e.target.value)}
                  placeholder="Adicionar comentário..."
                  className="flex-1 min-h-11 bg-mc-bg border border-mc-border rounded px-3 text-sm"
                />
                <button onClick={addComment} className="min-h-11 px-3 bg-mc-accent text-mc-bg rounded text-sm">Comentar</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
