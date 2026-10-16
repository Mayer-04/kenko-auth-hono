/**
 * Validacion y resolucion del entorno.
 *
 * Reglas de este modulo:
 * - Es la unica fuente de verdad del entorno. La app y `drizzle.config.ts`
 *   consumen `loadEnv()`, por lo que un error de configuracion se reporta
 *   exactamente igual en ambos procesos.
 * - Falla rapido: log estructurado en stderr y codigo de salida 1. Nunca un
 *   `throw new Error()` con el mensaje crudo.
 * - Nunca se imprime el valor de una variable, solo su nombre, su codigo de
 *   error y el mensaje del validador. Las URLs de conexion contienen usuario y
 *   contrasena, asi que tampoco se registran.
 * - `parseEnv()` es puro: no lee `process.env`, no loguea y no sale. Es la
 *   superficie que se prueba.
 */

import { z } from 'zod'

const SERVICE_NAME = 'kenko-auth'

/** Bus de eventos confirmado para el entorno de desarrollo. Ver AGENTS.md 5.2. */
const DEFAULT_EVENT_BUS_NAME = 'kenko-dev-bus'

const ENVIRONMENTS = ['development', 'test', 'production'] as const

export type Environment = (typeof ENVIRONMENTS)[number]

/**
 * Trata una cadena vacia como variable ausente.
 * En archivos `.env` un valor sin definir llega como `''`, y no como
 * `undefined`. Sin esta conversion, `AWS_REGION=` reprobaria la validacion.
 */
function optionalWhenPresent<TSchema extends z.ZodType>(schema: TSchema) {
  return z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    schema.optional(),
  )
}

/**
 * `z.object` y no `z.strictObject`: `process.env` contiene cientos de variables
 * del sistema (PATH, SystemRoot, ...) y las desconocidas deben descartarse, no
 * provocar un fallo de arranque.
 *
 * Nota: `POSTGRES_DB`, `POSTGRES_USER` y `POSTGRES_PASSWORD` no se validan aqui.
 * Las consume `compose.yml` para levantar el contenedor, no la aplicacion, que
 * se conecta con `POSTGRES_URL`.
 */
export const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535),
  ENVIRONMENT: z.enum(ENVIRONMENTS),
  EVENT_BUS_NAME: z.string().min(1).default(DEFAULT_EVENT_BUS_NAME),
  AWS_REGION: optionalWhenPresent(z.string().min(1)),
  POSTGRES_URL: z.url(),
  AWS_RDS_POSTGRES_URL: optionalWhenPresent(z.url()),
})

export type Env = z.infer<typeof EnvSchema>

export type ConfigurationIssue = {
  /** Ruta de la variable dentro del esquema, por ejemplo `AWS_RDS_POSTGRES_URL`. */
  variable: string
  /** Codigo de fallo de Zod, por ejemplo `invalid_type` o `invalid_value`. */
  code: string
  /** Mensaje del validador. Nunca contiene el valor rechazado. */
  message: string
}

export type EnvParseResult =
  | { ok: true; data: Env }
  | { ok: false; issues: ConfigurationIssue[] }

/**
 * Proyecta los issues de Zod a una lista de campos conocidos. No se hace spread
 * del objeto original: Zod puede incluir el valor rechazado en el issue y eso
 * filtraria credenciales a los logs.
 */
function toConfigurationIssues(error: z.ZodError): ConfigurationIssue[] {
  return error.issues.map((issue) => ({
    variable: issue.path.map((segment) => String(segment)).join('.') || '(raiz)',
    code: issue.code,
    message: issue.message,
  }))
}

/** Valida un entorno sin efectos secundarios. */
export function parseEnv(source: NodeJS.ProcessEnv): EnvParseResult {
  const result = EnvSchema.safeParse(source)

  if (result.success) {
    return { ok: true, data: result.data }
  }

  return { ok: false, issues: toConfigurationIssues(result.error) }
}

/**
 * Log de arranque, deliberadamente sin dependencias.
 *
 * No usa Winston a proposito: este log tiene que funcionar precisamente cuando
 * la configuracion es invalida, es decir antes de que exista un logger
 * configurado. Cuando `src/config/logger.ts` entre en juego, este sigue siendo
 * el unico punto que escribe en stderr durante el bootstrap.
 */
function writeFatalLog(details: Record<string, unknown>): void {
  const record = {
    level: 'fatal',
    service: SERVICE_NAME,
    event: 'configuration.invalid',
    timestamp: new Date().toISOString(),
    details,
  }

  process.stderr.write(`${JSON.stringify(record)}\n`)
}

let cachedEnv: Env | undefined

/**
 * Devuelve el entorno validado o termina el proceso.
 *
 * El resultado se memoriza: llamarla varias veces no repite la validacion ni
 * vuelve a leer `process.env`.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cachedEnv !== undefined) {
    return cachedEnv
  }

  const result = parseEnv(source)

  if (!result.ok) {
    writeFatalLog({ issueCount: result.issues.length, issues: result.issues })
    process.exit(1)
  }

  cachedEnv = result.data
  return cachedEnv
}

export type DatabaseTarget = 'rds' | 'local'

export type ResolvedDatabase = {
  url: string
  target: DatabaseTarget
  /** Descripcion apta para logs: sin usuario, contrasena ni query string. */
  safeDescription: {
    host: string
    port: string
    database: string
  }
}

/**
 * Extrae host, puerto y base de una URL de conexion. Se descarta todo lo demas,
 * en particular el usuario y la contrasena.
 */
function describeDatabaseUrl(url: string): ResolvedDatabase['safeDescription'] {
  try {
    const parsed = new URL(url)
    return {
      host: parsed.hostname,
      port: parsed.port !== '' ? parsed.port : '5432',
      database: parsed.pathname.replace(/^\//, ''),
    }
  } catch {
    return { host: '(no analizable)', port: '5432', database: '(desconocida)' }
  }
}

/**
 * Decide contra que base de datos se opera.
 *
 * Prioridad confirmada (AGENTS.md 6.1): RDS si su URL esta definida, local si no.
 * La decision se toma una sola vez, aqui. Si despues falla la conexion, el
 * llamador debe fallar y reportar: no existe fallback silencioso de RDS a local,
 * porque escribir en la base equivocada es peor que no arrancar.
 */
export function resolveDatabase(env: Env): ResolvedDatabase {
  const rdsUrl = env.AWS_RDS_POSTGRES_URL
  const target: DatabaseTarget = rdsUrl === undefined ? 'local' : 'rds'
  const url = rdsUrl ?? env.POSTGRES_URL

  return { url, target, safeDescription: describeDatabaseUrl(url) }
}