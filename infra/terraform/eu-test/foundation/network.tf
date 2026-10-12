# TEST network: free to keep (no NAT gateway, no endpoint charges). Same shape as Production: tasks
# and the load balancer in public subnets with public IPv4 (only while a session runs), the
# database in isolated subnets with no route out, and one security group per tier. Only the ALB
# group admits the internet.

resource "aws_vpc" "main" {
  cidr_block           = "10.130.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = local.prefix }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = local.prefix }
}

resource "aws_subnet" "public" {
  for_each = { for i, az in local.azs : az => i }

  vpc_id                  = aws_vpc.main.id
  availability_zone       = each.key
  cidr_block              = cidrsubnet(aws_vpc.main.cidr_block, 8, each.value)
  map_public_ip_on_launch = false

  tags = { Name = "${local.prefix}-public-${each.key}", Tier = "public" }
}

resource "aws_subnet" "db" {
  for_each = { for i, az in local.azs : az => i }

  vpc_id            = aws_vpc.main.id
  availability_zone = each.key
  cidr_block        = cidrsubnet(aws_vpc.main.cidr_block, 8, 10 + each.value)

  tags = { Name = "${local.prefix}-db-${each.key}", Tier = "db" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = { Name = "${local.prefix}-public" }
}

resource "aws_route_table" "db" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${local.prefix}-db" }
}

resource "aws_route_table_association" "public" {
  for_each       = aws_subnet.public
  subnet_id      = each.value.id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "db" {
  for_each       = aws_subnet.db
  subnet_id      = each.value.id
  route_table_id = aws_route_table.db.id
}

# S3 through the gateway endpoint (free): document traffic never leaves the AWS network.
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.public.id]

  tags = { Name = "${local.prefix}-s3" }
}

resource "aws_db_subnet_group" "main" {
  name        = "${local.prefix}-db"
  description = "TEST database subnets (isolated, no route out)"
  subnet_ids  = [for s in aws_subnet.db : s.id]
}

# --- Security groups --------------------------------------------------------------------------

resource "aws_security_group" "tier" {
  for_each = toset(["alb", "web", "api", "scanner", "ops", "db"])

  name        = "${local.prefix}-${each.key}"
  description = "TEST ${each.key} tier"
  vpc_id      = aws_vpc.main.id

  tags = { Name = "${local.prefix}-${each.key}" }
}

locals {
  sg = { for k, v in aws_security_group.tier : k => v.id }

  # from → to : port. Every inbound rule names its source group; only the ALB is open to the world.
  internal_rules = {
    "alb-web"     = { from = "alb", to = "web", port = 3000 }
    "alb-api"     = { from = "alb", to = "api", port = 3001 }
    "web-api"     = { from = "web", to = "api", port = 3001 }
    "api-scanner" = { from = "api", to = "scanner", port = 1344 }
    "api-db"      = { from = "api", to = "db", port = 5432 }
    "ops-db"      = { from = "ops", to = "db", port = 5432 }
  }
}

resource "aws_vpc_security_group_ingress_rule" "alb_public" {
  for_each = toset(["80", "443"])

  security_group_id = local.sg["alb"]
  description       = "Internet to the TEST load balancer"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = tonumber(each.key)
  to_port           = tonumber(each.key)
}

resource "aws_vpc_security_group_ingress_rule" "internal" {
  for_each = local.internal_rules

  security_group_id            = local.sg[each.value.to]
  referenced_security_group_id = local.sg[each.value.from]
  description                  = "${each.value.from} to ${each.value.to}"
  ip_protocol                  = "tcp"
  from_port                    = each.value.port
  to_port                      = each.value.port
}

resource "aws_vpc_security_group_egress_rule" "internal" {
  for_each = local.internal_rules

  security_group_id            = local.sg[each.value.from]
  referenced_security_group_id = local.sg[each.value.to]
  description                  = "${each.value.from} to ${each.value.to}"
  ip_protocol                  = "tcp"
  from_port                    = each.value.port
  to_port                      = each.value.port
}

# HTTPS out for image pulls (GHCR), AWS endpoints, signature updates. The database has no egress.
resource "aws_vpc_security_group_egress_rule" "https_out" {
  for_each = toset(["web", "api", "scanner", "ops"])

  security_group_id = local.sg[each.key]
  description       = "HTTPS out"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

# Cloud Map (Route 53 Resolver) for api.test.munaxa-docs.internal and scanner.…
resource "aws_vpc_security_group_egress_rule" "dns" {
  for_each = { for pair in setproduct(["web", "api", "scanner", "ops"], ["udp", "tcp"]) : "${pair[0]}-${pair[1]}" => pair }

  security_group_id = local.sg[each.value[0]]
  description       = "VPC resolver"
  cidr_ipv4         = "${cidrhost(aws_vpc.main.cidr_block, 2)}/32"
  ip_protocol       = each.value[1]
  from_port         = 53
  to_port           = 53
}
