import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import * as core from '@actions/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { run } from './tunnel.js'

// The toolkit's reporting is replaced; its input reading, from the INPUT_* environment, is kept.
vi.mock('@actions/core', async (importOriginal) => ({
  ...(await importOriginal<typeof core>()),
  setFailed: vi.fn(),
  setOutput: vi.fn(),
  info: vi.fn(),
}))

/** A stand-in agent: answers the read with the audience, and the ask with whatever the test scripted. */
function agent(
  ask: { status: number; body: unknown } | 'hang',
  audience = 'https://api.runners.eu.test.piston.sh'
): Promise<{ url: string; asks: unknown[]; close: () => void }> {
  const asks: unknown[] = []
  const server = http.createServer((request, response) => {
    if (request.method === 'GET') {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ state: 'none', audience }))
      return
    }
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      asks.push(JSON.parse(body))
      if (ask === 'hang') {
        return
      }
      response.statusCode = ask.status
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(ask.body))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({
        url: `http://127.0.0.1:${port}/tunnel`,
        asks,
        close: () => server.close(),
      })
    })
  })
}

const idToken = vi.fn(async (audience: string) => `token-for-${audience}`)
const failed = vi.mocked(core.setFailed)
const info = vi.mocked(core.info)

beforeEach(() => {
  process.env.INPUT_CONNECTOR_NAME = 'prod-vpc'
  process.env.INPUT_TIMEOUT = '30'
})

afterEach(() => {
  vi.clearAllMocks()
  delete process.env.INPUT_CONNECTOR_NAME
  delete process.env.INPUT_TIMEOUT
})

describe('the step', () => {
  it('asks the agent with the token for its audience, the name and the timeout, and prints the tunnel once connected', async () => {
    const stub = await agent({
      status: 200,
      body: {
        state: 'connected',
        connector_name: 'prod-vpc',
        matched_rules: ['routing rule 1 (deploys)', 'routing rule 3'],
        audience: 'https://api.runners.eu.test.piston.sh',
      },
    })
    await run({ agentUrl: stub.url, idToken })
    stub.close()

    expect(idToken).toHaveBeenCalledWith('https://api.runners.eu.test.piston.sh')
    expect(stub.asks).toEqual([
      {
        token: 'token-for-https://api.runners.eu.test.piston.sh',
        timeout_seconds: 30,
        connector_name: 'prod-vpc',
      },
    ])
    expect(core.setOutput).toHaveBeenCalledWith(
      'matched_rules',
      'routing rule 1 (deploys), routing rule 3'
    )
    expect(info).toHaveBeenCalledWith(
      'Piston tunnel to prod-vpc connected, admitted by routing rule 1 (deploys), routing rule 3'
    )
    expect(failed).not.toHaveBeenCalled()
  })

  it('fails the step at once without connector_name, and asks the agent nothing', async () => {
    process.env.INPUT_CONNECTOR_NAME = ''
    const stub = await agent({ status: 200, body: {} })
    await run({ agentUrl: stub.url, idToken })
    stub.close()

    expect(failed).toHaveBeenCalledWith(expect.stringContaining('connector_name is required'))
    expect(stub.asks).toEqual([])
  })

  it("fails the step with the agent's reason when the tunnel fails", async () => {
    const stub = await agent({
      status: 200,
      body: {
        state: 'failed',
        connector_name: 'prod-vpc',
        reason: 'no connector online for prod-vpc',
        audience: 'https://api.runners.eu.test.piston.sh',
      },
    })
    await run({ agentUrl: stub.url, idToken })
    stub.close()

    expect(failed).toHaveBeenCalledWith('no connector online for prod-vpc')
  })

  it("fails the step with the agent's message when it refuses the ask", async () => {
    const stub = await agent({
      status: 409,
      body: {
        error: 'another_connector',
        message: 'this VM is already connected to the network connector staging-vpc',
      },
    })
    await run({ agentUrl: stub.url, idToken })
    stub.close()

    expect(failed).toHaveBeenCalledWith(
      'this VM is already connected to the network connector staging-vpc'
    )
  })

  it('fails the step naming the permission when GitHub gives no token, and asks the agent nothing', async () => {
    const stub = await agent({
      status: 200,
      body: { state: 'connected', audience: 'https://api.runners.eu.test.piston.sh' },
    })
    await run({
      agentUrl: stub.url,
      idToken: async () => {
        throw new Error('Unable to get ACTIONS_ID_TOKEN_REQUEST_URL env variable')
      },
    })
    stub.close()

    expect(failed).toHaveBeenCalledWith(expect.stringContaining('permissions: id-token: write'))
    expect(stub.asks).toEqual([])
  })

  it("refuses to mint a token for an audience that is not Piston's, and asks the agent nothing", async () => {
    const stub = await agent({ status: 200, body: {} }, 'https://sts.amazonaws.com')
    await run({ agentUrl: stub.url, idToken })
    stub.close()

    expect(failed).toHaveBeenCalledWith(expect.stringContaining("not Piston's"))
    expect(idToken).not.toHaveBeenCalled()
    expect(stub.asks).toEqual([])
  })

  it('fails the step when no agent answers, as off a Piston runner', async () => {
    await run({ agentUrl: 'http://127.0.0.1:9/tunnel', idToken })

    expect(failed).toHaveBeenCalledWith(expect.stringContaining('is this job on a Piston runner?'))
    expect(idToken).not.toHaveBeenCalled()
  })

  it('refuses a timeout that is not a whole number of seconds before asking anything', async () => {
    process.env.INPUT_TIMEOUT = 'soon'
    await run({ agentUrl: 'http://127.0.0.1:9/tunnel', idToken })

    expect(failed).toHaveBeenCalledWith(
      "timeout is a whole number of seconds from 1 to 290, not 'soon'"
    )
  })
})
