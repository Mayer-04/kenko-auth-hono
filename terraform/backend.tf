# Estado local por defecto (terraform.tfstate esta en .gitignore).
#
# Decision: para este dev inicial no se crea bucket S3 solo para el estado
# (seria un recurso extra). Cuando el flujo del equipo lo requiera, migrar a
# backend remoto S3 con cifrado + bloqueo, sin versionar credenciales.
# Ver AGENTS.md 11.2.
