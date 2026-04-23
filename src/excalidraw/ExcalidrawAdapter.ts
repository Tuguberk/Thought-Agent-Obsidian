import { App, TFile } from "obsidian";

export interface ExcalidrawElement {
  id: string;
  type:
    | "rectangle"
    | "ellipse"
    | "diamond"
    | "text"
    | "arrow"
    | "line"
    | "freedraw"
    | "image"
    | "frame";
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  startBinding?: { elementId: string; focus: number; gap: number };
  endBinding?: { elementId: string; focus: number; gap: number };
  boundElements?: { id: string; type: string }[];
  strokeColor?: string;
  backgroundColor?: string;
  fontSize?: number;
  fontFamily?: number;
  textAlign?: string;
  label?: { text: string };
}

export interface ExcalidrawFile {
  type: "excalidraw";
  version: 2;
  elements: ExcalidrawElement[];
  appState?: object;
}

function getExcalidrawAPI(app: App): unknown {
  const plugins = (
    app as unknown as {
      plugins?: { plugins?: Record<string, { ea?: unknown }> };
    }
  ).plugins?.plugins;
  return plugins?.["obsidian-excalidraw-plugin"]?.ea ?? null;
}

export class ExcalidrawAdapter {
  private static readonly TRANSPARENT_PNG_BASE64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAwUBAO9n8L8AAAAASUVORK5CYII=";
  private static readonly MAX_IMAGE_BYTES = 4_500_000;

  constructor(private app: App) {}

  private looksLikeExcalidrawMarkdown(content: string): boolean {
    if (
      /^---[\s\S]*?\nexcalidraw-plugin\s*:\s*(?:parsed|raw|true|1)\b[\s\S]*?---/im.test(
        content,
      )
    ) {
      return true;
    }
    if (/```\s*compressed-json\b/i.test(content)) return true;
    if (/```\s*json\b[\s\S]*?"type"\s*:\s*"excalidraw"/i.test(content))
      return true;
    if (
      /\bexcalidraw-plugin\s*:/i.test(content) &&
      /#\s*Text\s+Elements\b/i.test(content)
    )
      return true;
    return false;
  }

  async isExcalidrawFile(filePath: string): Promise<boolean> {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) return false;
    if (file.extension === "excalidraw") return true;
    if (file.extension !== "md") return false;

    const cache = this.app.metadataCache.getFileCache(file);
    const frontmatter: Record<string, unknown> = cache?.frontmatter ?? {};
    const fm = frontmatter["excalidraw-plugin"];
    const marker = (typeof fm === "string" ? fm : "").toLowerCase().trim();
    if (["parsed", "raw", "true", "1"].includes(marker)) return true;

