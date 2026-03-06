'use client';

import { useState, useEffect } from 'react';
import { X, Save, Trash2, Link2 } from 'lucide-react';
import { useMissionControl } from '@/lib/store';
import type { Agent, AgentStatus, DiscoveredAgent } from '@/lib/types';

interface AgentModalProps {
  agent?: Agent;
  onClose: () => void;
  workspaceId?: string;
  onAgentCreated?: (agentId: string) => void;
}

const EMOJI_OPTIONS = ['🤖', '🦞', '💻', '🔍', '✍️', '🎨', '📊', '🧠', '⚡', '🚀', '🎯', '🔧'];

export function AgentModal({ agent, onClose, workspaceId, onAgentCreated }: AgentModalProps) {
  const { addAgent, updateAgent } = useMissionControl();
  const [activeTab, setActiveTab] = useState<'info' | 'soul' | 'user' | 'agents'>('info');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [availableOpenClawAgents, setAvailableOpenClawAgents] = useState<DiscoveredAgent[]>([]);
  const [openClawAgentsLoading, setOpenClawAgentsLoading] = useState(true);
  const [mappingNow, setMappingNow] = useState(false);
  const [mappingNotice, setMappingNotice] = useState<string | null>(null);

  const [form, setForm] = useState({
    name: agent?.name || '',
    role: agent?.role || '',
    description: agent?.description || '',
    avatar_emoji: agent?.avatar_emoji || '🤖',
    status: agent?.status || 'standby' as AgentStatus,
    is_master: agent?.is_master || false,
    soul_md: agent?.soul_md || '',
    user_md: agent?.user_md || '',
    agents_md: agent?.agents_md || '',
    model: agent?.model || '',
    gateway_agent_id: agent?.gateway_agent_id || '',
    source: agent?.source || 'local',
    mapping_status: agent?.mapping_status || (agent?.gateway_agent_id ? 'mapped' : 'unmapped'),
    mapping_error: agent?.mapping_error || '',
  });

  // Load available OpenClaw agents from Gateway discovery
  useEffect(() => {
    const loadOpenClawAgents = async () => {
      try {
        const res = await fetch('/api/agents/discover');
        if (res.ok) {
          const data = await res.json();
          const discovered = (data.agents || []) as DiscoveredAgent[];
          setAvailableOpenClawAgents(discovered);
        }
      } catch (error) {
        console.error('Failed to load OpenClaw agents:', error);
      } finally {
        setOpenClawAgentsLoading(false);
      }
    };
    loadOpenClawAgents();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent?.id]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);

    try {
      const url = agent ? `/api/agents/${agent.id}` : '/api/agents';
      const method = agent ? 'PATCH' : 'POST';

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          source: form.gateway_agent_id ? 'gateway' : 'local',
          mapping_status: form.gateway_agent_id ? 'mapped' : (form.mapping_status || 'unmapped'),
          mapping_error: form.gateway_agent_id ? null : (form.mapping_error || null),
          hydrate_from_openclaw: !!form.gateway_agent_id,
          workspace_id: workspaceId || agent?.workspace_id || 'default',
        }),
      });

      if (res.ok) {
        const savedAgent = await res.json();
        if (agent) {
          updateAgent(savedAgent);
        } else {
          addAgent(savedAgent);
          // Notify parent if callback provided (e.g., for inline agent creation)
          if (onAgentCreated) {
            onAgentCreated(savedAgent.id);
          }
        }
        onClose();
      }
    } catch (error) {
      console.error('Failed to save agent:', error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!agent || !confirm(`Delete ${agent.name}?`)) return;

    try {
      const res = await fetch(`/api/agents/${agent.id}`, { method: 'DELETE' });
      if (res.ok) {
        // Remove from store
        useMissionControl.setState((state) => ({
          agents: state.agents.filter((a) => a.id !== agent.id),
          selectedAgent: state.selectedAgent?.id === agent.id ? null : state.selectedAgent,
        }));
        onClose();
      }
    } catch (error) {
      console.error('Failed to delete agent:', error);
    }
  };

  const handleMapNow = async () => {
    if (!agent || !form.gateway_agent_id) return;
    setMappingNow(true);
    setMappingNotice(null);

    try {
      const res = await fetch(`/api/agents/${agent.id}/map`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          gateway_agent_id: form.gateway_agent_id,
          hydrate_from_openclaw: true,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setMappingNotice(data.error || 'Failed to map agent');
        return;
      }

      updateAgent(data);
      setForm((prev) => ({
        ...prev,
        source: 'gateway',
        mapping_status: data.mapping_status || 'mapped',
        mapping_error: data.mapping_error || '',
        soul_md: data.soul_md || prev.soul_md,
        user_md: data.user_md || prev.user_md,
        agents_md: data.agents_md || prev.agents_md,
      }));
      setMappingNotice('Mapped and synced from OpenClaw agent files.');
    } catch (error) {
      console.error('Failed to map agent:', error);
      setMappingNotice('Failed to map agent');
    } finally {
      setMappingNow(false);
    }
  };

  const tabs = [
    { id: 'info', label: 'Info' },
    { id: 'soul', label: 'SOUL.md' },
    { id: 'user', label: 'USER.md' },
    { id: 'agents', label: 'AGENTS.md' },
  ] as const;

  const selectedOpenClawAgent = availableOpenClawAgents.find((a) => a.id === form.gateway_agent_id);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-50 p-3 sm:p-4">
      <div className="bg-mc-bg-secondary border border-mc-border rounded-t-xl sm:rounded-lg w-full max-w-2xl max-h-[92vh] sm:max-h-[90vh] flex flex-col pb-[env(safe-area-inset-bottom)] sm:pb-0">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-mc-border">
          <h2 className="text-lg font-semibold">
            {agent ? `Edit ${agent.name}` : 'Create New Agent'}
          </h2>
          <button
            onClick={onClose}
            className="p-1 hover:bg-mc-bg-tertiary rounded"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-mc-border overflow-x-auto">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 min-h-11 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                activeTab === tab.id
                  ? 'border-mc-accent text-mc-accent'
                  : 'border-transparent text-mc-text-secondary hover:text-mc-text'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-4">
          {activeTab === 'info' && (
            <div className="space-y-4">
              {/* Avatar Selection */}
              <div>
                <label className="block text-sm font-medium mb-2">Avatar</label>
                <div className="flex flex-wrap gap-2">
                  {EMOJI_OPTIONS.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      onClick={() => setForm({ ...form, avatar_emoji: emoji })}
                      className={`text-2xl p-2 rounded hover:bg-mc-bg-tertiary ${
                        form.avatar_emoji === emoji
                          ? 'bg-mc-accent/20 ring-2 ring-mc-accent'
                          : ''
                      }`}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              </div>

              {/* Name */}
              <div>
                <label className="block text-sm font-medium mb-1">Name</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  required
                  className="w-full min-h-11 bg-mc-bg border border-mc-border rounded px-3 py-2 text-sm focus:outline-none focus:border-mc-accent"
                  placeholder="Agent name"
                />
              </div>

              {/* Role */}
              <div>
                <label className="block text-sm font-medium mb-1">Role</label>
                <input
                  type="text"
                  value={form.role}
                  onChange={(e) => setForm({ ...form, role: e.target.value })}
                  required
                  className="w-full min-h-11 bg-mc-bg border border-mc-border rounded px-3 py-2 text-sm focus:outline-none focus:border-mc-accent"
                  placeholder="e.g., Code & Automation"
                />
              </div>

              {/* Description */}
              <div>
                <label className="block text-sm font-medium mb-1">Description</label>
                <textarea
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  rows={2}
                  className="w-full bg-mc-bg border border-mc-border rounded px-3 py-2 text-sm focus:outline-none focus:border-mc-accent resize-none"
                  placeholder="What does this agent do?"
                />
              </div>

              {/* Status */}
              <div>
                <label className="block text-sm font-medium mb-1">Status</label>
                <select
                  value={form.status}
                  onChange={(e) => setForm({ ...form, status: e.target.value as AgentStatus })}
                  className="w-full min-h-11 bg-mc-bg border border-mc-border rounded px-3 py-2 text-sm focus:outline-none focus:border-mc-accent"
                >
                  <option value="standby">Standby</option>
                  <option value="working">Working</option>
                  <option value="offline">Offline</option>
                </select>
              </div>

              {/* Master Toggle */}
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="is_master"
                  checked={form.is_master}
                  onChange={(e) => setForm({ ...form, is_master: e.target.checked })}
                  className="w-4 h-4"
                />
                <label htmlFor="is_master" className="text-sm">
                  Master Orchestrator (can coordinate other agents)
                </label>
              </div>

              {/* OpenClaw Agent Selection */}
              <div>
                <label className="block text-sm font-medium mb-1">Execution Agent</label>
                {openClawAgentsLoading ? (
                  <div className="text-sm text-mc-text-secondary">Loading OpenClaw agents...</div>
                ) : (
                  <select
                    value={form.gateway_agent_id}
                    onChange={(e) => {
                      const gatewayAgentId = e.target.value;
                      const selected = availableOpenClawAgents.find((a) => a.id === gatewayAgentId);
                      setForm({
                        ...form,
                        gateway_agent_id: gatewayAgentId,
                        model: selected?.model || '',
                        source: gatewayAgentId ? 'gateway' : 'local',
                      });
                    }}
                    className="w-full min-h-11 bg-mc-bg border border-mc-border rounded px-3 py-2 text-sm focus:outline-none focus:border-mc-accent"
                  >
                    <option value="">-- No linked OpenClaw agent --</option>
                    {availableOpenClawAgents.map((openclawAgent) => (
                      <option key={openclawAgent.id} value={openclawAgent.id}>
                        {openclawAgent.name} ({openclawAgent.model || 'no primary model'})
                      </option>
                    ))}
                  </select>
                )}
                <p className="text-xs text-mc-text-secondary mt-1">
                  Uses this OpenClaw agent&apos;s primary model.
                  {selectedOpenClawAgent?.model ? ` Current primary: ${selectedOpenClawAgent.model}.` : ''}
                </p>
                {!form.gateway_agent_id && form.model && (
                  <p className="text-xs text-amber-300 mt-1">
                    Legacy model-only configuration detected ({form.model}). Link an OpenClaw agent to migrate.
                  </p>
                )}
              </div>

              {agent && (
                <div className="p-3 border border-mc-border rounded-lg bg-mc-bg">
                  <div className="text-xs text-mc-text-secondary mb-2">
                    Mapping status: <span className="font-medium text-mc-text">{form.mapping_status || 'unmapped'}</span>
                    {form.mapping_error && <span className="text-red-400"> — {form.mapping_error}</span>}
                  </div>
                  <button
                    type="button"
                    disabled={!form.gateway_agent_id || mappingNow}
                    onClick={handleMapNow}
                    className="min-h-11 inline-flex items-center gap-2 px-3 py-2 bg-blue-500/15 border border-blue-500/30 text-blue-300 rounded text-sm hover:bg-blue-500/25 disabled:opacity-50"
                  >
                    <Link2 className="w-4 h-4" />
                    {mappingNow ? 'Mapping...' : 'Map & Sync from OpenClaw'}
                  </button>
                  {mappingNotice && (
                    <p className="text-xs mt-2 text-mc-text-secondary">{mappingNotice}</p>
                  )}
                </div>
              )}
            </div>
          )}

          {activeTab === 'soul' && (
            <div>
              <label className="block text-sm font-medium mb-2">
                SOUL.md - Agent Personality & Identity
              </label>
              <textarea
                value={form.soul_md}
                onChange={(e) => setForm({ ...form, soul_md: e.target.value })}
                rows={15}
                className="w-full bg-mc-bg border border-mc-border rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-mc-accent resize-none"
                placeholder="# Agent Name&#10;&#10;Define this agent's personality, values, and communication style..."
              />
            </div>
          )}

          {activeTab === 'user' && (
            <div>
              <label className="block text-sm font-medium mb-2">
                USER.md - Context About the Human
              </label>
              <textarea
                value={form.user_md}
                onChange={(e) => setForm({ ...form, user_md: e.target.value })}
                rows={15}
                className="w-full bg-mc-bg border border-mc-border rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-mc-accent resize-none"
                placeholder="# User Context&#10;&#10;Information about the human this agent works with..."
              />
            </div>
          )}

          {activeTab === 'agents' && (
            <div>
              <label className="block text-sm font-medium mb-2">
                AGENTS.md - Team Awareness
              </label>
              <textarea
                value={form.agents_md}
                onChange={(e) => setForm({ ...form, agents_md: e.target.value })}
                rows={15}
                className="w-full bg-mc-bg border border-mc-border rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-mc-accent resize-none"
                placeholder="# Team Roster&#10;&#10;Information about other agents this agent works with..."
              />
            </div>
          )}
        </form>

        {/* Footer */}
        <div className="flex items-center justify-between p-4 border-t border-mc-border">
          <div>
            {agent && (
              <button
                type="button"
                onClick={handleDelete}
                className="min-h-11 flex items-center gap-2 px-3 py-2 text-mc-accent-red hover:bg-mc-accent-red/10 rounded text-sm"
              >
                <Trash2 className="w-4 h-4" />
                Delete
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="min-h-11 px-4 py-2 text-sm text-mc-text-secondary hover:text-mc-text"
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={isSubmitting}
              className="min-h-11 flex items-center gap-2 px-4 py-2 bg-mc-accent text-mc-bg rounded text-sm font-medium hover:bg-mc-accent/90 disabled:opacity-50"
            >
              <Save className="w-4 h-4" />
              {isSubmitting ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
