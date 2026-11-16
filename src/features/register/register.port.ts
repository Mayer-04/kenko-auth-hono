import type { UserRepository } from "../user/user.port.js";
import type { RegisterInput, RegisterResult } from "./register.types.js";

/**
 * Puertos que el caso de uso necesita. `features/` declara interfaces;
 * `container.ts` inyecta implementaciones de `infra/`.
 * La persistencia (`UserRepository`) vive en `features/user`.
 */

export type PasswordHasher = {
	hash(password: string): Promise<string>;
	verify(hash: string, password: string): Promise<boolean>;
};

/**
 * Logger minimo del registro (solo IDs, sin PII: nada de email, documento,
 * telefono ni password aunque esten en el input).
 */
export type RegisterLogger = {
	info(event: string, ids: Record<string, string>): void;
	warn(event: string, ids: Record<string, string>): void;
};

export type RegisterDeps = {
	users: UserRepository;
	hasher: PasswordHasher;
	newUserId: () => string;
	newEventId: () => string;
	nowIso: () => string;
	logger: RegisterLogger;
};

export type RegisterService = (
	input: RegisterInput,
	correlationId: string,
) => Promise<RegisterResult>;
