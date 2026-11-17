import { dirname } from 'node:path'
import type { Template } from '@helmgear/template'

/**
 * The profile patch that turns the generic `agent` profile into one template's
 * agent: its persona, its skills, and the gateway as its only source of tools.
 * A patch replaces a row's whole config, so the rows restate the fields the
 * agent profile sets. The gateway token is read from the environment by the
 * harness at boot; it is never part of this text. The token alone tells the
 * gateway which tenant, session and connectors this process is.
 * `memory` is text a person approved; it is appended to the persona.
 */
export function templatePatch(template: Template, gateway: { url: string }, memory?: string): string {
  // A JSON string is a valid YAML double-quoted scalar, so every value is quoted that way.
  const q = (value: string): string => JSON.stringify(value)
  const persona = memory
    ? `${template.persona}\n\nWhat you know about this business (approved by a person; use it, do not repeat it back):\n${memory}`
    : template.persona
  return `- id: system-prompt
  config:
    includeHarnessIdentity: false
    includeRuntimeContext: false
    personaPrefix: ${q(persona)}

- id: skill-filesystem
  config:
    includeDefaultRoots: false
    customSkillDirs: [${q(dirname(template.dir))}]

- insert:
    - id: mcp-gateway
      name: '@helmgear/mcp-client'
      config:
        serverName: gateway
        transport: streamable-http
        url: ${q(gateway.url)}
        failOnStartupError: true
        toolCallTimeoutMs: 60000
        headers:
          Authorization: !!js '\`Bearer \${process.env.HELMGEAR_GATEWAY_TOKEN}\`'
`
}
