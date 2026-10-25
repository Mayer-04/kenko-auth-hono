import { describe, expect, it } from "vitest";
import type {
	LoginDeps,
	LogoutDeps,
	RefreshDeps,
	RefreshSessionStore,
} from "../../src/features/login/login.port.js";
import {
	makeLoginService,
	makeLogoutService,
	makeRefreshSessionService,
} from "../../src/features/login/login.service.js";
import { AppError } from "../../src/shared/errors.js";

const INPUT = {
	documentType: "CC",
	documentNumber: "1020304050",
	password: "correcta-segura-99",
} as const;

const NOW = new Date("2026-10-24T12:00:00.000Z");

const fakeSessions = (
	seeds: Array<{
		id: string;
		userId: string;
		familyId: string;
		tokenHash: string;
		status: "active" | "rotated" | "revoked";
		expiresAt: string;
	}> = [],
): RefreshSessionStore & {
	created: Array<Parameters<RefreshSessionStore["createLoginSession"]>[0]>;
	revokedUsers: string[];
	revokedFamilies: string[];
	rotated: Array<{ oldId: string; userId: string }>;
	byHash: Map<string, (typeof seeds)[number]>;
} => {
	const created: Array<
		Parameters<RefreshSessionStore["createLoginSession"]>[0]
	> = [];
	const revokedUsers: string[] = [];
	const revokedFamilies: string[] = [];
	const rotated: Array<{ oldId: string; userId: string }> = [];
	// Copia defensiva: la rotacion muta el estado interno sin tocar al llamador.
	const byHash = new Map(seeds.map((s) => [s.tokenHash, { ...s }]));
	return {
		created,
		revokedUsers,
		revokedFamilies,
		rotated,
		byHash,
		createLoginSession: async (args) => {
			created.push(args);
		},
		findSessionByTokenHash: async (tokenHash) => byHash.get(tokenHash) ?? null,
		rotateSession: async ({ oldId, userId, newSession }) => {
			rotated.push({ oldId, userId });
			const current = [...byHash.values()].find((s) => s.id === oldId);
			if (current === undefined || current.status !== "active") return false;
			current.status = "rotated";
			const next = {
				id: newSession.id,
				userId,
				familyId: newSession.familyId,
				tokenHash: newSession.tokenHash,
				status: "active" as const,
				expiresAt: newSession.expiresAt,
			};
			byHash.set(next.tokenHash, next);
			return true;
		},
		revokeFamily: async (familyId) => {
			revokedFamilies.push(familyId);
		},
		revokeAllUserSessions: async (userId) => {
			revokedUsers.push(userId);
		},
	};
};

const depsBase = (
	overrides: {
		user?: { id: string; passwordHash: string } | null;
		passwordOk?: boolean;
	} = {},
): { deps: LoginDeps; sessions: ReturnType<typeof fakeSessions> } => {
	const sessions = fakeSessions();
	const deps: LoginDeps = {
		users: {
			findByDocument: async () =>
				overrides.user === undefined
					? { id: "user-id-1", passwordHash: "stored-hash" }
					: overrides.user,
		},
		sessions,
		hasher: {
			hash: async (p: string) => `hashed:${p}`,
			verify: async () => overrides.passwordOk ?? true,
		},
		accessTokens: {
			signAccessToken: async (args) => `signed:${args.subject}:${args.tokenId}`,
		},
		refreshTokens: {
			generate: () => "raw-refresh-token",
			hash: (t: string) => `hash:${t}`,
			equals: (a: string, b: string) => a === b,
		},
		newSessionId: () => "session-id-1",
		newFamilyId: () => "family-id-1",
		newJwtId: () => "jwt-id-1",
		now: () => NOW,
		accessTtlSeconds: 900,
		refreshTtlDays: 7,
		logger: { info: () => {}, warn: () => {} },
	};
	return { deps, sessions };
};

