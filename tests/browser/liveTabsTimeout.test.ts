import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const cdpListMock = vi.fn();
const cdpMock = Object.assign(vi.fn(), {
  // biome-ignore lint/style/useNamingConvention: CDP API uses capitalized members.
  List: cdpListMock,
});

vi.mock("chrome-remote-interface", () => ({ default: cdpMock }));

const HEALTHY_INFO = {
  title: "Healthy tab",
  url: "https://chatgpt.com/c/healthy",
  currentModelLabel: "GPT-5.5 Pro",
  stopExists: false,
  sendExists: true,
  promptReady: true,
  loginButtonExists: false,
  authenticated: true,
  assistantCount: 1,
  lastAssistantText: "Answer",
  lastUserText: "Question",
  visibilityState: "visible",
  focused: false,
};

function isInspectionExpression(expression: string): boolean {
  return expression.includes("loginButtonExists");
}

/** A tab whose renderer answers promptly. */
function makeHealthyClient() {
  const close = vi.fn(async () => undefined);
  return {
    close,
    client: {
      Runtime: {
        enable: vi.fn(async () => undefined),
        evaluate: vi.fn(async ({ expression }: { expression: string }) => ({
          result: { value: isInspectionExpression(expression) ? HEALTHY_INFO : null },
        })),
      },
      DOM: { enable: vi.fn(async () => undefined) },
      close,
    },
  };
}

/** A tab that accepts the socket and Runtime.enable but never answers Runtime.evaluate. */
function makeFrozenClient() {
  const close = vi.fn(async () => undefined);
  return {
    close,
    client: {
      Runtime: {
        enable: vi.fn(async () => undefined),
        evaluate: vi.fn(() => new Promise<never>(() => {})),
      },
      DOM: { enable: vi.fn(async () => undefined) },
      close,
    },
  };
}

describe("liveTabs bounded tab inspection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    cdpMock.mockReset();
    cdpListMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("inspectChatGptTab fails within the bound when the tab never answers and closes the socket", async () => {
    const { inspectChatGptTab, TAB_RESPONSE_TIMEOUT_MS } =
      await import("../../src/browser/liveTabs.js");
    const frozen = makeFrozenClient();
    cdpMock.mockResolvedValue(frozen.client);

    const inspection = inspectChatGptTab({
      host: "127.0.0.1",
      port: 9222,
      target: { targetId: "frozen", type: "page", url: "https://chatgpt.com/c/frozen" },
    });
    // Attach the rejection handler before advancing so the timeout is not an unhandled rejection.
    const outcome = expect(inspection).rejects.toThrow(/did not respond/);
    await vi.advanceTimersByTimeAsync(TAB_RESPONSE_TIMEOUT_MS);
    await outcome;
    expect(frozen.close).toHaveBeenCalledTimes(1);
  });

  test.each(["Runtime", "DOM"] as const)(
    "closes the socket when %s.enable hangs",
    async (domain) => {
      const { inspectChatGptTab, TAB_RESPONSE_TIMEOUT_MS } =
        await import("../../src/browser/liveTabs.js");
      const frozen = makeHealthyClient();
      frozen.client[domain].enable.mockImplementation(() => new Promise(() => {}));
      cdpMock.mockResolvedValue(frozen.client);
      const outcome = expect(inspectChatGptTab({ target: { targetId: "frozen" } })).rejects.toThrow(
        /did not respond/,
      );
      await vi.advanceTimersByTimeAsync(TAB_RESPONSE_TIMEOUT_MS);
      await outcome;
      expect(frozen.close).toHaveBeenCalledOnce();
    },
  );

  test("closes a connection that arrives after the timeout without inspecting it", async () => {
    const { inspectChatGptTab, TAB_RESPONSE_TIMEOUT_MS } =
      await import("../../src/browser/liveTabs.js");
    const healthy = makeHealthyClient();
    let connect!: (client: typeof healthy.client) => void;
    cdpMock.mockReturnValue(
      new Promise((resolve) => {
        connect = resolve;
      }),
    );
    const outcome = expect(inspectChatGptTab({ target: { targetId: "late" } })).rejects.toThrow(
      /did not respond/,
    );
    await vi.advanceTimersByTimeAsync(TAB_RESPONSE_TIMEOUT_MS);
    await outcome;
    connect(healthy.client);
    await vi.advanceTimersByTimeAsync(0);
    expect(healthy.close).toHaveBeenCalledOnce();
    expect(healthy.client.Runtime.enable).not.toHaveBeenCalled();
    expect(healthy.client.Runtime.evaluate).not.toHaveBeenCalled();
  });

  test("collectChatGptTabs reports the frozen tab as detached and still inspects the others", async () => {
    const { collectChatGptTabs, TAB_RESPONSE_TIMEOUT_MS } =
      await import("../../src/browser/liveTabs.js");
    const frozen = makeFrozenClient();
    const healthy = makeHealthyClient();
    cdpListMock.mockResolvedValue([
      { id: "frozen", type: "page", url: "https://chatgpt.com/c/frozen", title: "Frozen" },
      { id: "healthy", type: "page", url: "https://chatgpt.com/c/healthy", title: "Healthy" },
    ]);
    cdpMock.mockImplementation(async (options: { target?: string }) =>
      options.target === "frozen" ? frozen.client : healthy.client,
    );

    const collection = collectChatGptTabs({ host: "127.0.0.1", port: 9222 });
    await vi.advanceTimersByTimeAsync(TAB_RESPONSE_TIMEOUT_MS);
    const tabs = await collection;

    const frozenTab = tabs.find((tab) => tab.targetId === "frozen");
    const healthyTab = tabs.find((tab) => tab.targetId === "healthy");
    expect(frozenTab?.state).toBe("detached");
    expect(frozenTab?.error).toMatch(/did not respond/);
    expect(healthyTab?.state).toBe("completed");
    expect(healthyTab?.lastAssistantText).toBe("Answer");
    expect(frozen.close).toHaveBeenCalledTimes(1);
    expect(healthy.close).toHaveBeenCalledTimes(1);
  });
});
