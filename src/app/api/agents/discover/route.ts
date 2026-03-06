import { NextResponse } from 'next/server';
import { queryAll } from '@/lib/db';
import { getOpenClawClient } from '@/lib/openclaw/client';
import type { Agent, DiscoveredAgent } from '@/lib/types';

// This route must always be dynamic - it queries live Gateway state + DB
export const dynamic = 'force-dynamic';

// Shape of an agent returned by the OpenClaw Gateway `agents.list` call
interface GatewayAgent {
  id?: string;
  name?: string;
  label?: string;
  model?: string | { primary?: string; [key: string]: unknown };
  channel?: string;
  status?: string;
  [key: string]: unknown;
}

interface GatewayConfigLike {
  config?: {
    agents?: {
      list?: Array<{
        id?: string;
        name?: string;
        model?: {
          primary?: string;
        };
      }>;
    };
  };
}

function extractPrimaryModelFromGatewayAgent(agent: GatewayAgent): string | undefined {
  const directModel = agent.model;
  if (typeof directModel === 'string' && directModel.trim()) return directModel;
  if (directModel && typeof directModel === 'object' && typeof directModel.primary === 'string' && directModel.primary.trim()) {
    return directModel.primary;
  }

  const nestedPrimaryCandidates = [
    (agent as { config?: { model?: { primary?: unknown } } }).config?.model?.primary,
    (agent as { models?: { primary?: unknown } }).models?.primary,
    (agent as { runtime?: { model?: { primary?: unknown } } }).runtime?.model?.primary,
  ];

  for (const candidate of nestedPrimaryCandidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
  }

  return undefined;
}

// GET /api/agents/discover - Discover existing agents from the OpenClaw Gateway
export async function GET() {
  try {
    const client = getOpenClawClient();

    if (!client.isConnected()) {
      try {
        await client.connect();
      } catch {
        return NextResponse.json(
          { error: 'Failed to connect to OpenClaw Gateway. Is it running?' },
          { status: 503 }
        );
      }
    }

    let gatewayAgents: GatewayAgent[];
    try {
      gatewayAgents = (await client.listAgents()) as GatewayAgent[];
    } catch (err) {
      console.error('Failed to list agents from Gateway:', err);
      return NextResponse.json(
        { error: 'Failed to list agents from OpenClaw Gateway' },
        { status: 502 }
      );
    }

    let modelByAgentIdFromConfig = new Map<string, string>();
    try {
      const config = (await client.getConfig()) as GatewayConfigLike;
      const configuredAgents = config?.config?.agents?.list || [];
      modelByAgentIdFromConfig = new Map(
        configuredAgents
          .map((entry) => {
            const key = entry.id || entry.name;
            const model = entry.model?.primary;
            if (!key || !model) return null;
            return [key, model] as const;
          })
          .filter((x): x is readonly [string, string] => x !== null)
      );
    } catch (err) {
      // Non-fatal: discovery still works without config snapshot
      console.warn('Failed to resolve model.primary from config.get:', err);
    }

    if (!Array.isArray(gatewayAgents)) {
      return NextResponse.json(
        { error: 'Unexpected response from Gateway agents.list' },
        { status: 502 }
      );
    }

    // Get all agents already imported from the gateway
    const existingAgents = queryAll<Agent>(
      `SELECT * FROM agents WHERE gateway_agent_id IS NOT NULL`
    );
    const importedGatewayIds = new Map(
      existingAgents.map((a) => [a.gateway_agent_id, a.id])
    );

    // Map gateway agents to our DiscoveredAgent type
    const discovered: DiscoveredAgent[] = gatewayAgents.map((ga) => {
      const gatewayId = ga.id || ga.name || '';
      const alreadyImported = importedGatewayIds.has(gatewayId);
      const discoveredModel =
        extractPrimaryModelFromGatewayAgent(ga) ||
        (gatewayId ? modelByAgentIdFromConfig.get(gatewayId) : undefined) ||
        (ga.name ? modelByAgentIdFromConfig.get(ga.name) : undefined);

      return {
        id: gatewayId,
        name: ga.name || ga.label || gatewayId,
        label: ga.label,
        model: discoveredModel,
        channel: ga.channel,
        status: ga.status,
        already_imported: alreadyImported,
        existing_agent_id: alreadyImported ? importedGatewayIds.get(gatewayId) : undefined,
      };
    });

    return NextResponse.json({
      agents: discovered,
      total: discovered.length,
      already_imported: discovered.filter((a) => a.already_imported).length,
    });
  } catch (error) {
    console.error('Failed to discover agents:', error);
    return NextResponse.json(
      { error: 'Failed to discover agents from Gateway' },
      { status: 500 }
    );
  }
}
