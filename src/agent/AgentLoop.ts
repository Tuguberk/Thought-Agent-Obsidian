import type {
  LLMProvider,
  Message,
  ContentBlock,
  ToolUseBlock,
} from "../providers/LLMProvider";
import type { ToolExecutor } from "./ToolExecutor";
import type { SessionContext } from "./SessionContext";
import { buildSystemPrompt } from "./SystemPrompt";
import { getTools } from "../tools/index";
import type { Tool } from "../providers/LLMProvider";
import type { PendingChange } from "../changes/PendingChange";

export interface AgentCallbacks {
  onTextDelta?: (text: string) => void;
  onToolCall?: (name: string, input: Record<string, unknown>) => void;
  onToolResult?: (name: string, result: string) => void;
  onPendingChange?: (change: PendingChange) => void;
  onGraphQuery?: (filter: Record<string, unknown>) => void;
  onThinkingStart?: () => void;
  onThinkingEnd?: (durationMs: number, reasoning?: string) => void;
  maxIterationsOverride?: number;
  signal?: AbortSignal;
}

export class AgentLoop {
  private provider: LLMProvider;
  private executor: ToolExecutor;
  private maxIterations: number;
  private tools: Tool[];

  constructor(
    provider: LLMProvider,
    executor: ToolExecutor,
    maxIterations = 15,
    excalidrawAvailable = false,
  ) {
    this.provider = provider;
    this.executor = executor;
    this.maxIterations = maxIterations;
    this.tools = getTools(excalidrawAvailable);
  }

  async run(
    userMessage: string,
    history: Message[],
    session: SessionContext,
    callbacks: AgentCallbacks = {},
  ): Promise<string> {
    const messages: Message[] = [
      ...history,
      { role: "user", content: userMessage },
    ];

    const systemPrompt = buildSystemPrompt(session, this.tools.some((t) => t.name === 'create_diagram'));

    const iterationLimit = Math.max(
      1,
      callbacks.maxIterationsOverride ?? this.maxIterations,
    );

    for (let i = 0; i < iterationLimit; i++) {
      if (callbacks.signal?.aborted)
        throw new DOMException("Stopped by user", "AbortError");

      callbacks.onThinkingStart?.();
      const t0 = Date.now();
      const response = await this.provider.chat(
        messages,
        this.tools,
        systemPrompt,
      );
      callbacks.onThinkingEnd?.(Date.now() - t0, response.reasoning);

      if (callbacks.signal?.aborted)
        throw new DOMException("Stopped by user", "AbortError");

      messages.push({ role: "assistant", content: response.content });

      const textBlocks = response.content.filter(
        (b): b is { type: "text"; text: string } => b.type === "text",
      );
      for (const block of textBlocks) {
        if (callbacks.onTextDelta) callbacks.onTextDelta(block.text);
      }

      const toolUseBlocks = response.content.filter(
        (b): b is ToolUseBlock => b.type === "tool_use",
      );

      if (toolUseBlocks.length === 0) {
        return textBlocks.map((b) => b.text).join("");
      }

      const toolResults: ContentBlock[] = [];

      for (const toolUse of toolUseBlocks) {
        if (callbacks.onToolCall)
          callbacks.onToolCall(toolUse.name, toolUse.input);

        const result = await this.executor.execute(toolUse.name, toolUse.input);

        if (result.pendingChange && callbacks.onPendingChange) {
          callbacks.onPendingChange(result.pendingChange);
        }

        if (result.graphFilter && callbacks.onGraphQuery) {
          callbacks.onGraphQuery(result.graphFilter as Record<string, unknown>);
        }

        if (callbacks.onToolResult)
          callbacks.onToolResult(toolUse.name, result.content);

        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: result.content,
        });
      }

      messages.push({ role: "user", content: toolResults });
    }

    return `[Agent reached max iterations (${iterationLimit}). The last response may be incomplete.]`;
  }
}
