'use client';

import { useState } from 'react';
import { X, FolderPlus } from 'lucide-react';

interface ProjectModalProps {
  workspaceId?: string;
  onClose: () => void;
}

export function ProjectModal({ workspaceId, onClose }: ProjectModalProps) {
  const [form, setForm] = useState({
    name: '',
    repo_path: '',
    platform: '',
    template: '',
    template_frontend_repo: '',
    template_backend_repo: '',
    template_ios_repo: '',
    template_android_repo: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!form.name.trim() || !form.repo_path.trim()) {
      setError('Name and repository path are required.');
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
          repo_path: form.repo_path.trim(),
          platform: form.platform.trim() || null,
          template: form.template.trim() || null,
          template_frontend_repo: form.template_frontend_repo.trim() || null,
          template_backend_repo: form.template_backend_repo.trim() || null,
          template_ios_repo: form.template_ios_repo.trim() || null,
          template_android_repo: form.template_android_repo.trim() || null,
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
      <div className="w-full max-w-lg bg-mc-bg-secondary border border-mc-border rounded-lg shadow-2xl">
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
            <label className="block text-sm font-medium mb-1">Repository path</label>
            <input
              value={form.repo_path}
              onChange={(e) => setForm((prev) => ({ ...prev, repo_path: e.target.value }))}
              placeholder="/Users/magnuseng/Projects/mission-control"
              className="w-full min-h-11 bg-mc-bg border border-mc-border rounded px-3 py-2 text-sm focus:outline-none focus:border-mc-accent"
              required
            />
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
              Optional GitHub template repos. If provided, we clone content into independent repos under this project folder.
            </p>
            <div>
              <label className="block text-sm font-medium mb-1">Frontend template (Vue)</label>
              <input
                value={form.template_frontend_repo}
                onChange={(e) => setForm((prev) => ({ ...prev, template_frontend_repo: e.target.value }))}
                placeholder="https://github.com/your-org/vue-template"
                className="w-full min-h-11 bg-mc-bg border border-mc-border rounded px-3 py-2 text-sm focus:outline-none focus:border-mc-accent"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Backend template (Rails)</label>
              <input
                value={form.template_backend_repo}
                onChange={(e) => setForm((prev) => ({ ...prev, template_backend_repo: e.target.value }))}
                placeholder="https://github.com/your-org/rails-template"
                className="w-full min-h-11 bg-mc-bg border border-mc-border rounded px-3 py-2 text-sm focus:outline-none focus:border-mc-accent"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">iOS template repo</label>
              <input
                value={form.template_ios_repo}
                onChange={(e) => setForm((prev) => ({ ...prev, template_ios_repo: e.target.value }))}
                placeholder="https://github.com/your-org/ios-template"
                className="w-full min-h-11 bg-mc-bg border border-mc-border rounded px-3 py-2 text-sm focus:outline-none focus:border-mc-accent"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Android template repo</label>
              <input
                value={form.template_android_repo}
                onChange={(e) => setForm((prev) => ({ ...prev, template_android_repo: e.target.value }))}
                placeholder="https://github.com/your-org/android-template"
                className="w-full min-h-11 bg-mc-bg border border-mc-border rounded px-3 py-2 text-sm focus:outline-none focus:border-mc-accent"
              />
            </div>
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
