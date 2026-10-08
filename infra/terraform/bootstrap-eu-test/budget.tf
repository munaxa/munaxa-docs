# Cost guard for the whole munaxa-nonprod account (TEST is its only workload). Account-wide, so no
# cost-allocation tag has to be active for it to see every dollar, including anything left running
# by mistake. Budgets are free; the deployer and CI can never change them (budgets:* is denied).
#
# Idle TEST is expected to cost about USD 2–3 a month (two KMS keys, one hosted zone, storage);
# every hour a TEST session runs adds roughly USD 0.12 (ALB, Fargate, db.t4g.micro, public IPv4).

resource "aws_budgets_budget" "testing" {
  name         = "${local.prefix}-account-monthly"
  budget_type  = "COST"
  limit_amount = format("%.2f", var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  # Early warning: half the budget spent usually means a session was left running for days.
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 50
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = var.budget_alert_emails
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = var.budget_alert_emails
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = var.budget_alert_emails
  }
}
