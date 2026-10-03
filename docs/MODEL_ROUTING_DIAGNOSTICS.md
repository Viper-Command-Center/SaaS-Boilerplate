# Model routing diagnostics

Every metered agent turn resolves the workspace's chat/build model once. The
model now receives a trusted current-routing section in its system prompt and
can call `get_model_info` for the latest successful response metadata. This
read-only tool is added by the loop on operator chat, site chat, approval resume,
scheduled work and missions. It cannot inspect another workspace or change
assignments; it makes no provider call of its own.

The platform (not the model) writes a `[model]` line after the first successful
response. It includes the assigned label/ID, selected context, requested model,
transport, provider-reported model and request ID when supplied. The transcript
persists this receipt. A `model.response` audit row records each successful call,
including token usage and the latest metadata; failures do not produce a success
receipt. The existing cost ledger remains keyed by the requested catalog model
ID, because provider aliases may not have pricing rows.

## How to test a workspace change

1. Set Chat Model and Build Model in Platform Admin. Changes affect the next
   turn; an existing turn keeps its selection.
2. In a new dashboard/operator chat turn ask: "Call get_model_info and tell me
   the assigned model, requested model, provider-reported model, request ID and
   whether my workspace selection was applied."
3. Compare the answer with the platform `[model]` receipt, not model
   self-identification or an old message.
4. Repeat in WordPress site chat if testing that surface. Site chat explicitly
   uses the BUILD assignment. Dashboard chat uses CHAT; missions/scheduled work
   normally use BUILD.
5. Review usage by model source to assess costs. A name alone does not prove
   lower spending or equivalent tool quality.

## Evidence levels

- `assignedModelId`: workspace setting/default resolved for this turn.
- `requestedModelId`: actual transport target selected by shared routing logic.
- `requestModelId`: model sent by the transport for the successful call.
- `providerReportedModelId`: provider response's `model` field. `null` means
  the provider did not independently identify the model; never infer it.
- `requestId`: response-header correlation ID, not proof of model identity alone.
- `providerModelMatchesRequest`: exact string match; a differing value may be an
  alias/version ID or a routing discrepancy, not automatically a failed switch.

Bedrock Mantle applies workspace model choices. Legacy Bedrock Runtime or
Anthropic-direct routing uses one platform model and ignores workspace choices;
diagnostics explicitly warn about this. Database lookup failure is separately
labelled `lookup-fallback`, never presented as a successful workspace lookup.

Reasoning effort is omitted when the model catalog marks configurable reasoning
unsupported. Diagnostics distinguish configured effort from the effort sent;
this does not imply a model cannot reason, or independently prove reasoning
depth. No credentials or API keys are exposed.

No database migration is required for these diagnostics. Live provider/model
identity and actual workspace savings still require testing after deployment.