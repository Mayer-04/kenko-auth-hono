import { REFRESH_COOKIE_MAX_AGE, REFRESH_COOKIE_NAME } from "./headers.js";

/** Lee el refresh token desde la cookie `kenko_refresh` (si existe). */
export const refreshTokenFromCookie = (
	cookieHeader: string | undefined,
): string | undefined => {
	if (cookieHeader === undefined || cookieHeader === "") return undefined;
	const parts = cookieHeader.split(";");
	for (const part of parts) {
		const [name, ...rest] = part.split("=");
		if (name?.trim() !== REFRESH_COOKIE_NAME) continue;
		const value = rest.join("=").trim();
		if (value === "") return undefined;
		try {
			return decodeURIComponent(value);
		} catch {
			return value;
		}
	}
	return undefined;
};

const isHttpsRequest = (
	requestUrl: string,
	forwardedProto?: string,
): boolean => {
	if (forwardedProto !== undefined && forwardedProto !== "") {
		const proto = forwardedProto.split(",")[0]?.trim().toLowerCase();
		if (proto === "https") return true;
		if (proto === "http") return false;
	}
	try {
		return new URL(requestUrl).protocol === "https:";
	} catch {
		return false;
	}
};

/** `Set-Cookie` para fijar el refresh como httpOnly (complementa el JSON). */
export const buildRefreshCookie = (
	refreshToken: string,
	requestUrl: string,
	forwardedProto?: string,
): string => {
	const segments = [
		`${REFRESH_COOKIE_NAME}=${encodeURIComponent(refreshToken)}`,
		"HttpOnly",
		"Path=/",
		`Max-Age=${REFRESH_COOKIE_MAX_AGE}`,
		"SameSite=Lax",
	];
	if (isHttpsRequest(requestUrl, forwardedProto)) segments.push("Secure");
	return segments.join("; ");
};

/** `Set-Cookie` para limpiar el refresh al cerrar sesion. */
export const buildClearRefreshCookie = (
	requestUrl: string,
	forwardedProto?: string,
): string => {
	const segments = [
		`${REFRESH_COOKIE_NAME}=`,
		"HttpOnly",
		"Path=/",
		"Max-Age=0",
		"SameSite=Lax",
	];
	if (isHttpsRequest(requestUrl, forwardedProto)) segments.push("Secure");
	return segments.join("; ");
};
