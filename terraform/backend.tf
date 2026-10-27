# Estado remoto: bucket bootstrap `kenko-tfstate-137696817246-us-east-1`
# (versionado + AES-256 + bloqueo público). Nunca en git.
terraform {
  backend "s3" {
    bucket       = "kenko-tfstate-137696817246-us-east-1"
    key          = "kenko-auth-dev.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}