describe("makeLoginService", () => {
	it("credenciales validas: emite tokens y persiste la sesion inicial", async () => {
		const { deps, sessions } = depsBase();
		const service = makeLoginService(deps);
		const res = await service({ ...INPUT }, "corr-1");

		expect(res.accessToken).toBe("signed:user-id-1:jwt-id-1");
		expect(res.refreshToken).toBe("raw-refresh-token");
		expect(res.expiresIn).toBe(900);
		expect(sessions.created).toHaveLength(1);
		const call = sessions.created[0];
		expect(call).toBeDefined();
		if (call === undefined) throw new Error("unreachable");
		// Nunca el refresh en claro: solo su hash, familia nueva y activa.
		expect(call.userId).toBe("user-id-1");
		expect(call.familyId).toBe("family-id-1");
		expect(call.tokenHash).toBe("hash:raw-refresh-token");
		expect(call.status).toBe("active");
		expect(call.expiresAt).toBe(
			new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
		);
		expect(call.correlationId).toBe("corr-1");
	});

	it("usuario inexistente y contrasena incorrecta dan el mismo 401 generico", async () => {
		const unknown = depsBase({ user: null });
		const wrongPassword = depsBase({ passwordOk: false });

		const errUnknown = await makeLoginService(unknown.deps)(
			{ ...INPUT },
			"corr-1",
		).catch((err: unknown) => err);
		const errWrong = await makeLoginService(wrongPassword.deps)(
			{ ...INPUT },
			"corr-1",
		).catch((err: unknown) => err);

		for (const err of [errUnknown, errWrong]) {
			expect(err).toBeInstanceOf(AppError);
			expect((err as AppError).code).toBe("UNAUTHORIZED");
		}
		// Anti-enumeracion: el mensaje no distingue el motivo.
		expect((errUnknown as AppError).message).toBe(
			(errWrong as AppError).message,
		);
		// Sin sesion persistida en ningun caso de fallo.
		expect(unknown.sessions.created).toHaveLength(0);
		expect(wrongPassword.sessions.created).toHaveLength(0);
	});

	it("verifica la contrasena contra el hash almacenado", async () => {
		let seen: { hash: string; password: string } | undefined;
		const { deps } = depsBase();
		deps.hasher = {
			hash: async (p: string) => `hashed:${p}`,
			verify: async (hash: string, password: string) => {
				seen = { hash, password };
				return true;
			},
		};
		await makeLoginService(deps)({ ...INPUT }, "corr-1");
		expect(seen).toEqual({
			hash: "stored-hash",
			password: "correcta-segura-99",
		});
	});

	it("firma el access con sub, jti y ventana de 15 minutos", async () => {
		let signed:
			| {
					subject: string;
					tokenId: string;
					issuedAtSeconds: number;
					expiresAtSeconds: number;
			  }
			| undefined;
		const { deps } = depsBase();
		deps.accessTokens = {
			signAccessToken: async (args) => {
				signed = args;
				return "signed";
			},
		};
		await makeLoginService(deps)({ ...INPUT }, "corr-1");
		expect(signed?.subject).toBe("user-id-1");
		expect(signed?.tokenId).toBe("jwt-id-1");
		expect(
			(signed?.expiresAtSeconds ?? 0) - (signed?.issuedAtSeconds ?? 0),
		).toBe(900);
	});
});

const refreshDepsBase = (
	seeds: Parameters<typeof fakeSessions>[0] = [],
): { deps: RefreshDeps; sessions: ReturnType<typeof fakeSessions> } => {
	const sessions = fakeSessions(seeds);
	const deps: RefreshDeps = {
		sessions,
		accessTokens: {
			signAccessToken: async (args) => `signed:${args.subject}:${args.tokenId}`,
		},
		refreshTokens: {
			generate: () => "raw-refresh-new",
			hash: (t: string) => `hash:${t}`,
			equals: (a: string, b: string) => a === b,
		},
		newSessionId: () => "session-id-new",
		newJwtId: () => "jwt-id-new",
		now: () => NOW,
		accessTtlSeconds: 900,
		refreshTtlDays: 7,
		logger: { info: () => {}, warn: () => {} },
	};
	return { deps, sessions };
};

const ACTIVE_SEED = {
	id: "session-old",
	userId: "user-id-1",
	familyId: "family-id-1",
	tokenHash: "hash:raw-old",
	status: "active" as const,
	expiresAt: new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
};

const errOf = async (promise: Promise<unknown>): Promise<AppError> => {
	const err = await promise.catch((e: unknown) => e);
	expect(err).toBeInstanceOf(AppError);
	return err as AppError;
};

