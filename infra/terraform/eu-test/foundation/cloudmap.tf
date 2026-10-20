# Service discovery for TEST sessions: the private namespace test.munaxa-docs.internal and its two
# services (api, scanner). Persistent, so a session never creates or deletes a hosted zone (the TEST
# deployer has no hosted-zone rights at all). A private hosted zone costs USD 0.50 a month; the
# instances ECS registers while a session runs cost a few cents and disappear with it.

resource "aws_service_discovery_private_dns_namespace" "main" {
  name        = "test.munaxa-docs.internal"
  description = "Munaxa Docs Testing service discovery (persistent; sessions register into it)"
  vpc         = aws_vpc.main.id
}

resource "aws_service_discovery_service" "internal" {
  for_each = toset(["api", "scanner"])

  name = each.key

  dns_config {
    namespace_id   = aws_service_discovery_private_dns_namespace.main.id
    routing_policy = "MULTIVALUE"

    dns_records {
      type = "A"
      ttl  = 10
    }
  }
}
