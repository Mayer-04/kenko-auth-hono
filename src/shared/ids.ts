import { v7 as uuidv7 } from "uuid";

/**
 * Genera identificadores UUID v7 (ordenables por tiempo).
 *
 * Decision confirmada (AGENTS.md 6.3): v7 para los IDs que genera el
 * microservicio. No usar v4. `userId` y `eventId` son independientes:
 * cada uno se genera con una llamada distinta.
 */
export const newId = (): string => {
	return uuidv7();
};

/** Valida formato UUID sin lanzar. */
export const isUuid = (value: string): boolean => {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
		value,
	);
};
