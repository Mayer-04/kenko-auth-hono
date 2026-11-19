# EC2 Opcion 1: t4g.micro + EIP fija (estable, ~$6/mes, Free plan).
# Corre API + relay loop con Docker. Sin ALB/NAT.
# ECS se apaga despues (desired 0) para no pagar doble.

data "aws_ami" "al2023" {
  most_recent = true
  owners      = ["amazon"]
  filter {
    name   = "name"
    values = ["al2023-ami-2023.*-arm64"]
  }
  filter {
    name   = "architecture"
    values = ["arm64"]
  }
  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

resource "aws_security_group" "ec2" {
  name        = "${local.name_prefix}-ec2-sg"
  description = "API dev en EC2: 3000 publico. Solo demo."
  vpc_id      = aws_vpc.main.id
  tags        = local.common_tags

  ingress {
    description = "API demo"
    from_port   = var.api_port
    to_port     = var.api_port
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# Acceso EC2 -> RDS se define inline en rds.tf (no usar regla separada:
# mezclar inline + separadas hace que Terraform borre la separada).

resource "aws_cloudwatch_log_group" "ec2api" {
  name              = "/ec2/${local.name_prefix}-api"
  retention_in_days = var.log_retention_days
  tags              = local.common_tags
}

resource "aws_cloudwatch_log_group" "ec2relay" {
  name              = "/ec2/${local.name_prefix}-relay"
  retention_in_days = var.log_retention_days
  tags              = local.common_tags
}

resource "aws_iam_role" "ec2" {
  name = "${local.name_prefix}-ec2"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
  tags = local.common_tags
}

resource "aws_iam_role_policy_attachment" "ec2_ssm_core" {
  role       = aws_iam_role.ec2.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy_attachment" "ec2_ecr" {
  role       = aws_iam_role.ec2.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
}

resource "aws_iam_role_policy_attachment" "ec2_cw" {
  role       = aws_iam_role.ec2.name
  policy_arn = "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy"
}

resource "aws_iam_policy" "ec2_app" {
  name = "${local.name_prefix}-ec2-app"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ReadSsmParams"
        Effect = "Allow"
        Action = ["ssm:GetParameter", "ssm:GetParameters"]
        Resource = [
          aws_ssm_parameter.rds_url.arn,
          aws_ssm_parameter.jwt_secret.arn,
          aws_ssm_parameter.portal_base_url.arn,
        ]
      },
      {
        Sid      = "PublishToBus"
        Effect   = "Allow"
        Action   = ["events:PutEvents"]
        Resource = local.event_bus_arn
      },
      {
        Sid      = "InvokeRelay"
        Effect   = "Allow"
        Action   = ["lambda:InvokeFunction"]
        Resource = aws_lambda_function.relay.arn
      },
    ]
  })
  tags = local.common_tags
}

resource "aws_iam_role_policy_attachment" "ec2_app" {
  role       = aws_iam_role.ec2.name
  policy_arn = aws_iam_policy.ec2_app.arn
}

resource "aws_iam_instance_profile" "ec2" {
  name = "${local.name_prefix}-ec2"
  role = aws_iam_role.ec2.name
  tags = local.common_tags
}

resource "aws_eip" "api" {
  domain = "vpc"
  tags   = merge(local.common_tags, { Name = "${local.name_prefix}-api-eip" })
}

resource "aws_instance" "api" {
  ami                         = data.aws_ami.al2023.id
  instance_type               = "t4g.micro"
  subnet_id                   = aws_subnet.public_a.id
  vpc_security_group_ids      = [aws_security_group.ec2.id]
  iam_instance_profile        = aws_iam_instance_profile.ec2.name
  associate_public_ip_address = true

  root_block_device {
    volume_size = 20
    volume_type = "gp3"
    encrypted   = true
  }

  # Recrea antes de destruir: la EIP salta a la nueva al final y el corte es minimo.
  lifecycle {
    create_before_destroy = true
  }

  # Sin secretos quemados: el script los lee de SSM al arrancar.
  user_data_base64 = base64encode(<<-EOS
    #!/bin/bash
    set -eux
    dnf update -y
    dnf install -y docker
    systemctl enable --now docker
    usermod -aG docker ec2-user || true

    REGION="${var.aws_region}"
    ECR="${aws_ecr_repository.api.repository_url}:${var.api_image_tag}"
    aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "${aws_ecr_repository.api.repository_url}"

    RDS_URL=$(aws ssm get-parameter --name "${aws_ssm_parameter.rds_url.name}" --with-decrypt --region "$REGION" --query Parameter.Value --output text)
    JWT_SECRET=$(aws ssm get-parameter --name "${aws_ssm_parameter.jwt_secret.name}" --with-decrypt --region "$REGION" --query Parameter.Value --output text)
    PORTAL_URL=$(aws ssm get-parameter --name "${aws_ssm_parameter.portal_base_url.name}" --region "$REGION" --query Parameter.Value --output text)

    docker rm -f api relay 2>/dev/null || true
    docker pull "$ECR"

    docker run -d --restart unless-stopped --name api \
      -p ${var.api_port}:${var.api_port} \
      --log-driver awslogs --log-opt awslogs-group=${aws_cloudwatch_log_group.ec2api.name} --log-opt awslogs-region=${var.aws_region} --log-opt awslogs-stream=api \
      -e PORT="${var.api_port}" -e ENVIRONMENT="${var.app_environment}" \
      -e AWS_REGION="${var.aws_region}" \
      -e RELAY_FUNCTION_NAME="${aws_lambda_function.relay.function_name}" \
      -e EVENT_BUS_NAME="${var.event_bus_name}" -e PORTAL_BASE_URL="$PORTAL_URL" \
      -e JWT_ISSUER="${var.jwt_issuer}" -e JWT_AUDIENCE="${var.jwt_audience}" -e CORS_ORIGINS="${var.cors_origins}" \
      -e POSTGRES_URL="postgresql://dummy:dummy@localhost:5432/dummy" \
      -e AWS_RDS_POSTGRES_URL="$RDS_URL" -e JWT_SECRET="$JWT_SECRET" \
      "$ECR"
  EOS
  )

  tags = merge(local.common_tags, { Name = "${local.name_prefix}-api" })
}

resource "aws_eip_association" "api" {
  instance_id   = aws_instance.api.id
  allocation_id = aws_eip.api.id
}
