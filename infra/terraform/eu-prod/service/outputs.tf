output "certificate_arn" {
  description = "ACM certificate for docs.munaxa.com."
  value       = aws_acm_certificate.web.arn
}

output "certificate_validation_records" {
  description = "The DNS record(s) to create in Cloudflare (DNS only, not proxied) to validate the certificate."
  value = [for o in aws_acm_certificate.web.domain_validation_options : {
    name  = o.resource_record_name
    type  = o.resource_record_type
    value = o.resource_record_value
  }]
}

output "alb_dns_name" {
  description = "The ALB's DNS name: the target of the docs.munaxa.com CNAME in Cloudflare (at cutover)."
  value       = aws_lb.main.dns_name
}

output "secret_arns" {
  description = "Secrets Manager containers (ARNs only; values are written by an operator)."
  value = {
    ghcr_pull = aws_secretsmanager_secret.ghcr_pull.arn
    app       = aws_secretsmanager_secret.app.arn
    operator  = aws_secretsmanager_secret.operator.arn
  }
}

output "cluster_name" {
  description = "The Production ECS cluster."
  value       = aws_ecs_cluster.main.name
}

output "cloudmap_namespace" {
  description = "Private DNS namespace for api and scanner."
  value       = aws_service_discovery_private_dns_namespace.main.name
}
