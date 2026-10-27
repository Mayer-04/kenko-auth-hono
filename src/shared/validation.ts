import type { Context } from "hono";
import { z } from "zod";

import { HttpStatus } from "./http-status.js";

/**
 * Mensajes de Zod por defecto en español.
 *
 * Se aplica una vez, a nivel de proceso, al importar este modulo (que ya
 * importan todas las rutas). Solo afecta a los mensajes generados por Zod;
 * los mensajes personalizados de cada esquema quedan intactos. Asi un campo
 * ausente tambien responde en español en vez del ingles por defecto.
 */
z.config(z.locales.es());

/**
 * Hook de error para `zValidator` de `@hono/zod-validator`.
 *
 * Sin hook, el validador responde su propio formato
 * (`{"success":false,"error":{"name":"ZodError",...}}`) y salta el
 * `errorHandler` central: los 400 de forma no usaban el sobre
 * `{error:{code,message,correlationId}}` del resto de la API.
 *
 * Con este hook, TODOS los errores comparten el sobre: `400`
 * `VALIDATION_ERROR` con el primer mensaje de Zod (redactado por nosotros
 * en cada esquema, seguro para el cliente) y el `correlationId`.
 * Se pasa como tercer argumento de cada `zValidator(...)`.
 */

type ValidationResult = {
	success: boolean;
	error?: {
		issues?: Array<{ message?: unknown }>;
	};
};

const FALLBACK_MESSAGE = "Datos inválidos.";

const firstMessage = (result: ValidationResult): string => {
	const issues = result.error?.issues ?? [];
	for (const issue of issues) {
		if (typeof issue.message === "string" && issue.message !== "") {
			return issue.message;
		}
	}
	return FALLBACK_MESSAGE;
};

export const validationErrorHook = (
	result: ValidationResult,
	c: Context,
): Response | undefined => {
	if (result.success) return undefined;

	const raw = c.get("correlationId");
	const correlationId = typeof raw === "string" ? raw : "unknown";

	return c.json(
		{
			error: {
				code: "VALIDATION_ERROR",
				message: firstMessage(result),
				correlationId,
			},
		},
		HttpStatus.BAD_REQUEST,
	);
};