    const content = await this.app.vault.cachedRead(file);
    return this.looksLikeExcalidrawMarkdown(content);
  }

  get isAvailable(): boolean {
    return getExcalidrawAPI(this.app) !== null;
  }

  async getElementsFromFile(filePath: string): Promise<ExcalidrawElement[]> {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!file || !(file instanceof TFile))
      throw new Error(`File not found: ${filePath}`);
    const content = await this.app.vault.read(file);
    const parsed = JSON.parse(content) as ExcalidrawFile;
    return parsed.elements ?? [];
  }

  async readFile(filePath: string): Promise<ExcalidrawFile> {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!file || !(file instanceof TFile))
      throw new Error(`File not found: ${filePath}`);
    const content = await this.app.vault.read(file);
    return JSON.parse(content) as ExcalidrawFile;
  }

  async writeFile(filePath: string, content: ExcalidrawFile): Promise<void> {
    const json = JSON.stringify(content, null, 2);
    const existing = this.app.vault.getAbstractFileByPath(filePath);
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, json);
    } else {
      const parts = filePath.split("/");
      if (parts.length > 1) {
        const folder = parts.slice(0, -1).join("/");
        try {
          await this.app.vault.createFolder(folder);
        } catch {
          /* exists */
        }
      }
      await this.app.vault.create(filePath, json);
    }
  }

  async addElementsToActiveView(
    elements: ExcalidrawElement[],
  ): Promise<boolean> {
    const api = getExcalidrawAPI(this.app) as {
      addElementsToView?: (
        els: ExcalidrawElement[],
        scroll?: boolean,
        zoom?: boolean,
      ) => Promise<void>;
    } | null;
    if (!api) return false;
    try {
      await api.addElementsToView?.(elements, false, false);
      return true;
    } catch {
      return false;
    }
  }

  private getEA(): {
    reset?: () => void;
    loadFile?: (fileOrPath: TFile | string) => Promise<void>;
    getElements?: () => ExcalidrawElement[];
    createPNG?: (template?: string, scale?: number) => Promise<unknown>;
    targetView?: unknown;
  } | null {
    const plugin = (
      this.app as unknown as {
        plugins?: { plugins?: Record<string, unknown> };
      }
    ).plugins?.plugins?.["obsidian-excalidraw-plugin"] as {
      ea?: unknown;
    } | null;
    return (plugin?.ea as ReturnType<ExcalidrawAdapter["getEA"]>) ?? null;
  }

  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
  }

  private async blobToBase64(blob: Blob): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const result = reader.result;
        resolve(typeof result === "string" ? (result.split(",")[1] ?? "") : "");
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  private normalizeBase64(base64: string): string {
    return base64.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  }

  private byteLengthFromBase64(base64: string): number {
    const normalized = this.normalizeBase64(base64);
    const padding = normalized.endsWith("==")
      ? 2
      : normalized.endsWith("=")
        ? 1
        : 0;
    return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding);
  }

  private isPngBase64(base64: string): boolean {
    try {
      const normalized = this.normalizeBase64(base64);
      let bytes: number[] = [];
      if (typeof atob === "function") {
        const head = atob(normalized.slice(0, 24));
        bytes = Array.from(head, (c) => c.charCodeAt(0));
      } else {
        return false;
      }
      const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
      return sig.every((b, i) => bytes[i] === b);
    } catch {
      return false;
    }
  }

  private validatePngBase64(base64: string | null | undefined): string | null {
    if (!base64) return null;
    const normalized = this.normalizeBase64(base64);
    if (!/^[A-Za-z0-9+/=]+$/.test(normalized)) return null;
    if (
      this.byteLengthFromBase64(normalized) > ExcalidrawAdapter.MAX_IMAGE_BYTES
    ) {
      return null;
    }
    return this.isPngBase64(normalized) ? normalized : null;
  }

  private extractBase64FromDataUrl(dataUrl: string): string | null {
    const match = /^data:image\/png;base64,(.+)$/i.exec(dataUrl.trim());
    if (!match) return null;
    return this.validatePngBase64(match[1]);
  }

  private async toBase64FromPngResult(result: unknown): Promise<string | null> {
    if (!result) return null;

    if (typeof result === "string") {
      if (result.startsWith("data:image/")) {
        return this.extractBase64FromDataUrl(result);
      }
      if (/^[A-Za-z0-9+/=\r\n]+$/.test(result)) {
        return this.validatePngBase64(result);
      }
      return null;
    }

    if (result instanceof Blob) {
      const b64 = await this.blobToBase64(result);
      return this.validatePngBase64(b64);
    }

    if (result instanceof ArrayBuffer) {
      return this.validatePngBase64(this.arrayBufferToBase64(result));
    }

    if (ArrayBuffer.isView(result)) {
      const view = result as Uint8Array;
      const sliced = view.buffer.slice(
        view.byteOffset,
        view.byteOffset + view.byteLength,
      );
      return this.validatePngBase64(this.arrayBufferToBase64(sliced));
    }

    if (Array.isArray(result)) {
      for (const item of result) {
        const b64 = await this.toBase64FromPngResult(item);
        if (b64) return b64;
      }
      return null;
    }

    if (typeof result === "object") {
      const obj = result as Record<string, unknown>;
      if (typeof obj.dataURL === "string") {
        return this.extractBase64FromDataUrl(obj.dataURL);
      }
      if (typeof obj.base64 === "string") {
        return this.validatePngBase64(obj.base64);
      }
      if (obj.blob instanceof Blob) {
        const b64 = await this.blobToBase64(obj.blob);
        return this.validatePngBase64(b64);
      }
      if (obj.file instanceof Blob) {
        const b64 = await this.blobToBase64(obj.file);
        return this.validatePngBase64(b64);
      }
    }

    return null;
  }

  private buildPngCandidatePaths(filePath: string): string[] {
    const withoutExcalidrawMd = filePath.replace(/\.excalidraw\.md$/i, "");
    const withoutMd = filePath.replace(/\.md$/i, "");
    const withoutExcalidraw = filePath.replace(/\.excalidraw$/i, "");
    return Array.from(
      new Set([
        `${withoutExcalidrawMd}.png`,
        `${withoutMd}.png`,
        `${withoutExcalidraw}.png`,
        `${filePath}.png`,
      ]),
    );
  }

  private async readPngFromVault(filePath: string): Promise<string | null> {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) return null;
    if (file.extension.toLowerCase() !== "png") return null;
    try {
      const binary = await this.app.vault.readBinary(file);
      return this.validatePngBase64(this.arrayBufferToBase64(binary));
    } catch {
      return null;
    }
  }

  private async setTargetViewForFile(
    ea: { targetView?: unknown },
    filePath: string,
  ): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType("excalidraw");
    const leaf = leaves.find((l) => {
      const viewFile = (l.view as unknown as { file?: TFile }).file;
      return viewFile?.path === filePath;
    });
    if (leaf) ea.targetView = leaf.view;
  }

  async getDecompressedElements(
    filePath: string,
  ): Promise<ExcalidrawElement[] | null> {
    const ea = this.getEA();
    if (!ea?.reset || !ea?.loadFile || !ea?.getElements) return null;
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) return null;
    try {
      await this.setTargetViewForFile(ea, filePath);
      ea.reset();
      try {
        await ea.loadFile(file);
      } catch {
        await ea.loadFile(file.path);
      }
      return ea.getElements() ?? null;
    } catch {
      return null;
    }
  }

  async exportToPNG(filePath: string): Promise<string | null> {
    const ea = this.getEA();
    if (!ea?.createPNG) return null;

    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) return null;

    const scales = [1, 0.8, 0.5];

    // Strategy 1: use the open Excalidraw view directly (no reset needed, view is already rendered)
    await this.setTargetViewForFile(ea, filePath);
    for (const scale of scales) {
      const png = await this.toBase64FromPngResult(await ea.createPNG(undefined, scale));
      if (png && this.byteLengthFromBase64(png) > 512) return png;

      const png2 = await this.toBase64FromPngResult(await ea.createPNG(file.path, scale));
      if (png2 && this.byteLengthFromBase64(png2) > 512) return png2;
    }

    // Strategy 2: reset + load (for files not open in a view), then re-set targetView
    if (ea.reset && ea.loadFile) {
      try {
        ea.reset();
        try {
          await ea.loadFile(file);
        } catch {
          await ea.loadFile(file.path);
        }
        await this.setTargetViewForFile(ea, filePath);

        for (const scale of scales) {
          const png = await this.toBase64FromPngResult(await ea.createPNG(undefined, scale));
          if (png && this.byteLengthFromBase64(png) > 512) return png;
        }
      } catch {
        // fall through
      }
    }

    // Strategy 3: vault-cached PNG
    for (const candidate of this.buildPngCandidatePaths(filePath)) {
      const png = await this.readPngFromVault(candidate);
      if (png) return png;
    }

    return null;
  }
}
