output "ecr_repository_url" {
  value = aws_ecr_repository.relay.repository_url
}

output "lambda_function_name" {
  value = aws_lambda_function.relay.function_name
}

output "lambda_role_name" {
  value = aws_iam_role.relay.name
}

output "api_ecr_url" {
  value = aws_ecr_repository.api.repository_url
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.main.name
}

output "rds_endpoint" {
  value = aws_db_instance.auth.address
}

output "ec2_eip" {
  value = aws_eip.api.public_ip
}

output "budget_topic_arn" {
  value = aws_sns_topic.budget.arn
}
