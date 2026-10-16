/**
 * Configuracion de drizzle-kit.
 *
 * Reutiliza `loadEnv()` y `resolveDatabase()` de `src/config/env.ts` a proposito:
 * asi la app y las migraciones comparten la misma validacion y, sobre todo, la
 * misma politica de resolucion de base de datos. Un `throw new Error()` aqui
 * produciria un mensaje pobre frente al log estructurado de `loadEnv()`.
 */

import { defineConfig } from 'drizzle-kit'

import { loadEnv, resolveDatabase } from './src/config/env'

const env = loadEnv()
const database = resolveDatabase(env)

export default defineConfig({
  schema: './src/infra/db/schema/index.ts',
  out: './src/infra/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: database.url,
  },
})