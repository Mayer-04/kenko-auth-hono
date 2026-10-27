import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";

import { AppError, internalError } from "../../shared/errors.js";
import { CORRELATION_ID_HEADER } from "../../shared/headers.js";
import { type AppVariables, created } from "../../shared/http.js";
import { isUuid, newId } from "../../shared/ids.js";
import { validationErrorHook } from "../../shared/validation.js";
import type { Gender } from "../user/user.types.js";
import type { RegisterService } from "./register.port.js";
import { RegisterSchema } from "./register.schema.js";

/**
 * `POST /auth/register`.
 *
 * - Valida con Zod (`@hono/zod-validator`), responde 201 `{ data: { userId } }`.
 * - `correlationId`: reutiliza `X-Correlation-Id` si es UUID, si no genera v7.
 *   Viaja en respuesta y a logs/servicio/evento.
 * - Errores de negocio (409 generico) via `AppError`; el handler central
 *   les da forma. Nunca se loguea el cuerpo ni PII.
 */
export const makeRegisterRoute = (
	service: RegisterService,
): Hono<{ Variables: AppVariables }> => {
	const route = new Hono<{ Variables: AppVariables }>();

	route.post(
		"/auth/register",
		zValidator("json", RegisterSchema, validationErrorHook),
		async (c) => {
			const header = c.req.header(CORRELATION_ID_HEADER);
			const correlationId =
				header !== undefined && isUuid(header) ? header : newId();
			c.set("correlationId", correlationId);
			c.header(CORRELATION_ID_HEADER, correlationId);

			const body = c.req.valid("json");
			const result = await service(
				{
					firstName: body.firstName,
					lastName: body.lastName,
					birthDate: body.birthDate,
					gender: body.gender as Gender,
					email: body.email,
					phone: body.phone,
					addressLine: body.addressLine,
					city: body.city,
					documentType: body.documentType,
					documentNumber: body.documentNumber,
					password: body.password,
				},
				correlationId,
			).catch((err: unknown) => {
				if (err instanceof AppError) throw err;
				throw internalError(correlationId, err);
			});

			return created(c, { userId: result.userId });
		},
	);

	return route;
};
