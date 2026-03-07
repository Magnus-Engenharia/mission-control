'use client';

import { useState } from 'react';
import { X, FolderPlus } from 'lucide-react';

interface ProjectModalProps {
  workspaceId?: string;
  onClose: () => void;
}

type RepoPick = 'none' | 'default' | 'custom';

const TEMPLATE_DEFAULTS = {
  frontend: 'https://github.com/Magnus-Engenharia/VueTemplate',
  backend: 'https://github.com/Magnus-Engenharia/RailsTemplate',
  ios: 'https://github.com/Magnus-Engenharia/AppTemplate',
};

function RepoSelector({
  label,
  pick,
  customValue,
  defaultUrl,
  onPick,
  onCustomChange,
}: {
  label: string;
  pick: RepoPick;
  customValue: string;
  defaultUrl?: string;
  onPick: (pick: RepoPick) => void;
  onCustomChange: (value: string) => void;
}) {
  return (
    <div>
      <label className="block text-sm font-medium mb-1">{label}</label>
      <select
        value={pick}
        onChange={(e) => onPick(e.target.value as RepoPick)}
        className="w-full min-h-11 bg-mc-bg border border-mc-border rounded px-3 py-2 text-sm focus:outline-none focus:border-mc-accent"
      >
        <option value="none">None (skip)</option>
        {defaultUrl && <option value="default">Use org template</option>}
        <option value="custom">Custom GitHub repo URL</option>
      </select>

      {pick === 'default' && defaultUrl && (
        <p className="text-xs text-mc-text-secondary mt-1 break-all">{defaultUrl}</p>
      )}

      {pick === 'custom' && (
        <input
          value={customValue}
          onChange={(e) => onCustomChange(e.target.value)}
          placeholder="https://github.com/your-org/your-template"
          className="mt-2 w-full min-h-11 bg-mc-bg border border-mc-border rounded px-3 py-2 text-sm focus:outline-none focus:border-mc-accent"
        />
      )}
    </div>
  );
}

