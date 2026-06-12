# agent-orchestrator

Local orchestrator for software-development tasks driven by short-lived AI agents (architect → developer →
reviewer → integrator), hosted in **NestJS**. **DBOS** owns durable progress — execution is crash-safe and resumes
from the first unfinished step — while **Revisium** owns meaning: roles, policy, inbox, events. Workflow-as-data is
a post-MVP goal; see [`docs/architecture-overview.md`](./docs/architecture-overview.md).

> 🚧 **Early alpha.** The end-to-end MVP works — `run create` → plan gate → implement → review → PR → merge
> gate — see [`docs/roadmap.md`](./docs/roadmap.md).

## Start here

- Repo context for agents: [`AGENTS.md`](./AGENTS.md)
- Vision: [`docs/vision.md`](./docs/vision.md)
- Architecture & invariants: [`docs/architecture-overview.md`](./docs/architecture-overview.md)
- Docs index & roadmap: [`docs/README.md`](./docs/README.md) · [`docs/roadmap.md`](./docs/roadmap.md)

## License

See [LICENSE](./LICENSE).
