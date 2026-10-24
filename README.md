# Piston tunnel

Lets a job on a Piston runner reach services inside your network: a database
to migrate, an internal API to call, a service behind your VPN. You run one
small connector in your cluster, write routing rules in the Piston console
that say which jobs may connect and what each of them may reach, and a job
adds one step. The job is authorized by the identity GitHub gives it for that
run, so there is no VPN for you to operate and no long-lived secret for the
job to hold.

This repository holds the action, `getpiston/tunnel`, and the connector's
image and Helm chart.

## How it fits together

- **A network connector** is created in the Piston console. It has an id, a
  key, routing rules, and the instances that serve it.
- **The connector** runs in your cluster with that id and private key, and
  connects out to Piston. It opens no inbound port.
- **The step** `getpiston/tunnel@v1` opens a tunnel from the job to the
  connector. From then on the job reaches what the routing rules grant, by
  name or by address.

## 1. Create the network connector

In the console, under Runners, open Network connectors and create one. Leave
**Public key** empty and the console makes the key in your browser and shows the
private key once, with install lines that carry it. Or make the key yourself
first and paste its public half:

```sh
kubectl create namespace piston-connector
umask 077
wg genkey > connector.key
wg pubkey < connector.key   # paste this into "Public key"
kubectl -n piston-connector create secret generic piston-connector --from-file=privateKey=connector.key
rm connector.key
```

Piston keeps only the public key.

## 2. Install the connector

### With Helm

```sh
helm install piston-connector oci://ghcr.io/getpiston/charts/piston-connector \
  --version <version> --namespace piston-connector \
  --set connectorId=<connector id> --set existingSecret=piston-connector
```

Or pass the key as `--set privateKey=…` and the chart writes the Secret
itself. Local settings go in a values file when yours differ:

```yaml
existingSecret: piston-connector
dns:
  nameservers: [10.20.0.2]  # the resolvers that know your internal names; default the pod's own
```

### With `docker run`

```sh
docker run -d --name piston-connector --restart unless-stopped \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  -e PISTON_CONNECTOR_ID='<connector id>' \
  -e PISTON_PRIVATE_KEY='<the connector private key>' \
  ghcr.io/getpiston/piston-connector:<version>
```

### Settings

