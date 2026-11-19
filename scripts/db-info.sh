#!/bin/bash
# Ayuda para DBeaver / psql SIN guardar secretos en disco.
# No contiene passwords: los trae de SSM solo a memoria cuando TU lo ejecutas.
set -euo pipefail
REGION="us-east-1"

echo "== RDS kenko-auth (dev) =="
echo "Identifier : kenko-dev-auth-db"
echo "Host       : $(terraform -chdir=$(dirname "$0")/../terraform output -raw rds_endpoint 2>/dev/null || echo 'kenko-dev-auth-db.cezucwi0oldg.us-east-1.rds.amazonaws.com')"
echo "Puerto     : 5432"
echo "DB         : kenko_auth"
echo "User       : kenko_auth"
echo "SSL        : require (sslmode=require)"
echo ""
echo "RDS es PRIVADA (sin IP publica). DBeaver local NO conecta directo."
echo "Usa tunel SSM via EC2 (puerto local 5433 -> RDS 5432):"
echo ""
echo '  IID=$(aws ec2 describe-instances --region '"$REGION"' --filters "Name=tag:Name,Values=kenko-dev-auth-api" "Name=instance-state-name,Values=running" --query "Reservations[0].Instances[0].InstanceId" --output text)'
echo '  aws ssm start-session --region '"$REGION"' --target "$IID" --document-name AWS-StartPortForwardingSessionToRemoteHost --parameters "{\"host\":[\"$(terraform -chdir=terraform output -raw rds_endpoint 2>/dev/null)\"],\"portNumber\":[\"5432\"],\"localPortNumber\":[\"5433\"]}"'
echo ""
echo "Luego en DBeaver: Host=localhost Puerto=5433 DB=kenko_auth User=kenko_auth SSL=require"
echo "Password (solo en TU terminal, no se guarda):"
echo '  aws ssm get-parameter --name /kenko/dev/db_password --with-decrypt --region '"$REGION"' --query Parameter.Value --output text'
