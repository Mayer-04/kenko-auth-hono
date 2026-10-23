import { describe, expect, it } from "vitest";
import type {
	ForgotDeps,
	PasswordResetLogger,
	PasswordResetRepository,
	ResetDeps,
} from "../../src/features/passwordreset/passwordreset.port.js";
import {
	buildResetUrl,
	makeForgotPasswordService,
	makeResetPasswordService,
} from "../../src/features/passwordreset/passwordreset.service.js";
import type { PasswordResetRequestedDetail } from "../../src/features/passwordreset/passwordreset.types.js";
import { AppError } from "../../src/shared/errors.js";

/**
 * Pruebas unitarias de los casos de uso con fakes: sin DB ni AWS.
 * Cubren anti-enumeracion, contrato del evento, invalidacion de tokens,
 * politica de contrasena y consumo atomico (carrera).
 */

const USER_ID = "0192b3d1-1a2b-7c3d-8e4f-5a6b7c8d9e0f";
const EVENT_ID = "0192b3d1-1a2b-7c3d-8e4f-5a6b7c8d9e10";
const TOKEN_ID = "0192b3d1-1a2b-7c3d-8e4f-5a6b7c8d9e11";
const NOW = new Date("2026-10-13T20:15:30.000Z");

type Captured = { level: string; event: string; ids: Record<string, string> };

const capturingLogger = (): {
	logger: PasswordResetLogger;
	entries: Captured[];
} => {
	const entries: Captured[] = [];
	return {
		entries,
		logger: {
			info: (event, ids) => {
				entries.push({ level: "info", event, ids });
			},
			warn: (event, ids) => {
				entries.push({ level: "warn", event, ids });
			},
		},
	};
};

const fakeTokenTool = {
	generate: () => "token-generado-opaco-123",
	hash: (token: string) => `sha256:${token}`,
};

const fakeTokens = (
	overrides: Partial<PasswordResetRepository> = {},
): PasswordResetRepository & {
	created: Array<
		Parameters<PasswordResetRepository["createTokenWithOutbox"]>[0]
	>;
} => {
	const created: Array<
		Parameters<PasswordResetRepository["createTokenWithOutbox"]>[0]
	> = [];
	return {
		created,
		createTokenWithOutbox: async (args) => {
			created.push(args);
		},
		findActiveTokenByHash: async () => null,
		consumeTokenAndUpdatePassword: async () => true,
		...overrides,
	};
};

const existingUser = {
	id: USER_ID,
	email: "maria.gomez@example.com",
	firstName: "Maria Fernanda",
};

const forgotDeps = (tokens: PasswordResetRepository): ForgotDeps => ({
	users: {
		findByDocument: async () => existingUser,
		findUserById: async () => null,
	},
	tokens,
	tokenTool: fakeTokenTool,
	newTokenId: () => TOKEN_ID,
	newEventId: () => EVENT_ID,
	now: () => NOW,
	ttlMinutes: 30,
	baseUrl: "http://localhost:8080",
	logger: capturingLogger().logger,
});

describe("buildResetUrl", () => {
	it("pone el token en el fragmento y tolera barra final", () => {
		expect(buildResetUrl("http://localhost:8080", "abc")).toBe(
			"http://localhost:8080/reset#token=abc",
		);
		expect(buildResetUrl("http://localhost:8080/", "abc")).toBe(
			"http://localhost:8080/reset#token=abc",
		);
	});
});

describe("makeForgotPasswordService", () => {
	it("crea token + outbox con el contrato PasswordResetRequested v1", async () => {
		const tokens = fakeTokens();
		const service = makeForgotPasswordService(forgotDeps(tokens));

		const res = await service(
			{ documentType: "CC", documentNumber: "1020304050" },
			"corr-1",
		);

		expect(res).toEqual({ correlationId: "corr-1" });
		expect(tokens.created).toHaveLength(1);
		const call = tokens.created[0];
		if (call === undefined) throw new Error("unreachable");

		// La DB recibe SOLO el hash; el token en claro no se persiste aqui.
		expect(call.token).toEqual({
			id: TOKEN_ID,
			userId: USER_ID,
			tokenHash: "sha256:token-generado-opaco-123",
			expiresAt: "2026-10-13T20:45:30.000Z",
			correlationId: "corr-1",
		});

		// Evento: metadata + data exactos, sin token suelto (solo en resetUrl).
		expect(call.outbox.eventType).toBe("PasswordResetRequested");
		expect(call.outbox.eventVersion).toBe("1");
		expect(call.outbox.eventId).toBe(EVENT_ID);
		expect(call.outbox.correlationId).toBe("corr-1");
		const payload: PasswordResetRequestedDetail = call.outbox.payload;
		expect(Object.keys(payload).sort()).toEqual(["data", "metadata"]);
		expect(Object.keys(payload.metadata).sort()).toEqual([
			"correlationId",
			"eventId",
			"eventVersion",
			"occurredAt",
		]);
		expect(Object.keys(payload.data).sort()).toEqual([
			"email",
			"expiresAt",
			"firstName",
			"resetUrl",
			"userId",
		]);
		expect(payload.metadata.eventVersion).toBe("1");
		expect(payload.data.userId).toBe(USER_ID);
		expect(payload.data.resetUrl).toBe(
			"http://localhost:8080/reset#token=token-generado-opaco-123",
		);
		// Expiracion: now + TTL minutos.
		expect(payload.data.expiresAt).toBe("2026-10-13T20:45:30.000Z");
	});

	it("usuario inexistente: no escribe nada y devuelve el mismo resultado", async () => {
		const tokens = fakeTokens();
		const service = makeForgotPasswordService({
			...forgotDeps(tokens),
			users: {
				findByDocument: async () => null,
				findUserById: async () => null,
			},
		});

		const res = await service(
			{ documentType: "CC", documentNumber: "9999999999" },
			"corr-2",
		);

		expect(res).toEqual({ correlationId: "corr-2" });
		expect(tokens.created).toHaveLength(0);
	});

	it("los logs nunca contienen token, email ni documento (solo IDs)", async () => {
		const { logger, entries } = capturingLogger();
		const tokens = fakeTokens();
		const service = makeForgotPasswordService({
			...forgotDeps(tokens),
			logger,
		});

		await service(
			{ documentType: "CC", documentNumber: "1020304050" },
			"corr-3",
		);

		expect(entries).toHaveLength(1);
		const serialized = JSON.stringify(entries);
		expect(serialized).not.toContain("token-generado-opaco-123");
		expect(serialized).not.toContain("localhost:8080/reset");
		expect(serialized).not.toContain("maria.gomez@example.com");
		expect(serialized).not.toContain("1020304050");
		expect(entries[0]?.ids).toEqual({
			userId: USER_ID,
			eventId: EVENT_ID,
			correlationId: "corr-3",
		});
	});
});

