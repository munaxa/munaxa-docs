# The Production monthly budget, filtered to resources tagged Environment=Production. The tag must
# be an active cost allocation tag for the filter to see any cost, so bootstrap activates it (and
# Project). Both keys already appear in the account's billing data, inactive.
#
# Activation is not retroactive: costs incurred before it are not attributed to the tag.

resource "aws_ce_cost_allocation_tag" "environment" {
  provider = aws.us_east_1

  tag_key = "Environment"
  status  = "Active"
}

resource "aws_ce_cost_allocation_tag" "project" {
  provider = aws.us_east_1

  tag_key = "Project"
  status  = "Active"
}

resource "aws_budgets_budget" "production" {
  name         = "${local.prefix}-monthly"
  budget_type  = "COST"
  limit_amount = format("%.2f", var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  cost_filter {
    name   = "TagKeyValue"
    values = ["user:Environment$Production"]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
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

  depends_on = [aws_ce_cost_allocation_tag.environment]
}
