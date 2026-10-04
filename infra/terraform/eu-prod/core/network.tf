# The Production network (ADR-0024 §2.2): one VPC, public subnets for the ALB and the tasks, and
# isolated subnets for the database. No NAT Gateway at launch: tasks run in the public subnets
# with their own public IPv4 address, and every inbound path is closed by security group except
# 80/443 to the ALB.
#
# | Tier             | eu-central-1a     | eu-central-1b     | eu-central-1c     | Route table      |
# | ---------------- | ----------------- | ----------------- | ----------------- | ---------------- |
# | Public           | 10.121.0.0/24     | 10.121.1.0/24     | 10.121.2.0/24 (*) | rt-public (IGW)  |
# | App (future NAT) | 10.121.16.0/20(*) | 10.121.32.0/20(*) | 10.121.48.0/20(*) | —                |
# | DB, isolated     | 10.121.64.0/24    | 10.121.65.0/24    | 10.121.66.0/24    | rt-db (local)    |
#
# (*) reserved, not created. 10.121.128.0/17 is spare. Non-Production uses 10.120.0.0/16 and the
# default VPC 172.31.0.0/16; there is no peering, transit gateway or VPN.
#
# All three DB subnets exist so a point-in-time restore can land in any zone. Auto-assign public
# IP is off everywhere; the service root sets assignPublicIp on each task explicitly.
#
# The VPC's own default security group and main route table are left as AWS creates them and are
# used by nothing: no subnet is associated with the main route table and no resource is placed in
# the default security group.

locals {
  vpc_cidr = "10.121.0.0/16"

  public_subnets = {
    a = { az = "${var.region}a", cidr = "10.121.0.0/24" }
    b = { az = "${var.region}b", cidr = "10.121.1.0/24" }
  }

  db_subnets = {
    a = { az = "${var.region}a", cidr = "10.121.64.0/24" }
    b = { az = "${var.region}b", cidr = "10.121.65.0/24" }
    c = { az = "${var.region}c", cidr = "10.121.66.0/24" }
  }

  anywhere_ipv4 = "0.0.0.0/0"
}

resource "aws_vpc" "main" {
  cidr_block           = local.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = local.prefix }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${local.prefix}-igw" }
}

resource "aws_subnet" "public" {
  for_each = local.public_subnets

  vpc_id                  = aws_vpc.main.id
  availability_zone       = each.value.az
  cidr_block              = each.value.cidr
  map_public_ip_on_launch = false

  tags = { Name = "${local.prefix}-public-${each.key}", Tier = "public" }
}

resource "aws_subnet" "db" {
  for_each = local.db_subnets

  vpc_id                  = aws_vpc.main.id
  availability_zone       = each.value.az
  cidr_block              = each.value.cidr
  map_public_ip_on_launch = false

  tags = { Name = "${local.prefix}-db-${each.key}", Tier = "db" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${local.prefix}-rt-public" }
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = local.anywhere_ipv4
  gateway_id             = aws_internet_gateway.main.id
}

resource "aws_route_table_association" "public" {
  for_each = aws_subnet.public

  subnet_id      = each.value.id
  route_table_id = aws_route_table.public.id
}

# Local routes only: the database subnets have no path to or from the internet.
resource "aws_route_table" "db" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${local.prefix}-rt-db" }
}

resource "aws_route_table_association" "db" {
  for_each = aws_subnet.db

  subnet_id      = each.value.id
  route_table_id = aws_route_table.db.id
}

# S3 gateway endpoint (no charge) on the public route table. Its policy admits only the
# Production document bucket and only the object actions the API task role is granted.
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.public.id]

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "ProductionDocumentBucketOnly"
      Effect    = "Allow"
      Principal = "*"
      Action = [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:AbortMultipartUpload",
        "s3:ListBucket",
      ]
      Resource = [
        "arn:aws:s3:::${local.docs_bucket}",
        "arn:aws:s3:::${local.docs_bucket}/*",
      ]
    }]
  })

  tags = { Name = "${local.prefix}-vpce-s3" }
}

