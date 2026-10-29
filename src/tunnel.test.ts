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

/** A stand-in agent: answers the ask with whatever the test scripted. */
function agent(ask: {
  status: number
  body: unknown
}): Promise<{ url: string; asks: unknown[]; close: () => void }> {
  const asks: unknown[] = []
  const server = http.createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      asks.push(JSON.parse(body))
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
  process.env.INPUT_INTERNET_EXIT = 'false'
  process.env.INPUT_AUDIENCE = 'https://api.runners.eu.test.piston.sh'
})

afterEach(() => {
  vi.clearAllMocks()
  delete process.env.INPUT_CONNECTOR_NAME
  delete process.env.INPUT_TIMEOUT
  delete process.env.INPUT_INTERNET_EXIT
  delete process.env.INPUT_AUDIENCE
})

describe('the step', () => {
  it('asks the agent with a token for the audience input, the name and the timeout, and prints the tunnel once connected', async () => {
    const stub = await agent({
      status: 200,
      body: {
        state: 'connected',
        connector_name: 'prod-vpc',
        matched_rules: [
          {
            name: 'deploys',
            authorized_resources: {
              network_cidrs: ['10.20.0.0/16'],
              hostname_matchers: ['*.prod.internal', 'postgres.db.svc.cluster.local'],
            },
          },
          {
            name: 'metrics',
            authorized_resources: {
              network_cidrs: [],
              hostname_matchers: ['prometheus.monitoring.svc.cluster.local'],
            },
          },
        ],
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
        internet_exit: false,
      },
    ])
    expect(core.setOutput).toHaveBeenCalledWith('matched_rules', 'deploys, metrics')
    expect(info).toHaveBeenCalledWith(
      [
        'Piston tunnel to prod-vpc connected',
        'deploys',
        '  Network CIDRs: 10.20.0.0/16',
        '  Hostname matchers: *.prod.internal, postgres.db.svc.cluster.local',
        'metrics',
        '  Hostname matchers: prometheus.monitoring.svc.cluster.local',
      ].join('\n')
    )
    expect(failed).not.toHaveBeenCalled()
  })

  it.each([
    {
      name: 'with the address its traffic leaves from',
      answer: { connector_source_ip: '198.51.100.23' },
      line: "This job's public IP is now 198.51.100.23 (internet exit through prod-vpc)",
    },
    {
      name: 'without one',
      answer: {},
      line: "This job's internet traffic now leaves through prod-vpc",
    },
  ])(
    'asks for the internet exit and prints where the traffic leaves, $name',
    async ({ answer, line }) => {
      process.env.INPUT_INTERNET_EXIT = 'true'
      const stub = await agent({
        status: 200,
        body: { state: 'connected', connector_name: 'prod-vpc', matched_rules: [], ...answer },
      })
      await run({ agentUrl: stub.url, idToken })
      stub.close()

      expect(stub.asks).toEqual([expect.objectContaining({ internet_exit: true })])
      expect(info).toHaveBeenCalledWith(['Piston tunnel to prod-vpc connected', line].join('\n'))
      expect(failed).not.toHaveBeenCalled()
    }
  )

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
    const stub = await agent({ status: 200, body: { state: 'connected' } })
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

  it('fails the step when no agent answers, as off a Piston runner', async () => {
    const server = http.createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    await new Promise((resolve) => server.close(resolve))
    await run({ agentUrl: `http://127.0.0.1:${port}/tunnel`, idToken })

    expect(failed).toHaveBeenCalledWith(
      `no Piston agent answered at http://127.0.0.1:${port}; is this job on a Piston runner?`
    )
  })

  it('fails the step with the cause when the agent drops the ask, as one that crashed mid-wait', async () => {
    const server = http.createServer((request) => request.socket.destroy())
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    await run({ agentUrl: `http://127.0.0.1:${port}/tunnel`, idToken })
    server.close()

    expect(failed).toHaveBeenCalledWith(
      `the Piston agent at http://127.0.0.1:${port} did not answer (other side closed)`
    )
  })

  it('refuses a timeout that is not a whole number of seconds before asking anything', async () => {
    process.env.INPUT_TIMEOUT = 'soon'
    await run({ agentUrl: 'http://127.0.0.1:9/tunnel', idToken })

    expect(failed).toHaveBeenCalledWith(
      "timeout is a whole number of seconds from 1 to 290, not 'soon'"
    )
  })
})
