// The step: one call to the agent on the runner, which answers once the tunnel is up or has failed.
import * as core from '@actions/core'

/** The agent on every Piston runner, reached from the job and from its containers alike. */
export const AGENT_URL = 'http://172.17.0.1:7843/tunnel'

/** The agent's answer to a read and to an ask: the tunnel's state and the audience the token is for. */
interface Status {
  state: 'none' | 'connecting' | 'connected' | 'failed'
  connector?: string
  reason?: string
  /** The routing rules that admitted the job, as the console names them. */
  matched_rules?: string[]
  audience: string
}

/** The agent's refusal, in the same shape as every error of Piston's. */
interface Refusal {
  error: string
  message: string
}

/** What the step needs from its surroundings, so a test can stand in for each. */
export interface Surroundings {
  agentUrl: string
  /** GitHub's OIDC token for the audience, as the toolkit mints it. */
  idToken: (audience: string) => Promise<string>
}

export async function run(surroundings: Surroundings): Promise<void> {
  const connector = core.getInput('connector')
  const timeoutInput = core.getInput('timeout')
  const timeoutSeconds = Number(timeoutInput)
  if (!/^\d+$/.test(timeoutInput) || timeoutSeconds < 1 || timeoutSeconds > 65535) {
    core.setFailed(`timeout is a whole number of seconds from 1 to 65535, not '${timeoutInput}'`)
    return
  }

  let status: Status
  try {
    status = await read(surroundings.agentUrl)
  } catch (failure) {
    core.setFailed(
      `the Piston agent did not answer, is this job on a Piston runner? ${describe(failure)}`
    )
    return
  }

  let token: string
  try {
    token = await surroundings.idToken(status.audience)
  } catch (failure) {
    core.setFailed(
      `this job cannot ask GitHub for an OIDC token; give it permissions: id-token: write. ${describe(failure)}`
    )
    return
  }
  core.setSecret(token)

  // The token travels in the body and nowhere else; the agent's own timeout ends the wait, five seconds more are its answer's.
  let response: Response
  try {
    response = await fetch(surroundings.agentUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token,
        timeout_seconds: timeoutSeconds,
        ...(connector ? { connector } : {}),
      }),
      signal: AbortSignal.timeout((timeoutSeconds + 10) * 1000),
    })
  } catch (failure) {
    core.setFailed(`the Piston agent did not answer the ask. ${describe(failure)}`)
    return
  }
  if (!response.ok) {
    const refusal = (await response.json()) as Refusal
    core.setFailed(refusal.message)
    return
  }
  const answer = (await response.json()) as Status
  if (answer.state === 'connected') {
    const rules = answer.matched_rules ?? []
    core.setOutput('connector', answer.connector ?? '')
    core.setOutput('matched_rules', rules.join(', '))
    core.info(
      `Piston tunnel${answer.connector ? ` to ${answer.connector}` : ''} connected${
        rules.length ? `, admitted by ${rules.join(', ')}` : ''
      }`
    )
    return
  }
  core.setFailed(answer.reason ?? `the tunnel is ${answer.state}`)
}

async function read(agentUrl: string): Promise<Status> {
  const response = await fetch(agentUrl, { signal: AbortSignal.timeout(5000) })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }
  return (await response.json()) as Status
}

function describe(failure: unknown): string {
  return failure instanceof Error ? `(${failure.message})` : ''
}
