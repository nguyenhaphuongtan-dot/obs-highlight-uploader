import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
	SELF,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src/index";

// For now, you'll need to do something like this to get a correctly-typed
// `Request` to pass to `worker.fetch()`.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe("Highlight Worker", () => {
	it("serves the cloud library page", async () => {
		const request = new IncomingRequest("https://example.com/library");
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		expect(await response.text()).toContain("Thư viện Highlight");
	});

	it("returns not found for unknown routes", async () => {
		const response = await SELF.fetch("https://example.com/unknown_route");
		expect(response.status).toBe(404);
	});

	it("keeps the legacy view route", async () => {
		const response = await SELF.fetch("https://example.com/v/4k-zuize");
		expect(response.status).toBe(200);
		expect(await response.text()).toContain("4k-zuize");
	});

	it("supports short view routes", async () => {
		const response = await SELF.fetch("https://example.com/4k-zuize");
		expect(response.status).toBe(200);
		expect(await response.text()).toContain("4k-zuize");
	});
});
