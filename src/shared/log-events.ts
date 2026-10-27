/**
 * Nombres de eventos de log (campo `message` del JSON estructurado).
 *
 * Centralizados para evitar strings magicos y typos entre emisores y
 * busquedas en el agregador de logs. Los valores no cambian el
 * comportamiento: son los mismos que ya se emitian.
 */
export const LogEvent = {
	CONFIGURATION_INVALID: "configuration.invalid",
	DATABASE_TARGET: "database.target",
	DATABASE_UNREACHABLE: "database.unreachable",
	SERVER_STARTING: "server.starting",
	RELAY_STARTING: "relay.starting",
	RELAY_STOPPING: "relay.stopping",
	RELAY_TICK_FAILED: "outbox.relay_tick_failed",
	OUTBOX_PUBLISHED: "outbox.published",
	OUTBOX_PUBLISH_FAILED: "outbox.publish_failed",
	OUTBOX_PAYLOAD_NORMALIZED: "outbox.payload_normalized",
	OUTBOX_PAYLOAD_DEAD: "outbox.payload_dead",
	PASSWORD_RESET_REQUEST_UNKNOWN: "password_reset.request_unknown",
	PASSWORD_RESET_REQUESTED: "password_reset.requested",
	PASSWORD_RESET_COMPLETED: "password_reset.completed",
	PASSWORD_RESET_RATE_LIMITED: "password_reset.rate_limited",
	LOGIN_SUCCEEDED: "login.succeeded",
	LOGIN_FAILED: "login.failed",
	LOGIN_RATE_LIMITED: "login.rate_limited",
	LOGIN_REFRESHED: "login.refreshed",
	LOGIN_REFRESH_FAILED: "login.refresh_failed",
	LOGIN_REUSE_DETECTED: "login.reuse_detected",
	LOGIN_LOGGED_OUT: "login.logged_out",
	PASSWORD_CHANGED: "password.changed",
	PASSWORD_CHANGE_FAILED: "password.change_failed",
	EMAIL_CHANGED: "email.changed",
	EMAIL_CHANGE_FAILED: "email.change_failed",
	ACCOUNT_RATE_LIMITED: "account.rate_limited",
} as const;

export type LogEvent = (typeof LogEvent)[keyof typeof LogEvent];
