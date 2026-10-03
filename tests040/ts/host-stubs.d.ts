// Host interfaces for a standalone syntax/behavior test; NOT the installed Pi SDK.
declare module '@sinclair/typebox' { export const Type: {Object(x: unknown): unknown; String(): unknown; Array(x: unknown, options?: unknown): unknown}; }
declare module '@mariozechner/pi-coding-agent' {
 export interface ExtensionAPI {
  registerTool(tool: {name: string; label: string; description: string; parameters: unknown; execute(id: string, params: any, signal?: AbortSignal): Promise<any>}): void;
  on(name: string, callback: (event: any, ctx?: any) => any): void;
  setActiveTools(tools: string[]): void;
 }
}
