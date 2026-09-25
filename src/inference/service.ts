/** Provider-neutral inference service and shared canonical agent loop. */

import type {
  AgentRequest,
  AgentResult,
  InferenceContent,
  InferenceEvent,
  InferenceMessage,
  InferenceRequest,
  InferenceResult,
  InferenceService,
  InferenceToolResult,
  InferenceUsage,
} from '../lib/inference-types';
import type { InferenceProviderAdapter } from './adapter';
import { InferenceFailure } from './adapter';
import { applyCanonicalConversationBreakpoints, hasExtendedFilePrefix } from './cache';
import { completeWithinDeadline, streamWithinDeadline } from './deadline';

/** Adapter resolver injected by the factory so the runtime contains no vendor switch. */
export type AdapterResolver = (request: InferenceRequest) => InferenceProviderAdapter;

/** Async canonical preparation performed before any adapter or provider I/O. */
export type RequestPreparer = (request: InferenceRequest) => Promise<InferenceRequest>;

/** Canonical runtime used by both inference handlers. */
export class DefaultInferenceService implements InferenceService {
  constructor(
    private readonly resolveAdapter: AdapterResolver,
    private readonly prepareRequest: RequestPreparer = async (request) => request,
  ) {}

  async complete(request: InferenceRequest): Promise<InferenceResult> {
    const prepared = await this.prepareRequest(request);
    const adapter = this.resolveAdapter(prepared);
    return completeWithinDeadline(prepared.modelProfile.provider, prepared.abortSignal, (signal) =>
      adapter.complete({ ...prepared, abortSignal: signal }),
    );
  }

  stream(request: InferenceRequest): AsyncIterable<InferenceEvent> {
    return this.preparedStream(request);
  }

  private async *preparedStream(request: InferenceRequest): AsyncIterable<InferenceEvent> {
    const prepared = await this.prepareRequest(request);
    const adapter = this.resolveAdapter(prepared);
    yield* streamWithinDeadline(prepared.modelProfile.provider, prepared.abortSignal, (signal) =>
      adapter.stream({ ...prepared, abortSignal: signal }),
    );
  }

  async runAgent(request: AgentRequest): Promise<AgentResult> {
    const messages: InferenceMessage[] = [...request.messages];
    const accumulatedContent: InferenceContent[] = [];
    let usage = emptyUsage();
    let stopReason: AgentResult['stopReason'] = 'unknown';
    let providerStopReason: string | null | undefined;
    let providerState: InferenceResult['providerState'] = request.continuation;
    let text = '';
    let iterations = 0;

    for (iterations = 1; iterations <= request.maxIterations; iterations += 1) {
      applyCanonicalConversationBreakpoints(messages, hasExtendedFilePrefix(messages) ? 2 : 3);
      const turnRequest: InferenceRequest = {
        prompt: request.prompt,
        promptGroup: request.promptGroup,
        modelProfile: request.modelProfile,
        filePolicy: request.filePolicy,
        messages,
        maxOutputTokens: request.maxOutputTokens,
        tools: request.tools,
        ...(request.toolChoice ? { toolChoice: request.toolChoice } : {}),
        ...(request.effort ? { effort: request.effort } : {}),
        ...(request.structuredOutput ? { structuredOutput: request.structuredOutput } : {}),
        ...(request.sampling ? { sampling: request.sampling } : {}),
        ...(request.stopSequences ? { stopSequences: request.stopSequences } : {}),
        ...(request.metadata ? { metadata: request.metadata } : {}),
        ...(request.serviceTier ? { serviceTier: request.serviceTier } : {}),
        ...(providerState ? { continuation: providerState } : {}),
        ...(request.abortSignal ? { abortSignal: request.abortSignal } : {}),
      };
      if (request.onEvent) {
        await request.onEvent({
          type: 'agent-turn-start',
          iteration: iterations,
          request: turnRequest,
        });
      }

      let turn: InferenceResult | null = null;
      for await (const event of this.stream(turnRequest)) {
        if (request.onEvent) await request.onEvent(event);
        if (event.type === 'usage') usage = event.usage;
        if (event.type === 'complete') turn = event.result;
        if (event.type === 'error') throw new InferenceFailure(event.error);
      }
      if (!turn) throw new Error('Inference stream completed without a terminal result');

      usage = turn.usage;
      stopReason = turn.stopReason;
      providerStopReason = turn.providerStopReason;
      providerState = turn.providerState;
      accumulatedContent.push(...turn.content);
      const turnText = turn.content
        .filter(
          (content): content is Extract<InferenceContent, { type: 'text' }> =>
            content.type === 'text',
        )
        .map((content) => content.text)
        .join('');
      if (turnText) text += `${text ? '\n' : ''}${turnText}`;
      messages.push({
        role: 'assistant',
        content: turn.content,
        ...(turn.providerState ? { providerState: turn.providerState } : {}),
      });

      if (turn.stopReason !== 'tool-call' || turn.toolCalls.length === 0) break;
      if (request.mode === 'client') break;
      if (request.mode === 'none') {
        throw new Error('Tool-free inference returned a tool call');
      }

      const toolResults: InferenceToolResult[] = [];
      for (const call of turn.toolCalls) {
        const result = await request.executeTool(call);
        toolResults.push(result);
        if (request.onEvent) await request.onEvent({ type: 'tool-result', result });
      }
      messages.push({ role: 'user', content: toolResults });
      if (iterations === request.maxIterations && providerState) {
        const adapter = this.resolveAdapter(turnRequest);
        if (adapter.finalizeAgentContinuation) {
          providerState = adapter.finalizeAgentContinuation(providerState, toolResults);
        }
      }
    }

    if (iterations > request.maxIterations && stopReason === 'tool-call') {
      stopReason = 'max-iterations';
    }

    return {
      content: accumulatedContent,
      toolCalls:
        stopReason === 'tool-call'
          ? accumulatedContent.filter((content) => content.type === 'tool-call')
          : [],
      usage,
      stopReason,
      ...(providerStopReason !== undefined ? { providerStopReason } : {}),
      ...(providerState ? { providerState } : {}),
      iterations: Math.min(iterations, request.maxIterations),
      text,
    };
  }
}

function emptyUsage(): InferenceUsage {
  return {
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    cacheWriteInputTokens: null,
    reasoningTokens: null,
  };
}
