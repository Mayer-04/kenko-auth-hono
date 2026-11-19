import {
	InvokeCommand,
	LambdaClient,
	type LambdaClientConfig,
} from "@aws-sdk/client-lambda";
import type winston from "winston";

import { LogEvent } from "../../shared/log-events.js";

/**
 * Aviso al relay Lambda justo despues de escribir en `outbox`.
 *
 * - Modo async (`InvocationType: Event`): responde de inmediato, sin
 *   esperar la pasada. El retardo baja a segundos.
 * - Nunca rompe la peticion: cualquier fallo se loguea y el Scheduler
 *   de 1 min lo recoge al ser la red de seguridad.
 * - Sin configurar (`functionName` o `region` ausentes) es no-op:
 *   local y tests no tocan AWS.
 */
export type RelayInvoker = () => void;

export type RelayInvokerDeps = {
	region: string | undefined;
	functionName: string | undefined;
	logger: winston.Logger;
	/** Solo para tests: cliente prefabricado. */
	client?: Pick<LambdaClient, "send">;
};

export const makeRelayInvoker = (deps: RelayInvokerDeps): RelayInvoker => {
	const { region, functionName, logger } = deps;
	if (functionName === undefined || functionName.trim() === "") {
		return () => {};
	}
	if (region === undefined || region.trim() === "") {
		return () => {};
	}
	const client: Pick<LambdaClient, "send"> =
		deps.client ?? new LambdaClient({ region } satisfies LambdaClientConfig);

	return () => {
		void client
			.send(
				new InvokeCommand({
					FunctionName: functionName,
					InvocationType: "Event",
					Payload: Buffer.from("{}"),
				}),
			)
			.catch((err: unknown) => {
				logger.warn(LogEvent.RELAY_NOTIFY_FAILED, {
					error: err instanceof Error ? err.message : "unknown",
				});
			});
	};
};
