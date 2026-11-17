import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";

import { AppError } from "./errors.js";
import { HttpStatus } from "./http-status.js";
import { LogEvent } from "./log-events.js";

export type AppVariables = {
	correlationId: string;
	/** Fijado por `requireAuth` en rutas autenticadas. */
	userId?: string;
	/** Familia de refresh (`sid` del JWT). Ausente en tokens pre-`sid`. */
	sessionFamilyId?: string;
};

export type AppContext = Context<{ Variables: AppVariables }>;

/**
 * Formato de respuesta consistente.
 *
 * Exito: `{ "data": T }`.
 * Error: `{ "error": { "code", "message", "correlationId", details? } }`.
 * `details` solo en `VALIDATION_ERROR` (array por campo, vacio si el error
 * no es de un campo concreto) para que el frontend siempre pueda iterarlo.
 * Nunca se exponen detalles internos ni PII en `message`.
 */

export const ok = <T>(
	c: AppContext,
	data: T,
	status: HttpStatus = HttpStatus.OK,
) => {
	return c.json({ data }, status as 200);
};

export const created = <T>(c: AppContext, data: T) => {
	return c.json({ data }, HttpStatus.CREATED);
};

const correlationIdOf = (c: AppContext): string => {
	const fromVar = c.get("correlationId");
	return typeof fromVar === "string" && fromVar !== "" ? fromVar : "unknown";
};

/** Escritor minimo para dejar rastro de 500 no manejados (sin PII). */
export type ErrorLogger = {
	warn(event: string, fields: Record<string, string>): void;
};

/** Manejador central de errores para `app.onError`. */
export const errorHandler = (
	err: unknown,
	c: AppContext,
	logger?: ErrorLogger,
) => {
	const correlationId = correlationIdOf(c);

	if (err instanceof AppError) {
		const base = { code: err.code, message: err.message, correlationId } as {
			code: string;
			message: string;
			correlationId: string;
			details?: Array<{ field?: string; message: string }>;
		};
		// Todo 400 comparte `details` con el hook de Zod (alli lleno, aqui
		// vacio si el error nace en el servicio y no es de un campo concreto).
		// 409/401/404 no llevan `details` (anti-enumeracion: no revelar campo).
		const body =
			err.code === "VALIDATION_ERROR" ? { ...base, details: [] } : base;
		return c.json({ error: body }, err.status as 400);
	}

	if (err instanceof HTTPException) {
		// Hono lanza `HTTPException` antes de nuestros validadores Zod
		// (p. ej. `Content-Type: application/json` con body vacio o malformado:
		// el validador intenta `req.json()`, falla y lanza 400). Sin esta rama
		// esos errores de forma caian al 500 generico de abajo.
		if (err.status === HttpStatus.NOT_FOUND) {
			return c.json(
				{
					error: {
						code: "NOT_FOUND",
						message: "Recurso no encontrado.",
						correlationId,
					},
				},
				HttpStatus.NOT_FOUND,
			);
		}
		if (
			err.status >= HttpStatus.BAD_REQUEST &&
			err.status < HttpStatus.INTERNAL_ERROR
		) {
			return c.json(
				{
					error: {
						code: "VALIDATION_ERROR",
						message: "Cuerpo de la petición inválido.",
						correlationId,
						details: [],
					},
				},
				err.status as 400,
			);
		}
	}

	// Error no manejado: se deja rastro con `correlationId` y el nombre del
	// error para poder rastrearlo en logs. Nunca el mensaje ni el stack:
	// podrian contener SQL, PII o secretos.
	logger?.warn(LogEvent.HTTP_UNHANDLED_ERROR, {
		correlationId,
		errorName: err instanceof Error ? err.name : typeof err,
	});

	// Zod/Hono validator ya responde 400 por su cuenta; esto cubre el resto.
	return c.json(
		{
			error: {
				code: "INTERNAL_ERROR",
				message: "Error interno. Intente de nuevo más tarde.",
				correlationId,
			},
		},
		HttpStatus.INTERNAL_ERROR,
	);
};

/** 404 consistente. */
export const notFoundHandler = (c: AppContext) => {
	return c.json(
		{
			error: {
				code: "NOT_FOUND",
				message: "Recurso no encontrado.",
				correlationId: correlationIdOf(c),
			},
		},
		HttpStatus.NOT_FOUND,
	);
};
