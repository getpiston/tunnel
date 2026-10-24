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
once and says so. The step ends when the tunnel is up, with one line in the
log, `Piston tunnel to prod-vpc connected, admitted by routing rule 1
(deploys)`, and fails with the reason when it is not: the job is admitted by
no routing rule, no instance of the connector is online, or the connector
could not be reached in time. From then on, until the job ends, it reaches
what its routing rules grant, by name or by address.

## Where it works

The step runs on the runner itself, so a job with `container:` needs nothing
in its image for it. The tunnel works the same in the container, in
`docker run` steps and in service containers. TCP and UDP work through the
tunnel; `ping` does not.

## Help

Open an issue in this repository.