describe("makeResetPasswordService", () => {
	const resetDeps = (
		overrides: Partial<Omit<ResetDeps, "tokens">> & {
			tokens?: ReturnType<typeof fakeTokens>;
		} = {},
	): ResetDeps & { tokens: ReturnType<typeof fakeTokens> } => ({
		users: {
			findByDocument: async () => null,
			findUserById: async () => ({ id: USER_ID, passwordHash: "hash:actual" }),
		},
		tokens: fakeTokens(),
		hasher: {
			hash: async (p: string) => `hashed:${p}`,
			verify: async (hash, p) => hash === `hashed:${p}`,
		},
		tokenTool: fakeTokenTool,
		logger: capturingLogger().logger,
		...overrides,
	});

	it("exito: consume el token y cambia la contrasena", async () => {
		const consumed: Array<{
			tokenHash: string;
			userId: string;
			passwordHash: string;
		}> = [];
		const tokens = fakeTokens({
			findActiveTokenByHash: async () => ({ userId: USER_ID }),
			consumeTokenAndUpdatePassword: async (args) => {
				consumed.push(args);
				return true;
			},
		});
		const service = makeResetPasswordService(resetDeps({ tokens }));

		const res = await service(
			{ token: "token-generado-opaco-123", password: "nueva-contrasena-77" },
			"corr-4",
		);

		expect(res).toEqual({ correlationId: "corr-4" });
		expect(consumed).toEqual([
			{
				tokenHash: "sha256:token-generado-opaco-123",
				userId: USER_ID,
				passwordHash: "hashed:nueva-contrasena-77",
			},
		]);
	});

	it("token invalido, expirado o usado: un unico error generico", async () => {
		const service = makeResetPasswordService(
			resetDeps({
				tokens: fakeTokens({ findActiveTokenByHash: async () => null }),
			}),
		);

		const err = await service(
			{ token: "token-basura", password: "nueva-contrasena-77" },
			"corr-5",
		).catch((e: unknown) => e);

		expect(err).toBeInstanceOf(AppError);
		expect((err as AppError).code).toBe("PASSWORD_RESET_INVALID");
		expect((err as AppError).message).toBe(
			"El enlace de restablecimiento no es valido o ha expirado.",
		);
	});

	it("carrera perdida (otro request consumo el token): mismo error generico", async () => {
		const service = makeResetPasswordService(
			resetDeps({
				tokens: fakeTokens({
					findActiveTokenByHash: async () => ({ userId: USER_ID }),
					consumeTokenAndUpdatePassword: async () => false,
				}),
			}),
		);

		await expect(
			service(
				{ token: "token-generado-opaco-123", password: "nueva-contrasena-77" },
				"corr-6",
			),
		).rejects.toMatchObject({ code: "PASSWORD_RESET_INVALID" });
	});

	it("no reutilizar la contrasena actual: VALIDATION_ERROR sin consumir el token", async () => {
		let consumedTimes = 0;
		const tokens = fakeTokens({
			findActiveTokenByHash: async () => ({ userId: USER_ID }),
			consumeTokenAndUpdatePassword: async () => {
				consumedTimes += 1;
				return true;
			},
		});
		const service = makeResetPasswordService(
			resetDeps({
				tokens,
				hasher: {
					hash: async (p: string) => `hashed:${p}`,
					// La contrasena propuesta coincide con el hash vigente.
					verify: async (hash, p) =>
						hash === "hash:actual" && p === "actual-contrasena-1",
				},
			}),
		);

		await expect(
			service(
				{ token: "token-generado-opaco-123", password: "actual-contrasena-1" },
				"corr-7",
			),
		).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
		expect(consumedTimes).toBe(0);
	});

	it("los logs de exito solo llevan IDs, jamas token ni password", async () => {
		const { logger, entries } = capturingLogger();
		const service = makeResetPasswordService(
			resetDeps({
				tokens: fakeTokens({
					findActiveTokenByHash: async () => ({ userId: USER_ID }),
					consumeTokenAndUpdatePassword: async () => true,
				}),
				logger,
			}),
		);

		await service(
			{ token: "token-generado-opaco-123", password: "nueva-contrasena-77" },
			"corr-8",
		);

		const serialized = JSON.stringify(entries);
		expect(serialized).not.toContain("token-generado-opaco-123");
		expect(serialized).not.toContain("nueva-contrasena-77");
		expect(entries[0]?.ids).toEqual({
			userId: USER_ID,
			correlationId: "corr-8",
		});
	});
});
