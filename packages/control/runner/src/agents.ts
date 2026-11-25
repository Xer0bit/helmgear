import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** An agent a person set up: a name and the one template it works from. */
export interface NamedAgent {
  name: string
  template: string
  /** ISO 8601 UTC. */
  createdAt: string
  /** What the agent wrote when it studied the business, once a person accepted it. */
  briefing?: string
}

const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/

/**
 * The agents a person has set up, in one JSON file. The template is chosen
 * once, when the agent is created, and never changes: to do a different job,
 * create another agent. Names are unique whatever their capitals.
 */
export class AgentStore {
  constructor(private readonly file: string) {}

  list(): NamedAgent[] {
    return existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) as NamedAgent[] : []
  }

  get(name: string): NamedAgent | undefined {
    return this.list().find(agent => agent.name.toLowerCase() === name.toLowerCase())
  }

  private save(agents: NamedAgent[]): void {
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(`${this.file}.tmp`, JSON.stringify(agents, null, 2), { mode: 0o600 })
    renameSync(`${this.file}.tmp`, this.file)
  }

  /** `templates` are the names that exist; an agent cannot be created on one that does not. */
  add(name: string, template: string, templates: string[]): NamedAgent {
    if (!NAME.test(name)) throw new Error('an agent name starts with a letter and has up to 32 letters, digits, - or _')
    if (!templates.includes(template)) throw new Error(`unknown template: ${template}`)
    if (this.get(name)) throw new Error(`there is already an agent called ${this.get(name)!.name}`)
    const agent: NamedAgent = { name, template, createdAt: new Date().toISOString() }
    this.save([...this.list(), agent])
    return agent
  }

  /** Keep the briefing a person accepted for this agent. */
  setBriefing(name: string, briefing: string): NamedAgent {
    const agents = this.list()
    const agent = agents.find(candidate => candidate.name.toLowerCase() === name.toLowerCase())
    if (!agent) throw new Error(`no agent called ${name}`)
    const text = briefing.trim()
    if (!text) throw new Error('the briefing is empty')
    if (text.length > 3000) throw new Error('the briefing is longer than 3,000 characters')
    agent.briefing = text
    this.save(agents)
    return agent
  }

  remove(name: string): void {
    if (!this.get(name)) throw new Error(`no agent called ${name}`)
    this.save(this.list().filter(agent => agent.name.toLowerCase() !== name.toLowerCase()))
  }
}
