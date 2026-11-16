/**
 * Dominio de `account` (gestion autenticada de la cuenta: contrasena y email).
 *
 * A diferencia de `passwordreset` (flujo anonimo con token), aqui el usuario
 * ya esta autenticado: la identidad sale del JWT (`requireAuth`), no del body.
 */

/** Entrada de cambio de contrasena. Sin `confirmPassword`: solo frontend. */
export type ChangePasswordInput = {
	currentPassword: string;
	newPassword: string;
};

/** Resultado: 200 `{data:{}}`. Solo IDs, sin PII ni secretos. */
export type ChangePasswordResult = {
	correlationId: string;
};

/** Resultado de `GET /auth/me`: identidad minima para la UI (sin PII sensible). */
export type MeResult = {
	userId: string;
	firstName: string;
	email: string;
};

/** Entrada de cambio de email. La identidad sale del JWT, no del body. */
export type ChangeEmailInput = {
	newEmail: string;
	currentPassword: string;
};

/** Resultado: 200 con cuerpo vacio. Solo IDs, sin PII. */
export type ChangeEmailResult = {
	correlationId: string;
	/** `false` cuando el correo ya era el mismo (idempotente, sin escritura). */
	changed: boolean;
};

/** Contenido de `Detail` del evento `EmailChanged` (contrato v1). */
export type EmailChangedDetail = {
	metadata: {
		eventId: string;
		eventVersion: "1";
		occurredAt: string;
		correlationId: string;
	};
	data: {
		userId: string;
		oldEmail: string;
		newEmail: string;
		firstName: string;
	};
};