# Security groups, one per tier. With no inline rules, Terraform removes the default allow-all
# egress rule AWS adds to a new group; every permitted path is one of the rules below. No group
# references anything outside this VPC.
#
# | Group   | Inbound                    | Outbound                                         |
# | ------- | -------------------------- | ------------------------------------------------ |
# | alb     | 443, 80 from 0.0.0.0/0     | 3000 to web; 3001 to api                         |
# | web     | 3000 from alb              | 3001 to api; 443 to 0.0.0.0/0                    |
# | api     | 3001 from alb and web      | 5432 to rds; 1344 to scanner; 443 and 587 out    |
# | scanner | 1344 from api              | 443 to 0.0.0.0/0 (GHCR, signatures, logs)        |
# | rds     | 5432 from api and ops      | none                                             |
# | ops     | none                       | 5432 to rds; 443 to 0.0.0.0/0                    |
#
# There is no Redis group: Redis listens on the API task's loopback interface only (§2.6).
locals {
  security_groups = {
    alb     = "Production ALB: HTTPS and the HTTP redirect from the internet"
    web     = "Production web tasks"
    api     = "Production API tasks (Redis on loopback)"
    scanner = "Production antivirus scanner tasks"
    rds     = "Production PostgreSQL"
    ops     = "Production short-lived operator tasks"
  }

  # key => { sg, port, peer sg (or null), cidr (or null), description }
  ingress_rules = {
    alb_https        = { sg = "alb", port = 443, from_sg = null, cidr = local.anywhere_ipv4, description = "HTTPS from the internet" }
    alb_http         = { sg = "alb", port = 80, from_sg = null, cidr = local.anywhere_ipv4, description = "HTTP from the internet (redirected to HTTPS)" }
    web_from_alb     = { sg = "web", port = 3000, from_sg = "alb", cidr = null, description = "Web from the ALB" }
    api_from_alb     = { sg = "api", port = 3001, from_sg = "alb", cidr = null, description = "Preview streams from the ALB" }
    api_from_web     = { sg = "api", port = 3001, from_sg = "web", cidr = null, description = "Server-side API calls from web" }
    scanner_from_api = { sg = "scanner", port = 1344, from_sg = "api", cidr = null, description = "ICAP from the API" }
    rds_from_api     = { sg = "rds", port = 5432, from_sg = "api", cidr = null, description = "PostgreSQL from the API" }
    rds_from_ops     = { sg = "rds", port = 5432, from_sg = "ops", cidr = null, description = "PostgreSQL from operator tasks" }
  }

  egress_rules = {
    alb_to_web     = { sg = "alb", port = 3000, to_sg = "web", cidr = null, description = "To web" }
    alb_to_api     = { sg = "alb", port = 3001, to_sg = "api", cidr = null, description = "To the API (preview streams)" }
    web_to_api     = { sg = "web", port = 3001, to_sg = "api", cidr = null, description = "To the API" }
    web_https      = { sg = "web", port = 443, to_sg = null, cidr = local.anywhere_ipv4, description = "HTTPS: GHCR, Secrets Manager, CloudWatch Logs" }
    api_to_rds     = { sg = "api", port = 5432, to_sg = "rds", cidr = null, description = "To PostgreSQL" }
    api_to_scanner = { sg = "api", port = 1344, to_sg = "scanner", cidr = null, description = "To the scanner (ICAP)" }
    api_https      = { sg = "api", port = 443, to_sg = null, cidr = local.anywhere_ipv4, description = "HTTPS: GHCR, S3, Secrets Manager, CloudWatch Logs" }
    api_smtp       = { sg = "api", port = 587, to_sg = null, cidr = local.anywhere_ipv4, description = "SMTP submission with STARTTLS (ADR-0025)" }
    scanner_https  = { sg = "scanner", port = 443, to_sg = null, cidr = local.anywhere_ipv4, description = "HTTPS: GHCR, signature downloads, CloudWatch Logs" }
    ops_to_rds     = { sg = "ops", port = 5432, to_sg = "rds", cidr = null, description = "To PostgreSQL" }
    ops_https      = { sg = "ops", port = 443, to_sg = null, cidr = local.anywhere_ipv4, description = "HTTPS: image pulls, Secrets Manager, SSM, CloudWatch Logs" }
  }
}

resource "aws_security_group" "tier" {
  for_each = local.security_groups

  name        = "${local.prefix}-${each.key}"
  description = each.value
  vpc_id      = aws_vpc.main.id

  tags = { Name = "${local.prefix}-${each.key}" }
}

resource "aws_vpc_security_group_ingress_rule" "tier" {
  for_each = local.ingress_rules

  security_group_id            = aws_security_group.tier[each.value.sg].id
  description                  = each.value.description
  ip_protocol                  = "tcp"
  from_port                    = each.value.port
  to_port                      = each.value.port
  referenced_security_group_id = each.value.from_sg == null ? null : aws_security_group.tier[each.value.from_sg].id
  cidr_ipv4                    = each.value.cidr

  tags = { Name = "${local.prefix}-${replace(each.key, "_", "-")}" }
}

resource "aws_vpc_security_group_egress_rule" "tier" {
  for_each = local.egress_rules

  security_group_id            = aws_security_group.tier[each.value.sg].id
  description                  = each.value.description
  ip_protocol                  = "tcp"
  from_port                    = each.value.port
  to_port                      = each.value.port
  referenced_security_group_id = each.value.to_sg == null ? null : aws_security_group.tier[each.value.to_sg].id
  cidr_ipv4                    = each.value.cidr

  tags = { Name = "${local.prefix}-${replace(each.key, "_", "-")}" }
}
