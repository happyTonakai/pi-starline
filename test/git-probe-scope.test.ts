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
