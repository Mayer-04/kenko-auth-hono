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

export type RegisterDeps = {
	users: UserRepository;
	hasher: PasswordHasher;
	newUserId: () => string;
	newEventId: () => string;
	nowIso: () => string;
};

export type RegisterService = (
	input: RegisterInput,
	correlationId: string,
) => Promise<RegisterResult>;
