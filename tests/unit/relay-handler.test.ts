import type { EventBridgeClient } from "@aws-sdk/client-eventbridge";
import { describe, expect, it, vi } from "vitest";
import type winston from "winston";

import type { OutboxRepository } from "../../src/infra/db/repositories/outbox.repository.js";
import { createRelayHandler } from "../../src/relay-handler.js";

const stubLogger = (): winston.Logger => {
	return {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	} as unknown as winston.Logger;
};

const stubOutbox = (behavior: {
	rows?: Array<{
		id: string;
		eventId: string;
		eventType: string;
		correlationId: string;
		payload: unknown;
		attempts: number;
	}>;
	claimThrows?: boolean;
}) => {
	const claimed: number[] = [];
	return {
		claimed,
		async claimPending() {
			claimed.push(1);
			if (behavior.claimThrows === true) throw new Error("db caida");
			return behavior.rows ?? [];
		},
		async markSent() {},
		async markDead() {},
		async reschedule() {},
	} as unknown as OutboxRepository & { claimed: number[] };
};

const stubBridge = () => {
	return {
		async send() {
			return { Entries: [{}] };
		},
	} as unknown as EventBridgeClient;
};

const DETAIL = {
	metadata: {
		eventId: "e1",
		eventVersion: "1",
		occurredAt: "2026-10-13T20:15:30.000Z",
		correlationId: "c1",
	},
	data: { userId: "u1" },
};

describe("createRelayHandler", () => {
	it("GET /health responde ok sin tocar la outbox", async () => {
		const outbox = stubOutbox({ rows: [] });
		const handler = createRelayHandler({
			outbox,
			eventBridge: stubBridge(),
			eventBusName: "kenko-dev-bus",
			logger: stubLogger(),
		});

		const res = await handler(new Request("http://localhost:8080/health"));

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ data: { status: "ok" } });
		expect(outbox.claimed).toHaveLength(0);
	});

	it("cualquier otra ruta corre una pasada del relay y devuelve conteos", async () => {
		const outbox = stubOutbox({
			rows: [
				{
					id: "row1",
					eventId: "e1",
					eventType: "UserRegistered",
					correlationId: "c1",
					payload: DETAIL,
					attempts: 0,
				},
			],
		});
		const handler = createRelayHandler({
			outbox,
			eventBridge: stubBridge(),
			eventBusName: "kenko-dev-bus",
			logger: stubLogger(),
		});

		const res = await handler(
			new Request("http://localhost:8080/", { method: "POST" }),
		);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			data: { published: 1, failed: 0, dead: 0 },
		});
	});

	it("fallo catastrofico (DB) devuelve 500 generico sin detalles internos", async () => {
		const logger = stubLogger();
		const handler = createRelayHandler({
			outbox: stubOutbox({ claimThrows: true }),
			eventBridge: stubBridge(),
			eventBusName: "kenko-dev-bus",
			logger,
		});

		const res = await handler(
			new Request("http://localhost:8080/", { method: "POST" }),
		);
		const body = (await res.json()) as {
			error: { code: string; message: string };
		};

		expect(res.status).toBe(500);
		expect(body.error.code).toBe("RELAY_FAILED");
		expect((logger.error as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(
			"outbox.relay_tick_failed",
		);
	});
});