| Value | Environment | Default | What it is |
|---|---|---|---|
| `connectorId` | `PISTON_CONNECTOR_ID` | | The connector's id, as the console's install lines carry it. Required |
| `privateKey` | `PISTON_PRIVATE_KEY` | | The connector's private key. Set this or `existingSecret` |
| `existingSecret` | | | A Secret in the release's namespace holding the private key under the key `privateKey` |
| `dns.nameservers` | `PISTON_DNS_NAMESERVERS` | the pod's own | The resolvers the connector asks for the names jobs look up, `address` or `address:port`, comma separated in the environment |
| `replicas` | | `2` | Each replica serves the connector on its own; the console lists them under Instances. Run two or more, so a restart never leaves the tunnel without one |
| `tunnelRange` | `PISTON_TUNNEL_RANGE` | `100.127.0.0/16` | The address range the tunnel uses inside jobs; change it only if it overlaps a network a job must reach. IPv4, wider than a /20 |
| `logLevel` | `PISTON_LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`; see [Logs](#logs) |
| `resources` | | 100m CPU and 64 MiB requested, 1 GiB limit | |
| `image.repository`, `image.tag`, `image.pullPolicy` | | `ghcr.io/getpiston/piston-connector`, the chart's version | |
| `nodeSelector`, `tolerations`, `affinity`, `podAnnotations` | | empty | The ordinary pod knobs |

The connector reads its settings once, at start, and reports every mistake
in them at once.

### What the connector needs from your network

- Outbound HTTPS to Piston, and outbound UDP to Piston's runners. No inbound
  port, no volume, no capability.
- Reachability to what your routing rules grant. What the connector's pod
  can reach is the outer bound of what any job can reach, and your own
  egress policy may narrow it.
- A job's connection stays with the connector replica that holds it. A
  replica that stops ends those jobs' connections; new jobs go to the
  replicas still running.

## 3. Write the routing rules

A network connector's routing rules are written on its page in the console, each as
**Job conditions**, which jobs the rule admits, above **Resources**, what
those jobs get. A job is admitted when any rule's job conditions match it,
and it reaches the resources of every rule that matches it, together. Rules
only add: there is no deny, and a connector with no rules admits no job.

Job conditions are lists of patterns, exact or `*` glob, case-insensitive. An
empty list means any, and a rule sets at least one. A rule matches a job when
every list it sets matches:

| Job condition | Matches | What it protects |
|---|---|---|
| Repositories | the repository, as `owner/repo`; `*` is every repository | trusts everyone who can run a workflow there |
| Environments | the job's environment | a job without one matches only a rule that sets no environments; inherits the environment's required reviewers |
| Branches | the branch the job runs for | tags and pull-request merge refs never match a rule that sets branches; as strong as the branch's protection |

Environment names are shared across repositories, so a rule that sets
environments alone admits those names in every repository. A workflow that
runs on `pull_request_target` or `workflow_dispatch` runs as the base branch,
so a branch rule admits it too; grant such workflows nothing they should not
have.

Resources are three lists, and a rule sets at least one:

| Resource | What a matched job gets |
|---|---|
| Networks | IPv4 networks in CIDR form, reached by address |
| Route by hostname | names the job reaches by name, an exact name or `*.x` for `x` and every name under it, resolved by the connector in your network |
| DNS domains | names resolved through the connector as your resolvers answer them, with every name under them; reachable only inside the job's networks; `.` is every lookup |

A pod network in a rule exposes every pod in it. `0.0.0.0/0` exposes
everything the connector's pod can reach: the internet through your egress,
the cloud metadata service and with it the node's cloud credentials unless
your cluster blocks it, the Kubernetes API, and the nodes. Grant the
narrowest resources a job needs.

TCP and UDP work through the tunnel; `ping` does not.

## 4. Add the step to the job

```yaml
jobs:
  migrate:
    runs-on: piston-4cpu-ubuntu-2402
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: getpiston/tunnel@v1
        with:
          connector: prod-vpc
      - run: psql "postgres://app@postgres.db.svc.cluster.local/app" -c 'select 1'
```

| Input | Default | Is |
|---|---|---|
| `connector` | none | the network connector's name, as the console shows it; may be left out when exactly one connector admits the job |
| `timeout` | `30` | how many seconds the tunnel may take to come up |

| Output | Is |
|---|---|
| `connector` | the name of the network connector the job is connected to |
| `matched_rules` | the routing rules that admitted the job, comma separated, each as the console numbers it with its name when it has one |

The job needs `permissions: id-token: write`; without it the step fails at
once and says so. The step ends when the tunnel is up, and fails with the
reason when it is not: the job is admitted by no rule, no instance of the
connector is online, or the connector could not be reached in time.

The step runs on the runner itself, so a job with `container:` needs nothing
in its image for it. The tunnel works the same in the container, in
`docker run` steps and in service containers.

## Logs

The connector writes one JSON object per line to standard output, for
whatever collects your cluster's logs. The lines at `info`, the default, are
an audit log of what every job did through the tunnel, each with an `event`
from a fixed vocabulary and the job's repository, environment, run, attempt,
actor and branch:

| `event` | Written when |
|---|---|
| `connector_started`, `connector_stopped` | the connector starts, or exits on an error |
| `control_connected`, `control_closed` | its connection to Piston comes up or drops; it redials on its own |
| `control_unauthorized` | Piston no longer accepts this connector: it was deleted in the console, or recreated with another key; every job's tunnel on it ends |
| `tunnels_replayed` | after a reconnect, Piston has resent the tunnels this connector serves |
| `tunnel_opened`, `tunnel_established`, `tunnel_closed` | a job is assigned to this connector, its connection comes up, and it ends, with `reason` |
| `tunnel_reach_changed` | a routing-rule edit reaches a running job |
| `connection_opened`, `connection_closed` | a connection from the job to a destination, with `protocol`, `source`, `destination` and `dialed`; the closing line adds `duration_ms` and the bytes each way |
| `connection_denied`, `connection_failed` | a connection the rules do not grant, or one the destination did not answer |
| `lookup_allowed`, `lookup_forwarded`, `lookup_denied`, `lookup_failed` | a name the job looked up: granted by a rule, passed to your resolvers unchanged, refused, or unanswered |

At `debug` the connector adds detail for troubleshooting with Piston support.

## Metrics

Served on port 9090 at `/metrics`, with the `prometheus.io/*` annotations on
the pod: `piston_connector_control_connected`,
`piston_connector_tunnels_open`, `piston_connector_tunnels_up`,
`piston_connector_flows_total{protocol, verdict}` and
`piston_connector_dns_answers_total{kind}`.

## Rotating the key

Rotation is a new key and a redeploy. A network connector's key is pinned
when it is created, so a new key comes with a new connector in the console:
make the key, create the connector with it, deploy it with its id and the new
private key, and once nothing uses the old one, uninstall it and then delete
it in the console. A lost private key is replaced the same way.

## Images

Use the plain `<version>` tag of `ghcr.io/getpiston/piston-connector`. Each
release also publishes a `<version>-staging` tag, which exists for Piston's
own verification.

## Help

Open an issue in this repository.
