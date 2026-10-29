import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as core from '@actions/core'
import { AGENT_URL, run } from './tunnel.js'

const execFileAsync = promisify(execFile)

run({
  agentUrl: AGENT_URL,
  idToken: (audience) => core.getIDToken(audience),
  // -n: a runner that would ask for a password fails the command at once instead of waiting.
  privileged: async (command, args) => {
    await execFileAsync('sudo', ['-n', command, ...args])
  },
}).catch((failure: unknown) =>
  core.setFailed(failure instanceof Error ? failure.message : String(failure))
)
