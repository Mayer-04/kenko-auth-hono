import { describe, expect, it } from "vitest";
import type {
	AccountStore,
	ChangePasswordDeps,
	EmailChangeDeps,
} from "../../src/features/account/account.port.js";
import {
	makeChangeEmailService,
	makeChangePasswordService,
} from "../../src/features/account/account.service.js";
import { AppError } from "../../src/shared/errors.js";

const ACCOUNT = {
	id: "user-id-1",
	email: "maria.gomez@example.com",
	firstName: "Maria Fernanda",
	lastName: "Gomez Rojas",
	passwordHash: "stored-hash",
};

const fakeStore = (
	overrides: { account?: typeof ACCOUNT | null; changed?: boolean } = {},
): AccountStore & {
	calls: Array<Parameters<AccountStore["changePasswordAndRevokeOthers"]>[0]>;
} => {
	const calls: Array<
		Parameters<AccountStore["changePasswordAndRevokeOthers"]>[0]
	> = [];
	return {
		calls,
		findAccountById: async (id: string) =>
			overrides.account === undefined ? { ...ACCOUNT, id } : overrides.account,
		changePasswordAndRevokeOthers: async (args) => {
			calls.push(args);
			return overrides.changed ?? true;
		},
	};
};

const depsBase = (
	overrides: {
		account?: typeof ACCOUNT | null;
		changed?: boolean;
		passwordOk?: boolean;
	} = {},
): { deps: ChangePasswordDeps; store: ReturnType<typeof fakeStore> } => {
	const store = fakeStore(overrides);
	const deps: ChangePasswordDeps = {
		users: store,
		hasher: {
			hash: async (p: string) => `hashed:${p}`,
			verify: async (_hash: string, password: string) =>
				overrides.passwordOk ?? password === "clave-actual-99",
		},
		logger: { info: () => {}, warn: () => {} },
	};
	return { deps, store };
};

describe("makeChangePasswordService", () => {
	it("contrasena valida: hashea, revoca otras familias y conserva la actual", async () => {
		const { deps, store } = depsBase();
		const res = await makeChangePasswordService(deps)(
			{ currentPassword: "clave-actual-99", newPassword: "nueva-clave-00" },
			"user-id-1",
			"family-actual",
			"corr-1",
		);
		expect(res).toEqual({ correlationId: "corr-1" });
		expect(store.calls).toHaveLength(1);
		expect(store.calls[0]).toEqual({
			userId: "user-id-1",
			passwordHash: "hashed:nueva-clave-00",
			keepFamilyId: "family-actual",
			correlationId: "corr-1",
		});
	});

	it("actual incorrecta o usuario inexistente: mismo 401 especifico", async () => {
		const wrong = depsBase({ passwordOk: false });
		const missing = depsBase({ account: null });

		const errs = await Promise.all(
			[wrong, missing].map(({ deps }) =>
				makeChangePasswordService(deps)(
					{ currentPassword: "x", newPassword: "nueva-clave-00" },
					"user-id-1",
					"family-actual",
					"c",
				).catch((e: unknown) => e),
			),
		);
		for (const err of errs) {
			expect(err).toBeInstanceOf(AppError);
			expect((err as AppError).code).toBe("UNAUTHORIZED");
			expect((err as AppError).message).toBe("Contrasena actual incorrecta.");
		}
		expect(wrong.store.calls).toHaveLength(0);
		expect(missing.store.calls).toHaveLength(0);
	});

	it("nueva igual a la actual: 400 sin guardar (fast-path, sin 2.º Argon2)", async () => {
		const { deps, store } = depsBase({ passwordOk: false });
		let calls = 0;
		deps.hasher.verify = async () => {
			calls++;
			return calls === 1;
		};
		const err = await makeChangePasswordService(deps)(
			{ currentPassword: "clave-actual-99", newPassword: "clave-actual-99" },
			"user-id-1",
			"family-actual",
			"c",
		).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(AppError);
		expect((err as AppError).code).toBe("VALIDATION_ERROR");
		expect(calls).toBe(1);
		expect(store.calls).toHaveLength(0);
	});

	it("nueva con el correo o el nombre: 400 sin guardar", async () => {
		const { deps, store } = depsBase();
		for (const newPassword of [
			"xxMARIA.GOMEZ@EXAMPLE.COMxx",
			"xxgomez rojasxx",
		]) {
			const err = await makeChangePasswordService(deps)(
				{ currentPassword: "clave-actual-99", newPassword },
				"user-id-1",
				"family-actual",
				"c",
			).catch((e: unknown) => e);
			expect(err).toBeInstanceOf(AppError);
			expect((err as AppError).code).toBe("VALIDATION_ERROR");
		}
		expect(store.calls).toHaveLength(0);
	});

	it("si el usuario desaparece al guardar: 401 generico", async () => {
		const { deps } = depsBase({ changed: false });
		const err = await makeChangePasswordService(deps)(
			{ currentPassword: "clave-actual-99", newPassword: "nueva-clave-00" },
			"user-id-1",
			undefined,
			"c",
		).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(AppError);
		expect((err as AppError).code).toBe("UNAUTHORIZED");
	});
});

