import type { Context } from "hono";

import { AppError } from "./errors.js";
import { HttpStatus } from "./http-status.js";

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

/** Manejador central de errores para `app.onError`. */
export const errorHandler = (err: unknown, c: AppContext) => {
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