export function ProjectModal({ workspaceId, onClose }: ProjectModalProps) {
  const [form, setForm] = useState({
    name: '',
    platform: '',
    template: '',
  });

  const [repoMode, setRepoMode] = useState({
    frontend: 'default' as RepoPick,
    backend: 'default' as RepoPick,
    ios: 'default' as RepoPick,
    android: 'none' as RepoPick,
  });

  const [customRepo, setCustomRepo] = useState({
    frontend: '',
    backend: '',
    ios: '',
    android: '',
  });

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resolveRepo = (kind: 'frontend' | 'backend' | 'ios' | 'android') => {
    const mode = repoMode[kind];
    if (mode === 'none') return null;
    if (mode === 'custom') return customRepo[kind].trim() || null;
    if (mode === 'default') {
      if (kind === 'android') return null;
      return TEMPLATE_DEFAULTS[kind].trim() || null;
    }
    return null;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!form.name.trim()) {
      setError('Project name is required.');
      return;
    }

    const projectSlug = form.name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    const autoRepoPath = `/Users/magnuseng/Projects/${projectSlug || form.name.trim()}`;

    if (
      (repoMode.frontend === 'custom' && !customRepo.frontend.trim()) ||
      (repoMode.backend === 'custom' && !customRepo.backend.trim()) ||
      (repoMode.ios === 'custom' && !customRepo.ios.trim()) ||
      (repoMode.android === 'custom' && !customRepo.android.trim())
    ) {
      setError('Please provide custom URL for every template set to Custom.');
      return;
    }

    setSaving(true);
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspace_id: workspaceId || 'default',
          name: form.name.trim(),
          repo_path: autoRepoPath,
          platform: form.platform.trim() || null,
          template: form.template.trim() || null,
          template_frontend_repo: resolveRepo('frontend'),
          template_backend_repo: resolveRepo('backend'),
          template_ios_repo: resolveRepo('ios'),
          template_android_repo: resolveRepo('android'),
          bootstrap_from_templates: true,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Failed to create project');
        return;
      }

      onClose();
    } catch (err) {
      console.error('Failed to create project:', err);
      setError('Failed to create project');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
      <div className="w-full max-w-2xl bg-mc-bg-secondary border border-mc-border rounded-lg shadow-2xl">
        <div className="p-4 border-b border-mc-border flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FolderPlus className="w-5 h-5 text-mc-accent" />
            <h2 className="text-lg font-semibold">Create Project</h2>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-mc-bg rounded">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          {error && (
            <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded px-3 py-2">
              {error}
            </div>
          )}

          <div>
            <label className="block text-sm font-medium mb-1">Project name</label>
            <input
              value={form.name}
              onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
              placeholder="Mission Control"
              className="w-full min-h-11 bg-mc-bg border border-mc-border rounded px-3 py-2 text-sm focus:outline-none focus:border-mc-accent"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Repository path (automático)</label>
            <div className="w-full min-h-11 bg-mc-bg border border-mc-border rounded px-3 py-2 text-sm text-mc-text-secondary flex items-center">
              /Users/magnuseng/Projects/
              {form.name
                .trim()
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-|-$/g, '') || '<nome-do-projeto>'}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1">Platform (optional)</label>
              <input
                value={form.platform}
                onChange={(e) => setForm((prev) => ({ ...prev, platform: e.target.value }))}
                placeholder="web / ios / android"
                className="w-full min-h-11 bg-mc-bg border border-mc-border rounded px-3 py-2 text-sm focus:outline-none focus:border-mc-accent"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Template label (optional)</label>
              <input
                value={form.template}
                onChange={(e) => setForm((prev) => ({ ...prev, template: e.target.value }))}
                placeholder="starter-pack-v1"
                className="w-full min-h-11 bg-mc-bg border border-mc-border rounded px-3 py-2 text-sm focus:outline-none focus:border-mc-accent"
              />
            </div>
          </div>

          <div className="space-y-3 pt-1">
            <p className="text-xs text-mc-text-secondary">
              Select template repos per stack. Project scaffolding copies template code into new independent repos (templates are never modified).
            </p>

            <RepoSelector
              label="Frontend repo (Vue)"
              pick={repoMode.frontend}
              customValue={customRepo.frontend}
              defaultUrl={TEMPLATE_DEFAULTS.frontend}
              onPick={(pick) => setRepoMode((p) => ({ ...p, frontend: pick }))}
              onCustomChange={(value) => setCustomRepo((p) => ({ ...p, frontend: value }))}
            />

            <RepoSelector
              label="Backend repo (Rails)"
              pick={repoMode.backend}
              customValue={customRepo.backend}
              defaultUrl={TEMPLATE_DEFAULTS.backend}
              onPick={(pick) => setRepoMode((p) => ({ ...p, backend: pick }))}
              onCustomChange={(value) => setCustomRepo((p) => ({ ...p, backend: value }))}
            />

            <RepoSelector
              label="iOS repo"
              pick={repoMode.ios}
              customValue={customRepo.ios}
              defaultUrl={TEMPLATE_DEFAULTS.ios}
              onPick={(pick) => setRepoMode((p) => ({ ...p, ios: pick }))}
              onCustomChange={(value) => setCustomRepo((p) => ({ ...p, ios: value }))}
            />

            <RepoSelector
              label="Android repo"
              pick={repoMode.android}
              customValue={customRepo.android}
              onPick={(pick) => setRepoMode((p) => ({ ...p, android: pick }))}
              onCustomChange={(value) => setCustomRepo((p) => ({ ...p, android: value }))}
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="min-h-11 px-4 bg-mc-bg border border-mc-border rounded text-sm hover:bg-mc-bg-tertiary"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="min-h-11 px-4 bg-mc-accent text-mc-bg rounded text-sm font-medium hover:bg-mc-accent/90 disabled:opacity-50"
            >
              {saving ? 'Creating...' : 'Create Project'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
