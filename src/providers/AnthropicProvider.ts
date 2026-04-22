import Anthropic from "@anthropic-ai/sdk";
import type {
  LLMProvider,
  Message,
  Tool,
  LLMResponse,
  ContentBlock,
} from "./LLMProvider";

export class AnthropicProvider implements LLMProvider {
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
    this.model = model;
  }

  supportsNativeToolUse(): boolean {
    return true;
  }

  supportsMultimodalToolResults(): boolean {
    return true;
  }

  async chat(
    messages: Message[],
    tools: Tool[],
    systemPrompt: string,
  ): Promise<LLMResponse> {
    const anthropicMessages = messages.map((m) => ({
      role: m.role,
      content: m.content,
    })) as unknown as Anthropic.MessageParam[];

    const anthropicTools: Anthropic.Tool[] = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema as Anthropic.Tool["input_schema"],
    }));

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: anthropicMessages,
      tools: anthropicTools.length > 0 ? anthropicTools : undefined,
    });

    const content: ContentBlock[] = [];
    const reasoningParts: string[] = [];
    for (const block of response.content as Array<{
      type: string;
      text?: string;
      id?: string;
      name?: string;
      input?: Record<string, unknown>;
      thinking?: string;
    }>) {
      if (block.type === "text" && typeof block.text === "string") {
        content.push({ type: "text", text: block.text });
      } else if (
        block.type === "tool_use" &&
        typeof block.id === "string" &&
        typeof block.name === "string"
      ) {
        content.push({
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.input ?? {},
        });
      } else if (block.type === "thinking") {
        const text = block.thinking ?? block.text;
        if (text?.trim()) reasoningParts.push(text.trim());
      }
      // Ignore unsupported block types (e.g. thinking/redacted_thinking) safely.
    }

    return {
      content,
      stopReason: response.stop_reason ?? "end_turn",
      reasoning:
        reasoningParts.length > 0 ? reasoningParts.join("\n\n") : undefined,
    };
  }

  async streamChat(
    messages: Message[],
    tools: Tool[],
    systemPrompt: string,
    onTextDelta: (delta: string) => void,
    onToolUse: (name: string, id: string) => void,
  ): Promise<LLMResponse> {
    const anthropicMessages = messages.map((m) => ({
      role: m.role,
      content: m.content,
    })) as unknown as Anthropic.MessageParam[];

    const anthropicTools: Anthropic.Tool[] = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema as Anthropic.Tool["input_schema"],
    }));

    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: anthropicMessages,
      tools: anthropicTools.length > 0 ? anthropicTools : undefined,
    });

    for await (const event of stream) {
      if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") {
          onTextDelta(event.delta.text);
        }
      } else if (event.type === "content_block_start") {
        if (event.content_block.type === "tool_use") {
          onToolUse(event.content_block.name, event.content_block.id);
        }
      }
    }

    const final = await stream.finalMessage();
    const content: ContentBlock[] = [];
    for (const block of final.content) {
      if (block.type === "text") {
        content.push({ type: "text", text: block.text });
      } else if (block.type === "tool_use") {
        content.push({
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        });
      }
    }

    return { content, stopReason: final.stop_reason ?? "end_turn" };
  }
}
