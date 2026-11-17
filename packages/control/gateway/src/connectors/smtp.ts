import { createTransport } from 'nodemailer'
import type { Connector } from '../registry.ts'

/** The one call this connector makes; nodemailer's transport satisfies it. */
export interface MailTransport { sendMail(mail: { from: string; to: string; subject: string; text: string }): Promise<{ messageId?: string }> }

export interface SmtpOptions {
  /** The sender, for example `Sam <sam@example.com>`. Fixed here; an agent cannot change it. */
  from: string
  host?: string
  /** Default 587 (STARTTLS); 465 uses TLS from the start. */
  port?: number
  user?: string
  pass?: string
  /** Replace the SMTP transport, for tests. */
  transport?: MailTransport
}

// One address, no display name, no line breaks: nothing an agent passes can add recipients or headers.
const ADDRESS = '^[^\\s@,;<>"]+@[^\\s@,;<>"]+\\.[^\\s@,;<>"]+$'

/** Real email over SMTP. One plain-text message to one recipient per call, always held for approval. */
export function smtpConnector(options: SmtpOptions): Connector {
  const transport: MailTransport = options.transport ?? createTransport({
    host: options.host, port: options.port ?? 587, secure: (options.port ?? 587) === 465,
    ...(options.user ? { auth: { user: options.user, pass: options.pass ?? '' } } : {}),
  })
  return {
    name: 'email',
    tools: [{
      name: 'email.send',
      description: 'Send one plain-text email to one recipient. It is held until a person approves it.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', pattern: ADDRESS, maxLength: 254 },
          subject: { type: 'string', minLength: 1, maxLength: 200, pattern: '^[^\\r\\n]*$' },
          body: { type: 'string', minLength: 1, maxLength: 20000 },
        },
        required: ['to', 'subject', 'body'],
        additionalProperties: false,
      },
      tier: 'send',
      async run(input) {
        const to = String(input.to)
        const result = await transport.sendMail({ from: options.from, to, subject: String(input.subject), text: String(input.body) })
        return { messageId: result.messageId ?? null, to }
      },
    }],
  }
}
