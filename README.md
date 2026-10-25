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
      - uses: getpiston/tunnel-action@v1
        with:
          connector_name: prod-vpc
      - run: psql "postgres://app@postgres.db.svc.cluster.local/app" -c 'select 1'
```

| Input | Default | Is |
|---|---|---|
| `connector_name` | required | the network connector's name, as the console shows it |
| `timeout` | `30` | how many seconds the tunnel may take to come up, at most 290 |
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
  Networks: 10.20.0.0/16
  Route by hostname: *.prod.internal, postgres.db.svc.cluster.local
  DNS domains: corp.example.com
metrics
  Route by hostname: prometheus.monitoring.svc.cluster.local
```

It fails with the reason when the tunnel is not up: the job is admitted by no
routing rule, no instance of the connector is online, or the connector could
not be reached in time. From then on, until the job ends, the job reaches what
its routing rules grant, by name or by address.

## Where it works

A job with `container:` needs nothing in its image for the step. The tunnel
works the same in the container, in `docker run` steps and in service
containers. TCP and UDP work through the tunnel; `ping` does not. A job holds
one tunnel: a second step naming another connector fails.

## Help

Open an issue in this repository.
