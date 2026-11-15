import type { RiskTier } from '@helmgear/template'

/** Who is calling: set by the application through the gateway headers, never by the model. */
export interface CallContext {
  tenant: string
  sessionId: string
  template: string
  /** Connector names this template may use. Absent means every connector. */
  connectors?: string[]
}

export interface ToolDef {
  /** `<connector>.<action>`, for example `outbox.send`. */
  name: string
  description: string
  /** JSON Schema object for the input. */
  inputSchema: Record<string, unknown>
  tier: RiskTier
  /** True when the result carries third-party content the model must not treat as instructions. */
  untrusted?: boolean
  run(input: Record<string, unknown>, ctx: CallContext): Promise<unknown>
}

export interface Connector { name: string; tools: ToolDef[] }

export type CallResult =
  | { status: 'ok'; result: unknown }
  | { status: 'pending'; actionId: string }
  | { status: 'refused'; reason: string }

/** A `send` action waiting for a person. */
export interface PendingRequest {
  actionId: string
  tool: string
  input: Record<string, unknown>
  payloadSha256: string
  ctx: CallContext
}
