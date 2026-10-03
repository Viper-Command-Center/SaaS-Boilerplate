import type { RawModelResponse, ReasoningEffort } from './anthropic';
import type { ModelConfig, ModelContext } from './modelConfig';
import type { AnthropicTool } from '@/libs/mcp/registry';
import { eq } from 'drizzle-orm';
import { db } from '@/libs/DB';
import { modelCatalog } from '@/models/Schema';
import { resolveModelTransport } from './anthropic';

export type ModelIdentity = {
  context: ModelContext;
  assignedModelId: string;
  displayName: string;
  selectionSource: string;
  transport: ReturnType<typeof resolveModelTransport>['transport'];
  requestedModelId: string | null;
  workspaceSelectionApplied: boolean;
  configuredReasoningEffort: ReasoningEffort | null;
  sentReasoningEffort: ReasoningEffort | null;
  reasoningNote: string;
  responseReceived: boolean;
  providerReportedModelId: string | null;
  requestId: string | null;
  requestModelId: string | null;
  providerModelMatchesRequest: boolean | null;
  warning: string | null;
};

export const MODEL_INFO_TOOL: AnthropicTool = {
  name: 'get_model_info',
  description: 'Read trusted platform model diagnostics for THIS turn: assigned model, chat/build context, transport, model sent to the API, reasoning parameter, and latest successful provider response model/request ID. Not model self-identification. No secrets or extra provider call inside this tool; normal model-turn usage still applies. Changes to workspace assignment apply next turn. If provider model is absent, only request routing—not independent provider model identity—is proven.',
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
};

export function makeModelIdentity(config: ModelConfig, context: ModelContext, catalog?: { displayName: string; supportsReasoning: boolean }): ModelIdentity {
  const route = resolveModelTransport(config.modelId);
  const sent = route.transport === 'bedrock-mantle' && catalog?.supportsReasoning !== false ? config.reasoningEffort ?? null : null;
  return {
    context,
    assignedModelId: config.modelId,
    displayName: catalog?.displayName ?? config.modelId,
    selectionSource: config.selectionSource ?? 'platform-default',
    ...route,
    configuredReasoningEffort: config.reasoningEffort ?? null,
    sentReasoningEffort: sent,
    reasoningNote: route.transport !== 'bedrock-mantle' ? 'Workspace reasoning is not used on legacy transport.' : catalog?.supportsReasoning === false ? 'Catalog marks this model as not supporting a configurable reasoning parameter; omitted. This does not imply the model cannot reason.' : sent === 'low' || sent === 'minimal' ? 'OpenAI-compatible APIs receive this effort; Claude low/minimal disables extended thinking.' : 'Requested effort; provider acceptance does not independently prove reasoning depth.',
    responseReceived: false,
    providerReportedModelId: null,
    requestId: null,
    requestModelId: null,
    providerModelMatchesRequest: null,
    warning: config.selectionSource === 'lookup-fallback' ? 'Workspace lookup failed; platform default selected for this turn.' : route.workspaceSelectionApplied ? null : 'Workspace dropdown selection is NOT applied: legacy single-model transport or no configured provider.',
  };
}

export async function loadModelIdentity(config: ModelConfig, context: ModelContext): Promise<ModelIdentity> {
  let catalog;
  try {
    [catalog] = await db.select({ displayName: modelCatalog.displayName, supportsReasoning: modelCatalog.supportsReasoning }).from(modelCatalog).where(eq(modelCatalog.id, config.modelId)).limit(1);
  } catch {
    // Routing diagnostics still work without a catalog label; do not invent one.
  }
  return makeModelIdentity(config, context, catalog);
}

export function recordModelResponse(identity: ModelIdentity, response: RawModelResponse): void {
  identity.responseReceived = true;
  identity.requestModelId = response._modelId ?? identity.requestedModelId;
  identity.providerReportedModelId = response._providerModelId ?? null;
  identity.requestId = response._requestId ?? null;
  identity.providerModelMatchesRequest = identity.providerReportedModelId && identity.requestModelId
    ? identity.providerReportedModelId === identity.requestModelId
    : null;
}

export function modelIdentityPrompt(identity: ModelIdentity): string {
  return `\n\n## Current model routing — trusted platform metadata, not self-identification\n${JSON.stringify(identity)}\nUse this turn's metadata instead of older transcript claims or training knowledge when asked which model you use. get_model_info returns the latest successful response metadata. Assigned/requested is NOT the same as provider-reported. If providerReportedModelId is absent, say routing is confirmed but the provider did not independently identify the model. Never claim a model switch worked merely because the dropdown changed. This turn keeps one selection; changes apply next turn. Do not claim reasoning depth or capability from the model name alone.`;
}

export function modelReceipt(identity: ModelIdentity): string {
  return `\n[model] ${identity.context} · assigned: ${identity.displayName} (${identity.assignedModelId}) · requested: ${identity.requestModelId ?? identity.requestedModelId ?? 'none'} · via ${identity.transport} · provider-reported: ${identity.providerReportedModelId ?? 'not supplied'}${identity.requestId ? ` · request: ${identity.requestId}` : ''}${identity.providerModelMatchesRequest === false ? ' · provider ID differs (alias or mismatch; inspect before assuming)' : ''}${identity.warning ? ` · WARNING: ${identity.warning}` : ''}\n`;
}
