// The step: one call to the agent on the runner, which answers once the tunnel is up or has failed.
import * as core from '@actions/core'

/** The agent on every Piston runner, reached from the job and from its containers alike. */
export const AGENT_URL = 'http://172.17.0.1:7843/tunnel'

/** The line under the rules' heading and under each rule the step prints. */
const RULE_SEPARATOR = '-------------'

/**
 * What the step runs last, once the tunnel is up, unless reset_connections is false: every TCP connection the
 * machine has open destroyed, then the connection tracking of its containers' traffic flushed. A connection opened
 * before the tunnel would otherwise go silent on a route the tunnel changed and hang until it timed out; reset, it
 * fails at once and reconnects.
 */
const RESETS: [string, string[]][] = [
  ['ss', ['-K', '-t']],
  ['conntrack', ['-F']],
]

/** The agent's answer to the ask: the tunnel's state. */
type Status =
  | { state: 'connected'; matched_rules: MatchedRule[]; connector_source_ip?: string }
  | { state: 'connecting' | 'failed'; reason?: string }

/** A routing rule that admitted the job, and what it lets the job reach. */
interface MatchedRule {
  name: string
  authorized_resources: { network_cidrs: string[]; hostname_matchers: string[] }
}

/** The agent's refusal, in the same shape as every error of Piston's. */
interface Refusal {
  error: string
  message?: string
}

/** What the step needs from its surroundings, so a test can stand in for each. */
export interface Surroundings {
  agentUrl: string
  /** GitHub's OIDC token for the audience, as the toolkit mints it. */
  idToken: (audience: string) => Promise<string>
  /** Runs a command as root; resolves once it exits 0, rejects otherwise. */
  privileged: (command: string, args: string[]) => Promise<void>
}

export async function run(surroundings: Surroundings): Promise<void> {
  const connectorName = core.getInput('connector_name')
  if (!connectorName) {
    core.setFailed(
      "connector_name is required: the network connector's name, as the console shows it"
    )
    return
  }
  const timeoutInput = core.getInput('timeout')
  const timeoutSeconds = Number(timeoutInput)
  if (!/^\d+$/.test(timeoutInput) || timeoutSeconds < 1 || timeoutSeconds > 290) {
    core.setFailed(`timeout is a whole number of seconds from 1 to 290, not '${timeoutInput}'`)
    return
  }
  const bufferInput = core.getInput('tcp_buffer_max_mib')
  const bufferMebibytes = Number(bufferInput)
  if (!/^\d+$/.test(bufferInput) || bufferMebibytes < 1 || bufferMebibytes > 1024) {
    core.setFailed(
      `tcp_buffer_max_mib is a whole number of MiB from 1 to 1024, not '${bufferInput}'`
    )
    return
  }
  const exitNode = core.getBooleanInput('exit_node')
  const resetConnections = core.getBooleanInput('reset_connections')

  let token: string
  try {
    token = await surroundings.idToken(core.getInput('audience'))
  } catch (failure) {
    core.setFailed(
      `this job cannot ask GitHub for an OIDC token; give it permissions: id-token: write. ${describe(failure)}`
    )
    return
  }

  // The token travels in the body and nowhere else; the agent's own timeout ends the wait, ten seconds more are its answer's.
  let response: Response
  try {
    response = await fetch(surroundings.agentUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token,
        timeout_seconds: timeoutSeconds,
        connector_name: connectorName,
        exit_node: exitNode,
      }),
      signal: AbortSignal.timeout((timeoutSeconds + 10) * 1000),
    })
  } catch (failure) {
    // fetch puts the socket's error in `cause`; the abort at the wait's end is its own error.
    const cause =
      failure instanceof Error && failure.cause instanceof Error ? failure.cause : failure
    const origin = new URL(surroundings.agentUrl).origin
    core.setFailed(
      (cause as NodeJS.ErrnoException).code === 'ECONNREFUSED'
        ? `no Piston agent answered at ${origin}; is this job on a Piston runner?`
        : `the Piston agent at ${origin} did not answer ${describe(cause)}`
    )
    return
  }
  if (!response.ok) {
    const refusal = (await response.json()) as Refusal
    core.setFailed(refusal.message ?? refusal.error)
    return
  }
  const answer = (await response.json()) as Status
  if (answer.state === 'connected') {
    core.setOutput('matched_rules', answer.matched_rules.map((rule) => rule.name).join(', '))
    const lines = [`Piston tunnel to ${connectorName} connected`, '']
    if (exitNode) {
      lines.push(`Job IP (Exit Node Enabled): ${answer.connector_source_ip ?? 'not known yet'}`, '')
    }
    if (answer.matched_rules.length === 0) {
      lines.push('Matched Connector Rules: none')
    } else {
      lines.push('Matched Connector Rules', RULE_SEPARATOR)
    }
    for (const { name, authorized_resources: resources } of answer.matched_rules) {
      lines.push(`Rule name: ${name}`, 'Routes:')
      if (resources.network_cidrs.length) {
        lines.push(`  Network CIDRs: ${resources.network_cidrs.join(', ')}`)
      }
      if (resources.hostname_matchers.length) {
        lines.push(`  Hostname matchers: ${resources.hostname_matchers.join(', ')}`)
      }
      lines.push(RULE_SEPARATOR)
    }
    core.info(lines.join('\n'))
    // A connection through a far connector runs at what it keeps in flight, which the machine's maximums cap; Linux's own minimums and defaults stay.
    const bytes = bufferMebibytes * 1024 * 1024
    core.info(`Raising TCP buffers to ${bufferMebibytes} MiB`)
    try {
      await surroundings.privileged('sysctl', [
        '-w',
        `net.core.rmem_max=${bytes}`,
        `net.core.wmem_max=${bytes}`,
        `net.ipv4.tcp_rmem=4096 131072 ${bytes}`,
        `net.ipv4.tcp_wmem=4096 16384 ${bytes}`,
      ])
    } catch (failure) {
      core.warning(
        `the machine's TCP buffers stay at their defaults, which can slow transfers through a far connector ${describe(failure)}`
      )
    }
    if (resetConnections) {
      core.info('Resetting all running connections!')
      // Best effort: a reset that fails leaves its connections to their own timeouts, never the step failed.
      for (const [command, args] of RESETS) {
        try {
          await surroundings.privileged(command, args)
        } catch (failure) {
          core.warning(
            `${[command, ...args].join(' ')} failed, so some connections opened before this step may hang until they time out ${describe(failure)}`
          )
        }
      }
    }
    return
  }
  core.setFailed(answer.reason ?? `the tunnel is ${answer.state}`)
}

function describe(failure: unknown): string {
  return failure instanceof Error ? `(${failure.message})` : ''
}
