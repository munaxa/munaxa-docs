# The TEST hostname. Its public hosted zone (USD 0.50 a month) lives here, persistent, so the URL
# never changes: Cloudflare delegates test.docs.munaxa.com to it ONCE (four NS records, see the
# outputs and README), and every TEST session then points the name at its own load balancer
# automatically. The certificate is free and also persistent, so a session never waits for DNS
# validation.

resource "aws_route53_zone" "test" {
  name    = var.test_hostname
  comment = "Munaxa Docs TEST (delegated from munaxa.com in Cloudflare)"

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_acm_certificate" "test" {
  domain_name       = var.test_hostname
  validation_method = "DNS"
  key_algorithm     = "RSA_2048"

  tags = { Name = var.test_hostname }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "certificate_validation" {
  for_each = {
    for o in aws_acm_certificate.test.domain_validation_options : o.domain_name => o
  }

  zone_id = aws_route53_zone.test.zone_id
  name    = each.value.resource_record_name
  type    = each.value.resource_record_type
  records = [each.value.resource_record_value]
  ttl     = 300
}

# Not waited for here: validation completes by itself once Cloudflare delegates the name. The session
# root only accepts an ISSUED certificate, so nothing serves TEST before then.
