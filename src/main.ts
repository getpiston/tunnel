import * as core from '@actions/core'
import { AGENT_URL, run } from './tunnel.js'

void run({ agentUrl: AGENT_URL, idToken: (audience) => core.getIDToken(audience) })
