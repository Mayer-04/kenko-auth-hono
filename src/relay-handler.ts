import type { EventBridgeClient } from "@aws-sdk/client-eventbridge";
import type winston from "winston";

import { loadEnv, resolveDatabase } from "./config/env.js";
import { initLogger } from "./config/logger.js";
import type { DbClient } from "./infra/db/client.js";
import type { OutboxRepository } from "./infra/db/repositories/outbox.repository.js";
import { makeOutboxRepository } from "./infra/db/repositories/outbox.repository.js";
import {
	createEventBridgeClient,
	resolveBusName,
} from "./infra/events/eventbridge-client.js";
import { runRelayOnce } from "./infra/events/outbox-relay.js";
import { LogEvent } from "./shared/log-events.js";

/**
 * Relay outbox -> EventBridge como servidor HTTP minimo para Lambda.
 *
 * Patrón oficial de Bun en Lambda (guia vigente): contenedor
 * `oven/bun` + `aws-lambda-adapter`. El adapter traduce cada invocacion
 * (Scheduler cada 1 min) a una peticion HTTP local en `PORT` (8080).
 * La logica es la misma `runRelayOnce()` del worker `src/relay.ts`:
 * paridad total entre ejecucion local y Lambda.
 *
 * - `GET /health`: solo readiness del adapter (`AWS_LWA_READINESS_CHECK_PATH`).
 *   No toca la DB ni publica: un chequeo de salud jamas debe disparar trabajo.
 * - Cualquier otra peticion: una pasada `claimPending -> PutEvents ->
 *   markSent/reschedule`. Fallos por fila ya los absorbe `runRelayOnce`
 *   (200 con conteos); solo un fallo catastrofico (DB caida) devuelve 500
 *   para que quede registrado como invocacion fallida.
 * - Init una sola vez por entorno de ejecucion (modulo): clientes de DB y
 *   EventBridge se reutilizan entre invocaciones calientes. No se cierra la
 *   DB por peticion; Lambda congela/descongela el entorno solo.
 */

export type RelayHandlerDeps = {
	outbox: OutboxRepository;
	eventBridge: EventBridgeClient;
	eventBusName: string;
	logger: winston.Logger;
};

export const createRelayHandler = (deps: RelayHandlerDeps) => {
	return async (req: Request): Promise<Response> => {
		const url = new URL(req.url);
		if (req.method === "GET" && url.pathname === "/health") {
			return Response.json({ data: { status: "ok" } });
		}

		try {
			const outcome = await runRelayOnce(deps);
			return Response.json({ data: outcome });
		} catch (err) {
			deps.logger.error(LogEvent.RELAY_TICK_FAILED, {
				error: err instanceof Error ? err.message : "unknown",
			});
			return Response.json(
				{
					error: {
						code: "RELAY_FAILED",
						message: "No se pudo publicar los eventos pendientes.",
					},
				},
				{ status: 500 },
			);
		}
	};
};

/** Arranque del servidor. Solo corre con `bun run src/relay-handler.ts`. */
export const startRelayServer = async (): Promise<{
	server: ReturnType<typeof Bun.serve>;
	dbClient: DbClient;
}> => {
	const env = loadEnv();
	const logger = initLogger(env.ENVIRONMENT);
	const database = resolveDatabase(env);

	logger.info(LogEvent.RELAY_STARTING, {
		target: database.target,
		...database.safeDescription,
	});

	// Import diferido: `infrastructure/db/client.ts` usa el SQL nativo de Bun
	// y no existe en Node. Diferirlo mantiene `bun run test` (vitest en Node)
	// en verde al importar solo `createRelayHandler`. En Lambda (Bun) no cambia nada.
	const { createDb } = await import("./infra/db/client.js");
	const dbClient = createDb(database.url);
	const handler = createRelayHandler({
		outbox: makeOutboxRepository(dbClient),
		eventBridge: createEventBridgeClient(env.AWS_REGION),
		eventBusName: resolveBusName(env.EVENT_BUS_NAME),
		logger,
	});

	const server = Bun.serve({ port: env.PORT, fetch: handler });
	logger.info(LogEvent.SERVER_STARTING, { port: env.PORT });
	return { server, dbClient };
};

if (import.meta.main) {
	void startRelayServer();
}
