import type { PasswordHasher } from "../register/register.port.js";
import type {
	LoginInput,
	LoginResult,
	LogoutResult,
	RefreshInput,
	RefreshResult,
} from "./login.types.js";

/**
 * Puertos que el caso de uso de login necesita. `features/` declara
 * interfaces; `container.ts` inyecta implementaciones de `infra/`.
 */

/** Lectura minima de credenciales por documento (proyeccion, sin PII extra). */
export type LoginUserReader = {
	findByDocument(
		type: string,
		number: string,
	): Promise<{ id: string; passwordHash: string } | null>;
};

/** Estados de la sesion de refresh (cadena/familia para rotacion futura). */
export type RefreshSessionStatus = "active" | "rotated" | "revoked";

/** Sesion de refresh vista por los casos de uso (proyeccion minima). */
export type RefreshSession = {
	id: string;
	userId: string;
	familyId: string;
	tokenHash: string;
	status: RefreshSessionStatus;
	expiresAt: string;
};

/**
 * Persistencia de sesiones de refresh.
 *
 * `createLoginSession` crea la primera sesion de una familia. `rotateSession`
 * es atomica: marca la anterior como `rotated` y crea la sucesora en la misma
 * familia en UNA transaccion (`false` si otro request gano la carrera).
 * `revokeFamily` marca `revoked` toda la familia (reuse detection).
 * `revokeAllUserSessions` revoca todo lo `active` del usuario (logout y
 * recuperacion de contrasena; esta ultima en su misma transaccion).
 */
export type RefreshSessionStore = {
	createLoginSession(args: {
		id: string;
		userId: string;
		familyId: string;
		tokenHash: string;
		status: Extract<RefreshSessionStatus, "active">;
		expiresAt: string;
		correlationId: string;
	}): Promise<void>;
	findSessionByTokenHash(tokenHash: string): Promise<RefreshSession | null>;
	rotateSession(args: {
		oldId: string;
		userId: string;
		newSession: {
			id: string;
			familyId: string;
			tokenHash: string;
			expiresAt: string;
			correlationId: string;
		};
	}): Promise<boolean>;
	revokeFamily(familyId: string): Promise<void>;
	revokeAllUserSessions(userId: string): Promise<void>;
};

/**
 * Firma del access token (interfaz para migrar a ES256/JWKS sin tocar el
 * servicio: solo cambia la implementacion de `infra/`).
 */
export type AccessTokenSigner = {
	signAccessToken(args: {
		subject: string;
		tokenId: string;
		issuedAtSeconds: number;
		expiresAtSeconds: number;
	}): Promise<string>;
};

/**
 * Verificacion del access token (la usaran los servicios que validen el
 * JWT con el secreto compartido). Valida `alg` (solo HS256), `iss`, `aud`
 * y `exp`. Sin JWKS no hay llamadas HTTP entre servicios.
 */
export type AccessTokenVerifier = {
	verifyAccessToken(token: string): Promise<{
		sub: string;
		iss: string;
		aud: string;
		exp: number;
		iat: number;
		jti: string;
	}>;
};

/**
 * Herramientas criptograficas del refresh token (inyectadas):
 * - `generate`: opaco aleatorio (CSPRNG, base64url). No es JWT.
 * - `hash`: SHA-256 guardado en DB (el token tiene 256 bits de entropia,
 *   no necesita KDF lenta; igual que el token de restablecimiento).
 * - `equals`: comparacion en tiempo constante de hashes hexadecimales.
 */
export type RefreshTokenTool = {
	generate(): string;
	hash(token: string): string;
	equals(aHex: string, bHex: string): boolean;
};

/**
 * Logger minimo que el feature necesita (solo IDs).
 * El contenedor lo implementa con Winston; los tests usan un fake.
 */
export type LoginLogger = {
	info(event: string, ids: Record<string, string>): void;
	warn(event: string, ids: Record<string, string>): void;
};

export type LoginDeps = {
	users: LoginUserReader;
	sessions: RefreshSessionStore;
	hasher: PasswordHasher;
	accessTokens: AccessTokenSigner;
	refreshTokens: RefreshTokenTool;
	newSessionId: () => string;
	newFamilyId: () => string;
	newJwtId: () => string;
	now: () => Date;
	accessTtlSeconds: number;
	refreshTtlDays: number;
	logger: LoginLogger;
};

export type LoginService = (
	input: LoginInput,
	correlationId: string,
) => Promise<LoginResult>;

export type RefreshDeps = {
	sessions: RefreshSessionStore;
	accessTokens: AccessTokenSigner;
	refreshTokens: RefreshTokenTool;
	newSessionId: () => string;
	newJwtId: () => string;
	now: () => Date;
	accessTtlSeconds: number;
	refreshTtlDays: number;
	logger: LoginLogger;
};

export type RefreshService = (
	input: RefreshInput,
	correlationId: string,
) => Promise<RefreshResult>;

export type LogoutDeps = {
	sessions: RefreshSessionStore;
	refreshTokens: RefreshTokenTool;
	logger: LoginLogger;
};

export type LogoutService = (
	input: RefreshInput,
	correlationId: string,
) => Promise<LogoutResult>;
