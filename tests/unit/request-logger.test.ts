import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppVariables } from "../../src/shared/http.js";
import { newId } from "../../src/shared/ids.js";
import { LogEvent } from "../../src/shared/log-events.js";
import { makeRequestLogger } from "../../src/shared/middleware/request-logger.js";

type Entry = { level: string; event: string; ids: Record<string, string> };

const buildApp = (entries: Entry[], opts: { withError?: boolean } = {}) => {
	const logger: {
		info: (e: string, f: Record<string, string>) => void;
		warn: (e: string, f: Record<string, string>) => void;
		error?: (e: string, f: Record<string, string>) => void;
	} = {
		info: (event, ids) => entries.push({ level: "info", event, ids }),
		warn: (event, ids) => entries.push({ level: "warn", event, ids }),
	};
	if (opts.withError === true) {
		logger.error = (event, ids) => entries.push({ level: "error", event, ids });
	}
	const app = new Hono<{ Variables: AppVariables }>();
	app.use(async (c, next) => {
		c.set("correlationId", newId());
		await next();
	});
	app.use(makeRequestLogger(logger));
	app.get("/ok", (c) => c.json({ data: {} }));
	app.get("/bad", (c) => c.json({ error: "x" }, 400));
	app.get("/boom", (): Response => {
		throw new Error("fallo interno");
	});
	app.onError((_err, c) => c.json({ error: "internal" }, 500));
	return app;
};

describe("makeRequestLogger", () => {
	it("2xx en info con metodo, ruta, estado y correlacion (sin PII)", async () => {
		const entries: Entry[] = [];
		const res = await buildApp(entries).request("/ok");
		expect(res.status).toBe(200);
		expect(entries).toHaveLength(1);
		expect(entries[0]?.level).toBe("info");
		expect(entries[0]?.event).toBe(LogEvent.HTTP_REQUEST);
		expect(entries[0]?.ids).toMatchObject({
			method: "GET",
			route: "/ok",
			status: "200",
		});
		expect(typeof entries[0]?.ids.correlationId).toBe("string");
		expect(JSON.stringify(entries[0])).not.toMatch(/token|password|Bearer/i);
	});

	it("4xx en warn y omite /health", async () => {
		const entries: Entry[] = [];
		const app = buildApp(entries);
		const bad = await app.request("/bad");
		expect(bad.status).toBe(400);
		expect(entries).toHaveLength(1);
		expect(entries[0]?.level).toBe("warn");

		const health = await app.request("/health");
		expect(health.status).toBe(404);
		expect(entries).toHaveLength(1);
	});

	it("5xx usa error cuando existe y warn cuando no", async () => {
		const withError: Entry[] = [];
		await buildApp(withError, { withError: true }).request("/boom");
		expect(withError).toHaveLength(1);
		expect(withError[0]?.level).toBe("error");
		expect(withError[0]?.event).toBe(LogEvent.HTTP_REQUEST);

		const withoutError: Entry[] = [];
		await buildApp(withoutError).request("/boom");
		expect(withoutError).toHaveLength(1);
		expect(withoutError[0]?.level).toBe("warn");
	});
});
