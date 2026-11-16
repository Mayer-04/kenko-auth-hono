import { describe, expect, it } from "vitest";
import { makeRegisterService } from "../../src/features/register/register.service.js";
import type { UserRepository } from "../../src/features/user/user.port.js";
import { AppError } from "../../src/shared/errors.js";

const INPUT = {
	firstName: "Maria Fernanda",
	lastName: "Gomez Rojas",
	birthDate: "1995-03-21",
	gender: "female",
	email: "maria.gomez@example.com",
	phone: "+573001234567",
	addressLine: "Cra 15 # 93-60",
	city: "Bogota",
	documentType: "CC",
	documentNumber: "1020304050",
	password: "correcta-segura-99",
} as const;

const fakeUsers = (
	overrides: Partial<UserRepository> = {},
): UserRepository & {
	created: Array<Parameters<UserRepository["createWithOutbox"]>[0]>;
} => {
	const created: Array<Parameters<UserRepository["createWithOutbox"]>[0]> = [];
	return {
		created,
		findByEmail: async () => null,
		findByDocument: async () => null,
		createWithOutbox: async (args) => {
			created.push(args);
		},
		...overrides,
	};
};

const depsBase = (
	users: UserRepository,
	logger: {
		info: (event: string, ids: Record<string, string>) => void;
		warn: (event: string, ids: Record<string, string>) => void;
	} = {
		info: () => {},
		warn: () => {},
	},
) => ({
	users,
	hasher: {
		hash: async (p: string) => `hashed:${p}`,
		verify: async () => true,
	},
	newUserId: () => "0192b3d1-1a2b-7c3d-8e4f-5a6b7c8d9e0f",
	newEventId: () => "0192b3d1-1a2b-7c3d-8e4f-5a6b7c8d9e10",
	nowIso: () => "2026-10-13T20:15:30.000Z",
	logger,
});

describe("makeRegisterService", () => {
	it("crea usuario + outbox con el contrato UserRegistered", async () => {
		const users = fakeUsers();
		const service = makeRegisterService(depsBase(users));
		const res = await service({ ...INPUT }, "corr-1");

		expect(res.userId).toBe("0192b3d1-1a2b-7c3d-8e4f-5a6b7c8d9e0f");
		expect(res.maskedEmail).toBe("m***@example.com");
		expect(users.created).toHaveLength(1);
		const call = users.created[0];
		expect(call).toBeDefined();
		if (call === undefined) throw new Error("unreachable");
		// No guarda la contrasena en plano.
		expect(call.user.passwordHash).toBe("hashed:correcta-segura-99");
		// Outbox con metadata y datos del contrato.
		expect(call.outbox.eventType).toBe("UserRegistered");
		expect(call.outbox.payload.metadata.eventId).toBe(
			"0192b3d1-1a2b-7c3d-8e4f-5a6b7c8d9e10",
		);
		expect(call.outbox.payload.metadata.correlationId).toBe("corr-1");
		expect(call.outbox.payload.data.userId).toBe(res.userId);
		expect(call.outbox.payload.data.document).toEqual({
			type: "CC",
			number: "1020304050",
		});
		expect(call.outbox.payload.data.contact.emailVerified).toBe(false);
	});

	it("duplicado por email o documento da el mismo 409 generico", async () => {
		const byEmail = fakeUsers({
			findByEmail: async () => ({
				id: "x",
				email: INPUT.email,
				documentType: "CC",
				documentNumber: "1",
				passwordHash: "h",
			}),
		});
		await expect(
			makeRegisterService(depsBase(byEmail))({ ...INPUT }, "c1"),
		).rejects.toMatchObject({
			code: "REGISTER_CONFLICT",
		} satisfies Partial<AppError>);

		const byDoc = fakeUsers({
			findByDocument: async () => ({
				id: "x",
				email: "otra@x.com",
				documentType: "CC",
				documentNumber: INPUT.documentNumber,
				passwordHash: "h",
			}),
		});
		const err = await makeRegisterService(depsBase(byDoc))(
			{ ...INPUT },
			"c2",
		).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(AppError);
		expect((err as AppError).status).toBe(409);
		// El mensaje no distingue el campo (anti-enumeracion).
		expect((err as AppError).message).toBe("No se pudo completar el registro.");
	});

	it("carrera concurrente (23505) se mapea a 409", async () => {
		const users = fakeUsers({
			createWithOutbox: async () => {
				throw Object.assign(new Error("duplicate key"), { code: "23505" });
			},
		});
		await expect(
			makeRegisterService(depsBase(users))({ ...INPUT }, "c3"),
		).rejects.toMatchObject({
			code: "REGISTER_CONFLICT",
		});
	});

	it("exito deja register.succeeded con IDs y sin PII; duplicado deja register.failed", async () => {
		const calls: Array<{
			level: string;
			event: string;
			ids: Record<string, string>;
		}> = [];
		const logger = {
			info: (event: string, ids: Record<string, string>) => {
				calls.push({ level: "info", event, ids });
			},
			warn: (event: string, ids: Record<string, string>) => {
				calls.push({ level: "warn", event, ids });
			},
		};
		const users = fakeUsers();
		await makeRegisterService(depsBase(users, logger))({ ...INPUT }, "corr-9");
		expect(calls).toEqual([
			{
				level: "info",
				event: "register.succeeded",
				ids: {
					userId: "0192b3d1-1a2b-7c3d-8e4f-5a6b7c8d9e0f",
					eventId: "0192b3d1-1a2b-7c3d-8e4f-5a6b7c8d9e10",
					correlationId: "corr-9",
				},
			},
		]);
		expect(JSON.stringify(calls)).not.toContain("maria.gomez@example.com");

		const taken = fakeUsers({
			findByEmail: async () => ({
				id: "x",
				email: INPUT.email,
				documentType: "CC",
				documentNumber: "1",
				passwordHash: "h",
			}),
		});
		const warnCalls: Array<{ event: string; ids: Record<string, string> }> = [];
		await makeRegisterService(
			depsBase(taken, {
				info: () => {},
				warn: (event: string, ids: Record<string, string>) => {
					warnCalls.push({ event, ids });
				},
			}),
		)({ ...INPUT }, "corr-10").catch(() => null);
		expect(warnCalls).toEqual([
			{ event: "register.failed", ids: { correlationId: "corr-10" } },
		]);
	});
});
