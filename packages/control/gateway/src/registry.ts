import type { RiskTier } from '@helmgear/template'

/** Who is calling: set by the application through the gateway headers, never by the model. */
export interface CallContext {
  tenant: string
  sessionId: string
  template: string
  /** Connectors (`outbox`) or single tools (`outbox.draft`) this template may use. Absent means every connector. */
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
  /** True when a person chose that content (a knowledge base). It is still data to the model, but reading it does not mark later held actions. */
  curated?: boolean
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
  /** Tools returning third-party content that this session had used before it asked for this action. */
  untrustedSources?: string[]
}
