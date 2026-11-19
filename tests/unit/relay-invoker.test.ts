import { describe, expect, it, vi } from "vitest";
import type winston from "winston";

import { makeRelayInvoker } from "../../src/infra/events/relay-invoker.js";
import { LogEvent } from "../../src/shared/log-events.js";

const silentLogger = () =>
	({
		warn: vi.fn(),
		info: vi.fn(),
		error: vi.fn(),
	}) as unknown as winston.Logger;

describe("makeRelayInvoker", () => {
	it("es no-op sin functionName (local y tests no tocan AWS)", async () => {
		const send = vi.fn();
		const notify = makeRelayInvoker({
			region: "us-east-1",
			functionName: undefined,
			logger: silentLogger(),
			client: { send },
		});
		notify();
		await Promise.resolve();
		expect(send).not.toHaveBeenCalled();
	});

	it("es no-op sin region", async () => {
		const send = vi.fn();
		const notify = makeRelayInvoker({
			region: undefined,
			functionName: "kenko-dev-auth-relay",
			logger: silentLogger(),
			client: { send },
		});
		notify();
		await Promise.resolve();
		expect(send).not.toHaveBeenCalled();
	});

	it("invoca async y nunca lanza aunque falle", async () => {
		const logger = silentLogger();
		const send = vi.fn().mockRejectedValueOnce(new Error("throttled"));
		const notify = makeRelayInvoker({
			region: "us-east-1",
			functionName: "kenko-dev-auth-relay",
			logger,
			client: { send },
		});
		expect(() => notify()).not.toThrow();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(send).toHaveBeenCalledOnce();
		const command = send.mock.calls[0]?.[0] as {
			input?: { InvocationType?: string };
		};
		expect(command.input?.InvocationType).toBe("Event");
		expect(logger.warn).toHaveBeenCalledWith(LogEvent.RELAY_NOTIFY_FAILED, {
			error: "throttled",
		});
	});
});
