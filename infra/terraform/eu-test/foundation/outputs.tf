output "delegation_name_servers" {
  description = "Add these four NS records for test.docs.munaxa.com in Cloudflare (munaxa.com zone), once. Until then TEST has no working URL."
  value       = aws_route53_zone.test.name_servers
}

output "test_url" {
  description = "The TEST address every session uses."
  value       = local.web_origin
}

output "certificate_status" {
  description = "ISSUED once Cloudflare delegates the name; sessions refuse to start before that."
  value       = aws_acm_certificate.test.status
}

output "vpc_id" {
  value = aws_vpc.main.id
}

output "docs_bucket" {
  value = aws_s3_bucket.docs.id
}
