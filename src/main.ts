import * as core from '@actions/core'
import { AGENT_URL, run } from './tunnel.js'

run({ agentUrl: AGENT_URL, idToken: (audience) => core.getIDToken(audience) }).catch(
  (failure: unknown) => core.setFailed(failure instanceof Error ? failure.message : String(failure))
)
