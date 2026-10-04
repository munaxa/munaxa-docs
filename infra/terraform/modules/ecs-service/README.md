# `ecs-service` module

One module for the three Production ECS services (web, API, scanner). This change defines only
its **input contract** (`variables.tf`); the task definition and service resources are added
with the `eu-prod/service` root.

The contract enforces, before anything reaches AWS:

- service names start with `munaxa-docs-eu-prod-`;
- images are pinned by `@sha256:` digest, never a tag;
- execution and task roles are Production roles under `/munaxa-docs/eu-prod/`;
- the capacity provider is `FARGATE` or `FARGATE_SPOT`.
