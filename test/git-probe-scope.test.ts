import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { execFileMock, gitState } = vi.hoisted(() => ({
	execFileMock: vi.fn(),
	/** When set, the next git call fails with this error and the flag is cleared. */
	gitState: { failNext: null as Error | null },
}));

/**
 * Replace `execFile` with a recorder that reports a successful, empty run.
 * `readGitStatus` swallows failures, so the recorded calls — not their output —
 * are what these tests assert on.
 */
vi.mock("node:child_process", () => ({
	execFile: (
		file: string,
		args: string[],
		options: unknown,
		callback: (error: Error | null, result: { stdout: string; stderr: string }) => void,
	) => {
		execFileMock(file, args, options);
		const failure = gitState.failNext;
		gitState.failNext = null;
		callback(failure, { stdout: "", stderr: "" });
		return { kill() {} };
	},
}));

const { readGitHost, readGitStatus } = await import("../extensions/starline/git");
const { LiveContextController } = await import("../extensions/starline/live-context");
const { default: starline } = await import("../extensions/starline/index");

type Handler = (event: unknown, ctx: unknown) => unknown;

function makeTheme() {
	return {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
		underline: (text: string) => text,
		strikethrough: (text: string) => text,
		getThinkingBorderColor: () => (text: string) => text,
	} as never;
}

function loadExtension() {
	const handlers = new Map<string, Handler[]>();
	starline({
		on(eventName: string, handler: Handler) {
			handlers.set(eventName, [...(handlers.get(eventName) ?? []), handler]);
		},
		registerCommand() {},
		getThinkingLevel() {
			return "off";
		},
	} as never);
	return handlers;
}

async function emit(handlers: Map<string, Handler[]>, eventName: string, ctx: unknown) {
	for (const handler of handlers.get(eventName) ?? []) {
		await handler({ message: { role: "assistant" } }, ctx);
	}
}

function makeContext(overrides: Record<string, unknown> = {}) {
	let editorComponent: unknown;
	return {
		hasUI: true,
		mode: "tui",
		cwd: mkdtempSync(join(tmpdir(), "starline-git-cwd-")),
		model: { id: "claude-sonnet", provider: "anthropic", contextWindow: 200_000 },
		sessionManager: { getBranch: () => [], getSessionName: () => undefined },
		getContextUsage: () => ({ tokens: 1000, contextWindow: 200_000, percent: 0.5 }),
		ui: {
			theme: makeTheme(),
			setFooter() {},
			setEditorComponent(factory: unknown) {
				editorComponent = factory;
			},
			getEditorComponent() {
				return editorComponent;
			},
		},
		...overrides,
	};
}

/** Calls recorded as [file, args, options]. */
function gitCalls(): Array<[string, string[], { env?: NodeJS.ProcessEnv }]> {
	return execFileMock.mock.calls as unknown as Array<
		[string, string[], { env?: NodeJS.ProcessEnv }]
	>;
}

/** The invariant: no git call may take an optional lock. */
function expectReadOnly(calls: ReturnType<typeof gitCalls>): void {
	expect(calls.length).toBeGreaterThan(0);
	for (const [file, , options] of calls) {
		expect(file).toBe("git");
		expect(options.env?.GIT_OPTIONAL_LOCKS).toBe("0");
	}
}

afterEach(() => {
	gitState.failNext = null;
	vi.restoreAllMocks();
	execFileMock.mockClear();
});

describe("git probes are read-only", () => {
	it("disables optional locks on every git command", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "starline-git-cwd-"));

		await readGitStatus(cwd, { readExactTag: true, readMetrics: true });
		await readGitHost(cwd);

		expectReadOnly(gitCalls());
	});

	it("keeps the fallback probe read-only when the first call fails", async () => {
		gitState.failNext = new Error("fatal: bad object HEAD");

		await readGitStatus(mkdtempSync(join(tmpdir(), "starline-git-cwd-")));

		const calls = gitCalls();
		expect(calls.some(([, args]) => args.join(" ") === "rev-parse --is-inside-work-tree")).toBe(
			true,
		);
		expectReadOnly(calls);
	});

	it("keeps the rest of the environment intact", async () => {
		process.env.STARLINE_GIT_ENV_PROBE = "kept";
		await readGitStatus(mkdtempSync(join(tmpdir(), "starline-git-cwd-")));
		delete process.env.STARLINE_GIT_ENV_PROBE;

		expect(gitCalls()[0]?.[2].env?.STARLINE_GIT_ENV_PROBE).toBe("kept");
	});
});

describe("footer work follows the UI mode", () => {
	it("probes git for the footer in TUI mode", async () => {
		const handlers = loadExtension();
		const ctx = makeContext({ mode: "tui" });

		await emit(handlers, "session_start", ctx);
		await vi.waitFor(() => {
			expect(
				gitCalls().some(([, args]) => args.join(" ") === "status --porcelain=2 --branch"),
			).toBe(true);
		});
		await emit(handlers, "session_shutdown", ctx);
	});

	it("does not probe git outside TUI mode, where Pi cannot render a footer", async () => {
		const handlers = loadExtension();
		const ctx = makeContext({ mode: "rpc", hasUI: true });

		await emit(handlers, "session_start", ctx);
		await emit(handlers, "agent_start", ctx);
		await emit(handlers, "tool_execution_start", ctx);
		await emit(handlers, "tool_execution_end", ctx);
		await emit(handlers, "message_update", ctx);
		await emit(handlers, "agent_end", ctx);

		expect(execFileMock).not.toHaveBeenCalled();
		await emit(handlers, "session_shutdown", ctx);
	});

	it("updates live usage context only in TUI mode", async () => {
		const updateSpy = vi.spyOn(LiveContextController.prototype, "update");

		const rpcHandlers = loadExtension();
		const rpcCtx = makeContext({ mode: "rpc", hasUI: true });
		await emit(rpcHandlers, "session_start", rpcCtx);
		await emit(rpcHandlers, "message_update", rpcCtx);
		await emit(rpcHandlers, "session_shutdown", rpcCtx);
		expect(updateSpy).not.toHaveBeenCalled();

		const tuiHandlers = loadExtension();
		const tuiCtx = makeContext({ mode: "tui" });
		await emit(tuiHandlers, "session_start", tuiCtx);
		await emit(tuiHandlers, "message_update", tuiCtx);
		expect(updateSpy).toHaveBeenCalledTimes(1);

		await emit(tuiHandlers, "session_shutdown", tuiCtx);
	});
});
