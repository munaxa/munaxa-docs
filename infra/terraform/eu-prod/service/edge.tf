# The public edge (ADR-0024 §2.3): one internet-facing ALB in the public subnets with the core `alb`
# security group (443 and 80 in; 3000 to web and 3001 to the API out). Every request goes to web,
# except /api/v1/preview/stream*, which goes to the API. No other /api path is routed publicly.
#
# DNS stays with Cloudflare. The certificate is validated by a CNAME the operator adds there; until
# it is ISSUED there is no listener at all — never a plain-HTTP production listener.

resource "aws_acm_certificate" "web" {
  domain_name       = local.web_hostname
  validation_method = "DNS"
  key_algorithm     = "RSA_2048"

  tags = { Name = local.web_hostname }

  lifecycle {
    create_before_destroy = true
  }
}

# Blocks until ACM reports ISSUED (the validation CNAME is in Cloudflare). Only in the HTTPS stage.
resource "aws_acm_certificate_validation" "web" {
  count = var.enable_https ? 1 : 0

  certificate_arn = aws_acm_certificate.web.arn

  timeouts {
    create = "15m"
  }
}

resource "aws_lb" "main" {
  name                       = "${local.prefix}-alb"
  internal                   = false
  load_balancer_type         = "application"
  security_groups            = [data.aws_security_group.tier["alb"].id]
  subnets                    = sort(data.aws_subnets.public.ids)
  ip_address_type            = "ipv4"
  enable_deletion_protection = true
  drop_invalid_header_fields = true
  idle_timeout               = 120

  tags = { Name = local.prefix }
}

resource "aws_lb_target_group" "web" {
  name                 = "${local.prefix}-web"
  port                 = 3000
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = data.aws_vpc.production.id
  deregistration_delay = 30

  # /login makes no API or database call without a session (§2.3).
  health_check {
    path                = "/login"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_target_group" "api" {
  name                 = "${local.prefix}-api"
  port                 = 3001
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = data.aws_vpc.production.id
  deregistration_delay = 30

  # Liveness only: a readiness check would remove the only API task during one tenant's database
  # outage (ADR-0021 §4, ADR-0024 §2.3).
  health_check {
    path                = "/api/health/live"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "https" {
  count = var.enable_https ? 1 : 0

  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.web[0].certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
}

resource "aws_lb_listener_rule" "preview_stream" {
  count = var.enable_https ? 1 : 0

  listener_arn = aws_lb_listener.https[0].arn
  priority     = 10

  condition {
    path_pattern {
      values = ["/api/v1/preview/stream*"]
    }
  }

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

resource "aws_lb_listener" "http_redirect" {
  count = var.enable_https ? 1 : 0

  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"

    redirect {
      protocol    = "HTTPS"
      port        = "443"
      status_code = "HTTP_301"
    }
  }

  depends_on = [aws_lb_listener.https]
}