const emailDepsBase = (
	overrides: {
		account?: typeof ACCOUNT | null;
		takenBy?: string | null;
		updated?: boolean;
		uniqueRace?: boolean;
		passwordOk?: boolean;
	} = {},
): {
	deps: EmailChangeDeps;
	updated: Array<{
		userId: string;
		newEmail: string;
		eventType: string;
		oldEmail: string;
	}>;
} => {
	const updated: Array<{
		userId: string;
		newEmail: string;
		eventType: string;
		oldEmail: string;
	}> = [];
	const deps: EmailChangeDeps = {
		users: {
			findAccountById: async (id: string) =>
				overrides.account === undefined
					? { ...ACCOUNT, id }
					: overrides.account,
			findByEmail: async (email: string) => {
				if (overrides.takenBy === undefined) return null;
				if (overrides.takenBy === null) return null;
				return email === "tomado@example.com"
					? { id: overrides.takenBy }
					: null;
			},
			updateEmailWithOutbox: async ({ userId, newEmail, outbox }) => {
				if (overrides.uniqueRace === true) {
					const err = new Error("duplicate") as Error & { code: string };
					err.code = "23505";
					throw err;
				}
				updated.push({
					userId,
					newEmail,
					eventType: outbox.eventType,
					oldEmail: outbox.payload.data.oldEmail,
				});
				return overrides.updated ?? true;
			},
		},
		hasher: {
			hash: async (p: string) => `hashed:${p}`,
			verify: async (_hash: string, password: string) =>
				overrides.passwordOk ?? password === "clave-actual-99",
		},
		newEventId: () => "event-id-1",
		nowIso: () => "2026-10-26T10:00:00.000Z",
		logger: { info: () => {}, warn: () => {} },
	};
	return { deps, updated };
};

describe("makeChangeEmailService", () => {
	it("correo libre: actualiza y publica EmailChanged con el anterior", async () => {
		const { deps, updated } = emailDepsBase();
		const res = await makeChangeEmailService(deps)(
			{
				newEmail: "maria.nuevo@example.com",
				currentPassword: "clave-actual-99",
			},
			"user-id-1",
			"corr-1",
		);
		expect(res).toEqual({ correlationId: "corr-1" });
		expect(updated).toEqual([
			{
				userId: "user-id-1",
				newEmail: "maria.nuevo@example.com",
				eventType: "EmailChanged",
				oldEmail: "maria.gomez@example.com",
			},
		]);
	});

	it("mismo correo: 200 idempotente sin escribir", async () => {
		const { deps, updated } = emailDepsBase();
		const res = await makeChangeEmailService(deps)(
			{
				newEmail: "maria.gomez@example.com",
				currentPassword: "clave-actual-99",
			},
			"user-id-1",
			"corr-1",
		);
		expect(res).toEqual({ correlationId: "corr-1" });
		expect(updated).toHaveLength(0);
	});

	it("actual incorrecta o cuenta inexistente: mismo 401", async () => {
		const wrong = emailDepsBase({ passwordOk: false });
		const missing = emailDepsBase({ account: null });
		for (const { deps, updated } of [wrong, missing]) {
			const err = await makeChangeEmailService(deps)(
				{ newEmail: "nuevo@example.com", currentPassword: "x" },
				"user-id-1",
				"c",
			).catch((e: unknown) => e);
			expect(err).toBeInstanceOf(AppError);
			expect((err as AppError).code).toBe("UNAUTHORIZED");
			expect((err as AppError).message).toBe("Contrasena actual incorrecta.");
			expect(updated).toHaveLength(0);
		}
	});

	it("correo ocupado o carrera 23505: mismo 409 generico", async () => {
		const taken = emailDepsBase({ takenBy: "other-user" });
		const errTaken = await makeChangeEmailService(taken.deps)(
			{ newEmail: "tomado@example.com", currentPassword: "clave-actual-99" },
			"user-id-1",
			"c",
		).catch((e: unknown) => e);
		expect(errTaken).toBeInstanceOf(AppError);
		expect((errTaken as AppError).code).toBe("UPDATE_CONFLICT");
		expect((errTaken as AppError).message).toBe(
			"No se pudo completar el cambio.",
		);
		expect(taken.updated).toHaveLength(0);

		const race = emailDepsBase({ uniqueRace: true });
		const errRace = await makeChangeEmailService(race.deps)(
			{ newEmail: "libre@example.com", currentPassword: "clave-actual-99" },
			"user-id-1",
			"c",
		).catch((e: unknown) => e);
		expect((errRace as AppError).code).toBe("UPDATE_CONFLICT");
		expect(race.updated).toHaveLength(0);
	});
});