describe("makeRefreshSessionService", () => {
	it("token activo y vigente: rota y devuelve par nuevo", async () => {
		const { deps, sessions } = refreshDepsBase([ACTIVE_SEED]);
		const res = await makeRefreshSessionService(deps)(
			{ refreshToken: "raw-old" },
			"corr-1",
		);

		expect(res.accessToken).toBe("signed:user-id-1:jwt-id-new");
		expect(res.refreshToken).toBe("raw-refresh-new");
		expect(res.expiresIn).toBe(900);
		// Anterior marcada como rotada y sucesora en la misma familia.
		expect(sessions.rotated).toEqual([
			{ oldId: "session-old", userId: "user-id-1" },
		]);
		const next = sessions.byHash.get("hash:raw-refresh-new");
		expect(next?.familyId).toBe("family-id-1");
		expect(next?.status).toBe("active");
		expect(sessions.revokedFamilies).toHaveLength(0);
	});

	it("token desconocido, revocado o expirado dan el mismo 401", async () => {
		const expired = {
			...ACTIVE_SEED,
			id: "session-exp",
			tokenHash: "hash:raw-expired",
			expiresAt: new Date(NOW.getTime() - 1000).toISOString(),
		};
		const revokedSeed = {
			...ACTIVE_SEED,
			id: "session-rev",
			tokenHash: "hash:raw-revoked",
			status: "revoked" as const,
		};
		const { deps, sessions } = refreshDepsBase([expired, revokedSeed]);

		const codes = await Promise.all(
			["raw-unknown", "raw-expired", "raw-revoked"].map((t) =>
				errOf(makeRefreshSessionService(deps)({ refreshToken: t }, "c")),
			),
		);
		for (const err of codes) expect(err.code).toBe("UNAUTHORIZED");
		expect(codes[0]?.message).toBe(codes[1]?.message);
		expect(codes[1]?.message).toBe(codes[2]?.message);
		// `revoked` es terminal: no dispara revocacion de familia.
		expect(sessions.revokedFamilies).toHaveLength(0);
		expect(sessions.rotated).toHaveLength(0);
	});

	it("reuse detection: token ya rotado revoca toda la familia", async () => {
		const rotatedSeed = { ...ACTIVE_SEED, status: "rotated" as const };
		const { deps, sessions } = refreshDepsBase([rotatedSeed]);

		const err = await errOf(
			makeRefreshSessionService(deps)({ refreshToken: "raw-old" }, "c"),
		);
		expect(err.code).toBe("UNAUTHORIZED");
		expect(sessions.revokedFamilies).toEqual(["family-id-1"]);
		expect(sessions.rotated).toHaveLength(0);
	});

	it("carrera perdida sin reuso: 401 sin revocar la familia", async () => {
		const { deps, sessions } = refreshDepsBase([ACTIVE_SEED]);
		deps.sessions.rotateSession = async () => false;

		const err = await errOf(
			makeRefreshSessionService(deps)({ refreshToken: "raw-old" }, "c"),
		);
		expect(err.code).toBe("UNAUTHORIZED");
		expect(sessions.revokedFamilies).toHaveLength(0);
	});

	it("carrera perdida con reuso concurrente: revoca la familia", async () => {
		const { deps, sessions } = refreshDepsBase([ACTIVE_SEED]);
		deps.sessions.rotateSession = async () => false;
		let calls = 0;
		const origFind = deps.sessions.findSessionByTokenHash;
		deps.sessions.findSessionByTokenHash = async (tokenHash) => {
			calls++;
			const found = await origFind(tokenHash);
			// Segunda lectura (tras perder la carrera): ya rotada por el otro.
			if (calls === 2 && found !== null) {
				return { ...found, status: "rotated" as const };
			}
			return found;
		};

		const err = await errOf(
			makeRefreshSessionService(deps)({ refreshToken: "raw-old" }, "c"),
		);
		expect(err.code).toBe("UNAUTHORIZED");
		expect(sessions.revokedFamilies).toEqual(["family-id-1"]);
	});
});

describe("makeLogoutService", () => {
	it("token conocido: revoca todas las sesiones y devuelve 200", async () => {
		const sessions = fakeSessions([ACTIVE_SEED]);
		const deps: LogoutDeps = {
			sessions,
			refreshTokens: {
				generate: () => "x",
				hash: (t: string) => `hash:${t}`,
				equals: (a: string, b: string) => a === b,
			},
			logger: { info: () => {}, warn: () => {} },
		};
		const res = await makeLogoutService(deps)(
			{ refreshToken: "raw-old" },
			"corr-1",
		);
		expect(res).toEqual({ correlationId: "corr-1" });
		expect(sessions.revokedUsers).toEqual(["user-id-1"]);
	});

	it("token desconocido: 200 identico sin revocar nada", async () => {
		const sessions = fakeSessions([]);
		const deps: LogoutDeps = {
			sessions,
			refreshTokens: {
				generate: () => "x",
				hash: (t: string) => `hash:${t}`,
				equals: (a: string, b: string) => a === b,
			},
			logger: { info: () => {}, warn: () => {} },
		};
		const res = await makeLogoutService(deps)(
			{ refreshToken: "raw-unknown" },
			"corr-1",
		);
		expect(res).toEqual({ correlationId: "corr-1" });
		expect(sessions.revokedUsers).toHaveLength(0);
	});
});
