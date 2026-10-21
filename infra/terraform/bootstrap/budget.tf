# The Production monthly budget, filtered to resources tagged Environment=Production. The tag must
# be an active cost allocation tag for the filter to see any cost, so bootstrap activates it (and
# Project). The keys must already appear in the account's billing data, inactive.
#
# Activation is not retroactive: costs incurred before it are not attributed to the tag.
#
# AWS refuses to activate a key it has not yet seen in billing data, which in a new account takes
# up to 24 hours after the first tagged resource. Activation is therefore switched on separately
# (activate_cost_allocation_tags) once both keys appear; the budget does not wait for it.

resource "aws_ce_cost_allocation_tag" "environment" {
  count    = var.activate_cost_allocation_tags ? 1 : 0
  provider = aws.us_east_1

  tag_key = "Environment"
  status  = "Active"
}

resource "aws_ce_cost_allocation_tag" "project" {
  count    = var.activate_cost_allocation_tags ? 1 : 0
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
}

# The whole account, unfiltered: anything not tagged Environment=Production (or created before the
# tag was active) still counts here.
resource "aws_budgets_budget" "account" {
  name         = "munaxa-account-monthly"
  budget_type  = "COST"
  limit_amount = format("%.2f", var.monthly_account_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

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
    notification_type          = "FORECASTED"
    subscriber_email_addresses = var.budget_alert_emails
  }
}
