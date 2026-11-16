import winston from "winston";

import { SERVICE_NAME } from "../shared/service.js";
import type { Environment } from "./env.js";

/**
 * Logger unico del servicio (Winston).
 *
 * - Produccion/test: JSON estructurado con `service`, `timestamp` y `level`
 *   (apto para CloudWatch/agregadores; se filtra por `event` y `correlationId`).
 * - Desarrollo: misma informacion con color por nivel
 *   (`info`=verde, `warn`=amarillo, `error`=rojo) y una linea legible por
 *   request/evento. No cambia lo que se registra, solo como se ve.
 * - Nunca registrar contrasenas, tokens, secretos ni PII completa
 *   (documento, direccion, telefono, correo). Los llamadores pasan solo
 *   `correlationId`, `userId`, `eventId` u otros IDs no sensibles.
 * - `src/config/env.ts` no usa este logger a proposito: debe funcionar
 *   antes de que exista configuracion valida.
 */

let rootLogger: winston.Logger | undefined;

const levelFor = (environment: Environment): string => {
	if (environment === "production") return "info";
	if (environment === "test") return "warn";
	return "debug";
};

export const initLogger = (environment: Environment): winston.Logger => {
	if (rootLogger !== undefined) return rootLogger;

	// Desarrollo: legible con color. El objeto completo sigue disponible en
	// `metadata` para depurar sin perder campos.
	const devFormat = winston.format.combine(
		winston.format.colorize({ all: true }),
		winston.format.timestamp(),
		winston.format.printf(
			({ level, message, timestamp, service, ...rest }) =>
				`${timestamp} [${service}] ${level}: ${message} ${JSON.stringify(rest)}`,
		),
	);

	const productionFormat = winston.format.combine(
		winston.format.timestamp(),
		winston.format.json(),
	);

	rootLogger = winston.createLogger({
		level: levelFor(environment),
		format: environment === "development" ? devFormat : productionFormat,
		defaultMeta: { service: SERVICE_NAME },
		transports: [new winston.transports.Console()],
	});

	return rootLogger;
};

export const getLogger = (): winston.Logger => {
	if (rootLogger === undefined) {
		throw new Error("Logger no inicializado. Llame a initLogger() primero.");
	}
	return rootLogger;
};

/** Logger hijo con correlacion, sin PII. */
export const withCorrelation = (correlationId: string): winston.Logger => {
	return getLogger().child({ correlationId });
};
