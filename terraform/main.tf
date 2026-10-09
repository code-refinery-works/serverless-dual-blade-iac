terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

provider "aws" {
  region = var.aws_region
  default_tags { tags = { Project = var.project_name, ManagedBy = "Terraform" } }
}

# KMS CMK for DynamoDB SSE
resource "aws_kms_key" "dynamo" {
  description             = "${var.project_name} DynamoDB CMK"
  deletion_window_in_days = 30
  enable_key_rotation     = true
}

resource "aws_kms_alias" "dynamo" {
  name          = "alias/${var.project_name}-dynamo"
  target_key_id = aws_kms_key.dynamo.key_id
}

# DynamoDB Table
resource "aws_dynamodb_table" "main" {
  name         = "${var.project_name}-items"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute { name = "pk"; type = "S" }
  attribute { name = "sk"; type = "S" }

  point_in_time_recovery { enabled = true }
  deletion_protection_enabled = true

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.dynamo.arn
  }

  lifecycle { prevent_destroy = true }
}

# IAM Role for Lambda
resource "aws_iam_role" "lambda" {
  name = "${var.project_name}-lambda-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy" "lambda_dynamo" {
  name = "dynamo-least-privilege"
  role = aws_iam_role.lambda.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query", "dynamodb:DeleteItem", "dynamodb:UpdateItem"]
        Resource = aws_dynamodb_table.main.arn
      },
      {
        Effect   = "Allow"
        Action   = ["kms:Decrypt", "kms:GenerateDataKey"]
        Resource = aws_kms_key.dynamo.arn
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents", "xray:PutTraceSegments", "xray:PutTelemetryRecords"]
        Resource = "*"
      }
    ]
  })
}

# SNS Topic for Alarms
resource "aws_sns_topic" "alarms" {
  name = "${var.project_name}-alarms"
}

# CloudWatch Alarms
resource "aws_cloudwatch_metric_alarm" "dynamo_system_errors" {
  alarm_name          = "${var.project_name}-dynamo-system-errors"
  namespace           = "AWS/DynamoDB"
  metric_name         = "SystemErrors"
  dimensions          = { TableName = aws_dynamodb_table.main.name }
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  alarm_actions       = [aws_sns_topic.alarms.arn]
}

# SSM Parameters (consumed by CDK)
resource "aws_ssm_parameter" "table_name" {
  name  = "/${var.project_name}/dynamo/table-name"
  type  = "String"
  value = aws_dynamodb_table.main.name
}

resource "aws_ssm_parameter" "table_arn" {
  name  = "/${var.project_name}/dynamo/table-arn"
  type  = "String"
  value = aws_dynamodb_table.main.arn
}

resource "aws_ssm_parameter" "lambda_role_arn" {
  name  = "/${var.project_name}/lambda/role-arn"
  type  = "String"
  value = aws_iam_role.lambda.arn
}

resource "aws_ssm_parameter" "sns_alarm_arn" {
  name  = "/${var.project_name}/sns/alarm-arn"
  type  = "String"
  value = aws_sns_topic.alarms.arn
}