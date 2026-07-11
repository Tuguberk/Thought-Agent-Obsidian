import { requestUrl, loadPdfJs } from "obsidian";
import type {
  LLMProvider,
  Message,
  Tool,
  LLMResponse,
  ContentBlock,
  ImageBlock,
  DocumentBlock,
} from "./LLMProvider";

// OpenAI multimodal content part
type OAIContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "auto" | "high" | "low" } };

interface OAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | OAIContentPart[] | null;
  tool_calls?: OAIToolCall[];
  tool_call_id?: string;
}

interface OAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OAIResponse {
  choices: Array<{
    finish_reason: string;
    message: {
      role: string;
      content: string | null;
      reasoning_content?: string; // Qwen3 thinking mode
      reasoning?: string; // OpenRouter thinking models expose it under `reasoning`
      tool_calls?: OAIToolCall[];
    };
  }>;
}

// Qwen3 and some other models embed tool calls as XML inside content/reasoning_content.
// Format: <tool_call><function=NAME><parameter=KEY>VALUE</parameter></function></tool_call>
// This parser is resilient to truncated output (finish_reason: "length").
function parseXmlToolCalls(text: string): OAIToolCall[] {
  const results: OAIToolCall[] = [];

  // Match complete <tool_call>...</tool_call> blocks OR a truncated one at the end of text
  const tcRegex = /<tool_call>([\s\S]*?)(?:<\/tool_call>|$)/g;
  let tcMatch: RegExpExecArray | null;
  while ((tcMatch = tcRegex.exec(text)) !== null) {
    const inner = tcMatch[1];
    if (!inner.trim()) continue;

    // Accept complete <function=X>...</function> OR truncated (no closing tag)
    const funcMatch = /<function=([^\s>]+)>([\s\S]*?)(?:<\/function>|$)/s.exec(
      inner,
    );
    if (!funcMatch) continue;

    const name = funcMatch[1].trim();
    const paramsText = funcMatch[2];
    const params: Record<string, unknown> = {};

    // Match complete <parameter=K>V</parameter> OR a truncated last parameter
    const paramRegex =
      /<parameter=([^\s>]+)>([\s\S]*?)(?:<\/parameter>|(?=<parameter=)|$)/gs;
    let paramMatch: RegExpExecArray | null;
    while ((paramMatch = paramRegex.exec(paramsText)) !== null) {
      const key = paramMatch[1].trim();
      // Strip any trailing incomplete closing tag artifact (e.g. "</param")
      const val = paramMatch[2].replace(/<\/\w*$/, "").trim();
      if (!key) continue;
      const num = Number(val);
      params[key] = isNaN(num) || val === "" ? val : num;
    }

    if (!name) continue;
    results.push({
      id: `call_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      type: "function",
      function: { name, arguments: JSON.stringify(params) },
    });
  }
  return results;
}

// Minimal shape of the pdf.js module returned by Obsidian's loadPdfJs(), which
// is typed as `any`. Casting to this narrow interface keeps the extraction code
// type-safe instead of propagating `any`.
interface PdfPage {
  getTextContent: () => Promise<{ items: Array<{ str: string }> }>;
}
interface PdfDocument {
  numPages: number;
  getPage: (n: number) => Promise<PdfPage>;
}
interface PdfJsModule {
  getDocument: (src: { data: Uint8Array }) => { promise: Promise<PdfDocument> };
}

async function extractPdfText(base64: string): Promise<string> {
  const pdfjs = (await loadPdfJs()) as PdfJsModule;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const pdf = await pdfjs.getDocument({ data: bytes }).promise;
  const parts: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    parts.push(content.items.map((it) => it.str).join(" "));
  }
  return parts.join("\n\n");
}

export class OpenAICompatibleProvider implements LLMProvider {
  constructor(
    private baseUrl: string,
    private model: string,
    private apiKey = "lm-studio",
    private maxTokens = 16384,
    // Extra request headers (e.g. OpenRouter's HTTP-Referer / X-OpenRouter-Title
    // attribution). Merged into every chat/completions call.
    private extraHeaders: Record<string, string> = {},
  ) {}

  supportsNativeToolUse(): boolean {
    return true;
  }

  supportsMultimodalToolResults(): boolean {
    return false;
  }

  private async preprocessMessages(messages: Message[]): Promise<Message[]> {
    const result: Message[] = [];
    for (const msg of messages) {
      if (typeof msg.content === "string") {
        result.push(msg);
        continue;
      }
      const newBlocks: ContentBlock[] = [];
      for (const block of msg.content) {
        if (block.type === "document") {
          try {
            const text = await extractPdfText(block.source.data);
            newBlocks.push({ type: "text", text: `[PDF içeriği]\n${text}` });
          } catch {
            newBlocks.push({ type: "text", text: "[PDF okunamadı]" });
          }
        } else {
          newBlocks.push(block);
        }
      }
      result.push({ role: msg.role, content: newBlocks });
    }
    return result;
  }

  async chat(
    messages: Message[],
    tools: Tool[],
    systemPrompt: string,
  ): Promise<LLMResponse> {
    const processed = await this.preprocessMessages(messages);
    const oaiMessages: OAIMessage[] = [
      { role: "system", content: systemPrompt },
      ...this.convertMessages(processed),
    ];

    const body: Record<string, unknown> = {
      model: this.model,
      messages: oaiMessages,
      max_tokens: this.maxTokens,
      temperature: 0.7,
    };

    if (tools.length > 0) {
      body.tools = tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.input_schema,
        },
      }));
      body.tool_choice = "auto";
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.extraHeaders,
    };
    if (this.apiKey && this.apiKey !== "lm-studio") {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    const res = await requestUrl({
      url: `${this.baseUrl}/chat/completions`,
      method: "POST",
      headers,
      body: JSON.stringify(body),
      throw: false,
    });

    if (res.status >= 400) {
      throw new Error(`API error ${res.status}: ${res.text}`);
    }

    const data = res.json as OAIResponse;
    const choice = data.choices[0];
    const msg = choice.message;
    const content: ContentBlock[] = [];

    // Different OpenAI-compatible backends expose chain-of-thought under
    // different keys: LM Studio/Qwen use `reasoning_content`, OpenRouter uses
    // `reasoning`. Treat either as the reasoning text.
    const reasoningText = msg.reasoning_content ?? msg.reasoning;

    // Resolve tool calls: prefer structured tool_calls, fall back to XML in content/reasoning
    let toolCalls = msg.tool_calls ?? [];
    if (toolCalls.length === 0) {
      const searchText = (reasoningText ?? "") + (msg.content ?? "");
      toolCalls = parseXmlToolCalls(searchText);
    }

    // Only emit text if there are no tool calls (avoids leaking reasoning into the chat)
    if (toolCalls.length === 0 && msg.content) {
      content.push({ type: "text", text: msg.content });
    }

    for (const tc of toolCalls) {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(tc.function.arguments) as Record<string, unknown>;
      } catch {
        /* malformed */
      }
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input,
      });
    }

    const stopReason = toolCalls.length > 0 ? "tool_use" : "end_turn";
    const reasoning = reasoningText?.trim() || undefined;
    return { content, stopReason, reasoning };
  }

  private convertMessages(messages: Message[]): OAIMessage[] {
    const result: OAIMessage[] = [];

    for (const msg of messages) {
      if (typeof msg.content === "string") {
        result.push({ role: msg.role, content: msg.content });
        continue;
      }

      const blocks = msg.content;

      // Handle tool results (role: tool)
      const toolResults = blocks.filter((b) => b.type === "tool_result");
      for (const tr of toolResults) {
        if (tr.type === "tool_result") {
          const trContent = tr.content;
          if (Array.isArray(trContent)) {
            const textPart = trContent.find((b) => b.type === "text") as { type: "text"; text: string } | undefined;
            result.push({
              role: "tool",
              content: textPart?.text ?? "",
              tool_call_id: tr.tool_use_id,
            });
          } else {
            result.push({
              role: "tool",
              content: trContent,
              tool_call_id: tr.tool_use_id,
            });
          }
        }
      }

      const nonResults = blocks.filter((b) => b.type !== "tool_result");
      if (nonResults.length === 0) continue;

      // Separate block types
      const textBlocks = nonResults.filter(
        (b): b is { type: "text"; text: string } => b.type === "text",
      );
      const imageBlocks = nonResults.filter(
        (b): b is ImageBlock => b.type === "image",
      );
      const docBlocks = nonResults.filter(
        (b): b is DocumentBlock => b.type === "document",
      );
      const toolCallBlocks = nonResults
        .filter(
          (
            b,
          ): b is {
            type: "tool_use";
            id: string;
            name: string;
            input: Record<string, unknown>;
          } => b.type === "tool_use",
        )
        .map((b) => ({
          id: b.id,
          type: "function" as const,
          function: { name: b.name, arguments: JSON.stringify(b.input) },
        }));

      // If this message has images or docs, build a multimodal content array
      const hasMedia = imageBlocks.length > 0 || docBlocks.length > 0;
      if (hasMedia && msg.role === "user") {
        const parts: OAIContentPart[] = [];

        // Add image blocks as image_url parts
        for (const img of imageBlocks) {
          parts.push({
            type: "image_url",
            image_url: {
              url: `data:${img.source.media_type};base64,${img.source.data}`,
              detail: "auto",
            },
          });
        }

        // docBlocks are already converted to text by preprocessMessages; nothing to do here

        // Add text blocks
        for (const tb of textBlocks) {
          parts.push({ type: "text", text: tb.text });
        }

        const oaiMsg: OAIMessage = { role: msg.role, content: parts };
        if (toolCallBlocks.length > 0) oaiMsg.tool_calls = toolCallBlocks;
        result.push(oaiMsg);
        continue;
      }

      // Plain text message (no media)
      const textContent = textBlocks.map((b) => b.text).join("");
      const oaiMsg: OAIMessage = {
        role: msg.role,
        content: textContent || null,
      };
      if (toolCallBlocks.length > 0) oaiMsg.tool_calls = toolCallBlocks;
      result.push(oaiMsg);
    }

    return result;
  }
}
