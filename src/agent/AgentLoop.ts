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
import type { ExcalidrawAdapter } from "../excalidraw/ExcalidrawAdapter";

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
  private excalidraw?: ExcalidrawAdapter;

  constructor(
    provider: LLMProvider,
    executor: ToolExecutor,
    maxIterations = 15,
    excalidrawAvailable = false,
    excalidraw?: ExcalidrawAdapter,
  ) {
    this.provider = provider;
    this.executor = executor;
    this.maxIterations = maxIterations;
    this.tools = getTools(excalidrawAvailable);
    this.excalidraw = excalidraw;
  }

  async run(
    userMessage: string,
    history: Message[],
    session: SessionContext,
    callbacks: AgentCallbacks = {},
  ): Promise<string> {
    let initialUserContent: string | ContentBlock[] = userMessage;
    if (session.activeFile?.isDiagram && this.excalidraw) {
      const png = await this.excalidraw.exportToPNG(session.activeFile.path);
      if (png) {
        initialUserContent = [
          { type: "text", text: userMessage },
          { type: "image", source: { type: "base64", media_type: "image/png", data: png } },
        ];
      }
    }

    const messages: Message[] = [
      ...history,
      { role: "user", content: initialUserContent },
    ];

    const systemPrompt = buildSystemPrompt(
      session,
      this.tools.some((t) => t.name === "create_diagram"),
    );

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
      const pendingImages: ContentBlock[] = [];

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

        const hasImages = result.images && result.images.length > 0;
        if (hasImages && this.provider.supportsMultimodalToolResults()) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: [
              { type: "text", text: result.content },
              ...result.images!,
            ],
          });
        } else {
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: result.content,
          });
          if (hasImages && !this.provider.supportsMultimodalToolResults()) {
            pendingImages.push(...result.images!);
          }
        }
      }

      messages.push({ role: "user", content: toolResults });

      if (pendingImages.length > 0) {
        messages.push({
          role: "user",
          content: [
            { type: "text", text: "Diagram görüntüsü (el yazısı ve çizimler dahil):" },
            ...pendingImages,
          ],
        });
      }
    }

    return `[Agent reached max iterations (${iterationLimit}). The last response may be incomplete.]`;
  }
}
