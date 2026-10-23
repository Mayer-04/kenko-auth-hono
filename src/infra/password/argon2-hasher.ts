import { hash as argonHash, verify as argonVerify } from "argon2";

import type { PasswordHasher } from "../../features/register/register.port.js";
import {
	ARGON2_MEMORY_COST_KIB,
	ARGON2_PARALLELISM,
	ARGON2_TIME_COST,
} from "./argon2.constants.js";

/**
 * Argon2id para contrasenas.
 *
 * Parametros iniciales (OWASP Password Storage, configurables por constructor):
 * - memoria 19456 KiB (~19 MiB), iteraciones 2, paralelismo 1.
 * Equilibran seguridad y coste para dev; en prod se ajustan por env.
 * Nunca se loguea la contrasena ni el hash.
 */

export type Argon2Options = {
	memoryCost?: number;
	timeCost?: number;
	parallelism?: number;
};

const DEFAULTS = {
	memoryCost: ARGON2_MEMORY_COST_KIB,
	timeCost: ARGON2_TIME_COST,
	parallelism: ARGON2_PARALLELISM,
} as const;

export const makeArgon2Hasher = (
	options: Argon2Options = {},
): PasswordHasher => {
	const memoryCost = options.memoryCost ?? DEFAULTS.memoryCost;
	const timeCost = options.timeCost ?? DEFAULTS.timeCost;
	const parallelism = options.parallelism ?? DEFAULTS.parallelism;

	return {
		async hash(password: string): Promise<string> {
			return argonHash(password, {
				type: 2,
				memoryCost,
				timeCost,
				parallelism,
			});
		},
		async verify(storedHash: string, password: string): Promise<boolean> {
			return argonVerify(storedHash, password);
		},
	};
};
