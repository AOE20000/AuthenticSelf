declare module '@earendil-works/pi-ai' {
  export const Type: {
    Object(properties: Record<string, unknown>, options?: Record<string, unknown>): unknown
    String(options?: Record<string, unknown>): unknown
    Optional(schema: unknown): unknown
  }
}

declare module '@earendil-works/pi-coding-agent' {
  export interface ExtensionContext {
    getContextUsage?: () => { tokens?: number; contextWindow: number; percent?: number } | undefined
    signal?: AbortSignal
    model?: { contextWindow?: number }
    ui?: { notify?: (message: string, level?: string) => void }
    sessionManager?: { getSessionFile?: () => string | undefined }
    compact: (options: {
      customInstructions?: string
      onComplete: () => void
      onError: (error: unknown) => void
    }) => void
  }

  export interface ExtensionAPI {
    on(event: string, handler: (event: Record<string, any>, ctx: ExtensionContext) => Promise<unknown> | unknown): void
    registerCommand(name: string, spec: {
      description: string
      handler: (args: string, ctx: ExtensionContext) => Promise<void> | void
    }): void
    registerTool(spec: {
      name: string
      label: string
      description: string
      promptSnippet?: string
      parameters: unknown
      execute: (toolCallId: string, params: any) => Promise<{ content: { type: 'text'; text: string }[]; details: Record<string, unknown> }>
    }): void
  }
}
