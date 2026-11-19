# API kenko-auth para ECS Fargate.
# Bun 1.4.4 = version verificada en dev. Multi-arch (arm64 Graviton).
FROM oven/bun:1.4.4-debian

WORKDIR /app

# Deps primero (capa cacheable): solo prod.
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile

# Codigo necesario para API + relay one-shot. Sin tests/docs/terraform/.env.
COPY src ./src

# Bun corre como root por defecto; creamos user sin privilegios.
# Debian slim no trae `adduser`, usamos `useradd`.
RUN useradd -m appuser && chown -R appuser:appuser /app
USER appuser

ENV PORT=3000
EXPOSE 3000

# Healthcheck interno (sin curl): usa bun para pedir /health.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://localhost:'+(process.env.PORT||'3000')+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["bun", "src/index.ts"]
