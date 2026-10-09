output "dynamodb_table_name" {
  description = "DynamoDB table name"
  value       = aws_dynamodb_table.main.name
}

output "dynamodb_table_arn" {
  description = "DynamoDB table ARN"
  value       = aws_dynamodb_table.main.arn
}

output "kms_key_arn" {
  description = "KMS CMK ARN for DynamoDB SSE"
  value       = aws_kms_key.dynamo.arn
}

output "lambda_role_arn" {
  description = "IAM Role ARN for Lambda execution"
  value       = aws_iam_role.lambda.arn
}

output "sns_alarm_topic_arn" {
  description = "SNS topic ARN for CloudWatch alarms"
  value       = aws_sns_topic.alarms.arn
}

output "ssm_param_table_name" {
  description = "SSM parameter path for DynamoDB table name (consumed by CDK)"
  value       = aws_ssm_parameter.table_name.name
}