# Piston tunnel

The step that connects a job on a Piston runner to one of your organization's
network connectors, so the job reaches services inside your network: a
database to migrate, an internal API to call, a service behind your VPN. The
job is authorized by the identity GitHub gives it for that run, so there is
no secret for the job to hold.

A network connector is created, installed and given its routing rules in the
Piston console, under Runners. Its routing rules say which jobs it admits, by
repository, environment and branch, and what each admitted job may reach.
This repository is the step alone.

## Adding the step to a job

```yaml
jobs:
  migrate:
    runs-on: piston-4cpu-ubuntu-2402
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: getpiston/tunnel-action@v2
        with:
          connector_name: prod-vpc
      - run: psql "postgres://app@postgres.db.svc.cluster.local/app" -c 'select 1'
```

| Input | Default | Is |
|---|---|---|
| `connector_name` | required | the network connector's name, as the console shows it |
| `timeout` | `30` | how many seconds the tunnel may take to come up, at most 290 |
| `internet_exit` | `false` | `true` sends all of the job's internet traffic out through the connector, whose **Internet exit** must be on; see [Internet exit](#internet-exit) |
| `audience` | `https://api.runners.eu.prod.piston.sh` | the Piston api the job's token is for; set it only on a Piston other than production |

| Output | Is |
|---|---|
| `matched_rules` | the names of the routing rules that admitted the job, comma separated |

The job needs `permissions: id-token: write`; without it the step fails at
once and says so. The step ends when the tunnel is up, logging each routing
rule that admitted the job and what it lets the job reach:

```
Piston tunnel to prod-vpc connected
deploys
  Network CIDRs: 10.20.0.0/16
  Hostname matchers: *.prod.internal, postgres.db.svc.cluster.local
metrics
  Hostname matchers: prometheus.monitoring.svc.cluster.local
```

When the tunnel does not come up, the step fails with the reason; see
[When the step fails](#when-the-step-fails). From then on, until the job ends,
the job reaches what its routing rules grant, by name or by address.

## How it works

1. The step asks the Piston agent on the job's runner for a tunnel to the
   named connector, with the token GitHub gives the job for this run. The
   token says which repository, environment and branch the job runs for.
2. Piston admits the job when one of the connector's routing rules matches it,
   and hands the tunnel to an online instance of the connector.
3. The job and the connector get connected through an encrypted tunnel;
   the step ends once it is up.
4. The job's traffic to what the matched rules grant goes through the
   connector, which checks and logs every connection and lookup. The rest of
   the job's traffic leaves the runner as usual, unless the step asked for the
   connector's internet exit.

## Internet exit

With `internet_exit: true`, every connection the job makes to the internet
goes out through the connector, so the sites and services it calls see your
network's public address. The step prints the address the connector reaches
Piston from, which is that address unless your network sends the connector's
traffic through a proxy or a NAT with several addresses:

```
Piston tunnel to prod-vpc connected
This job's public IP is now 203.0.113.7 (internet exit through prod-vpc)
```

Your private networks stay closed to the job unless a routing rule opens
them. The connector's **Internet exit**, on its Settings tab, must be on, and
then any job of your organization may ask for it, whether or not a routing
rule matches the job. The job's lookups go to public DNS servers, through the
connector like the rest of its internet traffic, so your network must let the
connector reach them on port 53. Turning the internet exit off cuts the
internet traffic of jobs already using it.

## Inside the job

- **Containers.** A job with `container:` needs nothing in its image for the
  step. The tunnel works the same in the container, in `docker run` steps
  and in service containers.
- **Names.** A name a rule's **Hostname matchers** match resolves to an
  address from the connector's tunnel addresses, `100.127.0.0/16` unless they
  were changed, and not to the host's own address: reach it by its name. A
  name under a domain of the connector's nameservers, its **Configure
  Nameservers** settings, resolves to its real address, for every job of the
  connector, and the job reaches it only inside a rule's **Network CIDRs**.
- **What takes the tunnel.** IPv4 TCP and UDP to the granted networks and
  names, and to the internet with the internet exit. `ping` and IPv6 do not, and neither do the runner's own addresses,
  Docker's `172.17.0.0/16` among them, whatever the rules hold.
- **Fixed at the start.** The job keeps the authorized resources its tunnel opened with:
  an edit of the routing rules applies from the next job, so re-run the job
  to try one.
- **One tunnel a job.** The tunnel lasts as long as the job. A repeat of the step with the same connector answers with the same tunnel; a
  step naming another connector fails. When the connector's instance
  restarts, connections open at that moment fail, and new ones work again
  within two minutes.

## When the step fails

The step prints one of these messages. For the connector's side of a failure,
see the connector's
[troubleshooting guide](https://github.com/getpiston/piston-connector#troubleshooting).

| The step says | Why | What to do |
|---|---|---|
| `connector_name is required: …` | The input is missing | Set `connector_name` |
| `timeout is a whole number of seconds from 1 to 290, not '…'` | The input is out of range | A whole number from 1 to 290 |
| `this job cannot ask GitHub for an OIDC token; give it permissions: id-token: write. …` | The job may not ask for its token. A `permissions:` block, on the workflow or the job, grants only what it lists | Add `id-token: write` to it |
| `no Piston agent answered at http://172.17.0.1:7843; is this job on a Piston runner?` | The job runs on a runner that is not Piston's | `runs-on:` a Piston runner label |
| `a GitHub Actions token for this api is required` | The token is for another Piston than the one the runner asks | Leave `audience` unset |
| `the repository's owner has no active installation` | Piston's GitHub App is not installed on the account that owns the repository | Install it on that account |
| `no connector of that name admits the job` | No connector of exactly that name, case included, belongs to the organization that owns the repository, or none of its routing rules match the job and, for a step that asks for it, the connector is no internet exit. Piston does not say which | Check the name in the console, then the rules' **Job matchers**: a job for a tag or a pull request matches no rule that sets Branches, and a job with no `environment:` no rule that sets Environments |
| `the connector is not an internet exit` | The step sets `internet_exit: true`, a routing rule admits the job, and the connector's **Internet exit** is off | Turn it on in the connector's Settings, or drop `internet_exit` |
| `the tunnel to <name> did not come up within <N> s` | No instance of the connector is online, or the job and the connector could not get connected | The connector's **Instances** in the console, then its log, as its troubleshooting guide says. After a restart of the connector, a longer `timeout` waits for an instance |
| `every instance of the connector holds 100 tunnels; more replicas take more` | The connector is full | Run more instances of it |
| `every tunnel address of the connector is in use` | The connector's tunnel addresses are too few for the jobs running at once | Wider **Tunnel addresses**, on the connector's Advanced tab |
| `this VM is already connected to the network connector <name>` | An earlier step of the job opened a tunnel to another connector | One connector a job; give its rules everything the job needs |
| `the tunnel to <name> stopped answering` | A repeat of the step found the tunnel silent for minutes: the connector's instance stopped, and no other took its place | The connector's **Instances** |
| `the connector was deleted` | It was deleted in the console as the job asked | Point `connector_name` at a connector that exists |
| `the api cannot be reached: …`, `the api did not answer within the tunnel's timeout`, `the api answered …`, `the Piston agent at … did not answer …`, `the agent is stopping`, `the tunnel closed: …`, or any other message | A fault on Piston's side | Re-run the job; if it fails again, open an issue here with the run's URL |

## Help

Open an issue in this repository.
