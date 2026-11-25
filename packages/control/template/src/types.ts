export type RiskTier = 'read' | 'draft' | 'send'
export type DataClass = 'public' | 'sensitive'
export type ReasoningEffort = 'off' | 'low' | 'high' | 'max'

/** One agent the application can run: a persona plus the connectors it may use. */
export interface Template {
  /** `[a-z0-9-]{1,48}`, equal to the folder name. */
  name: string
  /** One sentence; this is what the router shows the classifier. */
  description: string
  persona: string
  /** Connector names the gateway may expose to this agent. */
  connectors: string[]
  /**
   * What must really be connected before this agent may run. Each entry is a
   * list of alternatives: one connector of each entry has to offer a tool.
   * Written in the template as `requires: [email, 'x|linkedin|instagram']`.
   */
  requires: string[][]
  dataClass: DataClass
  reasoningEffort: ReasoningEffort
  /** The most tool calls one task may make; the gateway refuses the rest. Default 12. */
  maxToolCalls: number
  /** Absolute folder path. */
  dir: string
}

/** A template file that cannot be loaded; names the file and, when known, the field. */
export class TemplateError extends Error {
  readonly file: string
  readonly field: string | undefined
  constructor(file: string, field: string | undefined, problem: string) {
    super(`${file}: ${field ? `${field}: ` : ''}${problem}`)
    this.name = 'TemplateError'
    this.file = file
    this.field = field
  }
}
