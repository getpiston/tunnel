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
  warning: vi.fn(),
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
const privileged = vi.fn(async (_command: string, _args: string[]) => {})
const failed = vi.mocked(core.setFailed)
const info = vi.mocked(core.info)

beforeEach(() => {
  process.env.INPUT_CONNECTOR_NAME = 'prod-vpc'
  process.env.INPUT_TIMEOUT = '30'
  process.env.INPUT_EXIT_NODE = 'false'
  process.env.INPUT_RESET_CONNECTIONS = 'true'
  process.env.INPUT_TCP_BUFFER_MAX_MIB = '32'
  process.env.INPUT_AUDIENCE = 'https://api.runners.eu.test.piston.sh'
})

afterEach(() => {
  vi.clearAllMocks()
  delete process.env.INPUT_CONNECTOR_NAME
  delete process.env.INPUT_TIMEOUT
  delete process.env.INPUT_EXIT_NODE
  delete process.env.INPUT_RESET_CONNECTIONS
  delete process.env.INPUT_TCP_BUFFER_MAX_MIB
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
    await run({ agentUrl: stub.url, idToken, privileged })
    stub.close()

    expect(idToken).toHaveBeenCalledWith('https://api.runners.eu.test.piston.sh')
    expect(stub.asks).toEqual([
      {
        token: 'token-for-https://api.runners.eu.test.piston.sh',
        timeout_seconds: 30,
        connector_name: 'prod-vpc',
        exit_node: false,
      },
    ])
    expect(core.setOutput).toHaveBeenCalledWith('matched_rules', 'deploys, metrics')
    expect(info).toHaveBeenCalledWith(
      [
        'Piston tunnel to prod-vpc connected',
        '',
        'Matched Connector Rules',
        '-------------',
        'Rule name: deploys',
        'Routes:',
        '  Network CIDRs: 10.20.0.0/16',
        '  Hostname matchers: *.prod.internal, postgres.db.svc.cluster.local',
        '-------------',
        'Rule name: metrics',
        'Routes:',
        '  Hostname matchers: prometheus.monitoring.svc.cluster.local',
        '-------------',
      ].join('\n')
    )
    expect(info).toHaveBeenCalledWith('Raising TCP buffers to 32 MiB')
    expect(info).toHaveBeenLastCalledWith('Resetting all running connections!')
    expect(privileged.mock.calls).toEqual([
      [
        'sysctl',
        [
          '-w',
          'net.core.rmem_max=33554432',
          'net.core.wmem_max=33554432',
          'net.ipv4.tcp_rmem=4096 131072 33554432',
          'net.ipv4.tcp_wmem=4096 16384 33554432',
        ],
      ],
      ['ss', ['-K', '-t']],
      ['conntrack', ['-F']],
    ])
    expect(failed).not.toHaveBeenCalled()
  })

  it('warns and goes on when the buffers cannot be raised, still resetting', async () => {
    const stub = await agent({
      status: 200,
      body: { state: 'connected', connector_name: 'prod-vpc', matched_rules: [] },
    })
    privileged.mockRejectedValueOnce(new Error('sudo: a password is required'))
    await run({ agentUrl: stub.url, idToken, privileged })
    stub.close()

    expect(core.warning).toHaveBeenCalledWith(
      "the machine's TCP buffers stay at their defaults, which can slow transfers through a far connector (sudo: a password is required)"
    )
    expect(privileged).toHaveBeenLastCalledWith('conntrack', ['-F'])
    expect(failed).not.toHaveBeenCalled()
  })

  it('warns and goes on when a reset fails, without failing the step', async () => {
    const stub = await agent({
      status: 200,
      body: { state: 'connected', connector_name: 'prod-vpc', matched_rules: [] },
    })
    privileged
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error('sudo: ss: command not found'))
    await run({ agentUrl: stub.url, idToken, privileged })
    stub.close()

    expect(core.warning).toHaveBeenCalledWith(
      'ss -K -t failed, so some connections opened before this step may hang until they time out (sudo: ss: command not found)'
    )
    expect(privileged).toHaveBeenLastCalledWith('conntrack', ['-F'])
    expect(failed).not.toHaveBeenCalled()
  })

  it("leaves the machine's connections alone when reset_connections is false", async () => {
    process.env.INPUT_RESET_CONNECTIONS = 'false'
    const stub = await agent({
      status: 200,
      body: { state: 'connected', connector_name: 'prod-vpc', matched_rules: [] },
    })
    await run({ agentUrl: stub.url, idToken, privileged })
    stub.close()

    expect(privileged.mock.calls.map(([command]) => command)).toEqual(['sysctl'])
    expect(info).not.toHaveBeenCalledWith('Resetting all running connections!')
    expect(failed).not.toHaveBeenCalled()
  })

  it.each([
    {
      name: 'with the address its traffic leaves from',
      answer: { connector_source_ip: '198.51.100.23' },
      line: 'Job IP (Exit Node Enabled): 198.51.100.23',
    },
    {
      name: 'without one',
      answer: {},
      line: 'Job IP (Exit Node Enabled): not known yet',
    },
  ])(
    'asks for the exit node and prints where the traffic leaves, $name',
    async ({ answer, line }) => {
      process.env.INPUT_EXIT_NODE = 'true'
      const stub = await agent({
        status: 200,
        body: { state: 'connected', connector_name: 'prod-vpc', matched_rules: [], ...answer },
      })
      await run({ agentUrl: stub.url, idToken, privileged })
      stub.close()

      expect(stub.asks).toEqual([expect.objectContaining({ exit_node: true })])
      expect(info).toHaveBeenCalledWith(
        ['Piston tunnel to prod-vpc connected', '', line, '', 'Matched Connector Rules: none'].join(
          '\n'
        )
      )
      expect(failed).not.toHaveBeenCalled()
    }
  )

  it('fails the step at once without connector_name, and asks the agent nothing', async () => {
    process.env.INPUT_CONNECTOR_NAME = ''
    const stub = await agent({ status: 200, body: {} })
    await run({ agentUrl: stub.url, idToken, privileged })
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
    await run({ agentUrl: stub.url, idToken, privileged })
    stub.close()

    expect(failed).toHaveBeenCalledWith('no connector online for prod-vpc')
    expect(privileged).not.toHaveBeenCalled()
  })

  it("fails the step with the agent's message when it refuses the ask", async () => {
    const stub = await agent({
      status: 409,
      body: {
        error: 'another_connector',
        message: 'this VM is already connected to the network connector staging-vpc',
      },
    })
    await run({ agentUrl: stub.url, idToken, privileged })
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
      privileged,
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
    await run({ agentUrl: `http://127.0.0.1:${port}/tunnel`, idToken, privileged })

    expect(failed).toHaveBeenCalledWith(
      `no Piston agent answered at http://127.0.0.1:${port}; is this job on a Piston runner?`
    )
  })

  it('fails the step with the cause when the agent drops the ask, as one that crashed mid-wait', async () => {
    const server = http.createServer((request) => request.socket.destroy())
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    await run({ agentUrl: `http://127.0.0.1:${port}/tunnel`, idToken, privileged })
    server.close()

    expect(failed).toHaveBeenCalledWith(
      `the Piston agent at http://127.0.0.1:${port} did not answer (other side closed)`
    )
  })

  it.each([
    {
      input: 'INPUT_TIMEOUT',
      value: 'soon',
      message: "timeout is a whole number of seconds from 1 to 290, not 'soon'",
    },
    {
      input: 'INPUT_TCP_BUFFER_MAX_MIB',
      value: '2048',
      message: "tcp_buffer_max_mib is a whole number of MiB from 1 to 1024, not '2048'",
    },
  ])('refuses $input $value before asking anything', async ({ input, value, message }) => {
    process.env[input] = value
    await run({ agentUrl: 'http://127.0.0.1:9/tunnel', idToken, privileged })

    expect(failed).toHaveBeenCalledWith(message)
    expect(privileged).not.toHaveBeenCalled()
  })
})
