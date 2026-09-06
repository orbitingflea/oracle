import { describe, expect, test, vi } from "vitest";
import {
  __test__ as promptComposer,
  buildAttachmentReadyExpressionForTest,
  clearPromptComposer,
  submitPrompt,
} from "../../src/browser/actions/promptComposer.js";
import {
  CONVERSATION_TURN_CONTAINER_SELECTOR,
  CONVERSATION_TURN_SELECTOR,
  SEND_BUTTON_SELECTORS,
} from "../../src/browser/constants.js";
import { BrowserAutomationError } from "../../src/oracle/errors.js";

const evaluateAttachmentReady = (expectedName: string, visibleName: string): boolean => {
  class FakeElement {
    tagName = "DIV";
    parentElement: FakeElement | null = null;

    constructor(
      private readonly text = "",
      private readonly attributes: Record<string, string> = {},
    ) {}

    get innerText() {
      return this.text;
    }

    get textContent() {
      return this.text;
    }

    getAttribute(name: string) {
      return this.attributes[name] ?? null;
    }

    querySelectorAll(_selector: string): FakeElement[] {
      return [];
    }

    closest(_selector: string): FakeElement | null {
      return null;
    }
  }

  class FakeInputElement extends FakeElement {
    files: File[] = [];
  }

  const chip = new FakeElement(visibleName, {
    "aria-label": `Remove file 1: ${visibleName}`,
    "data-testid": "file-chip",
  });
  const root = new FakeElement();
  root.querySelectorAll = (selector: string) => {
    if (selector === 'input[type="file"]') return [];
    if (selector.includes('[data-testid*="chip"]')) return [chip];
    if (selector.includes('[aria-label*="Remove" i]')) return [chip];
    return [];
  };
  const document = {
    querySelector: () => null,
    querySelectorAll: () => [],
    body: root,
  };
  const expression = buildAttachmentReadyExpressionForTest([expectedName]);
  const evaluate = new Function(
    "document",
    "HTMLElement",
    "HTMLInputElement",
    `return ${expression};`,
  );
  return Boolean(evaluate(document, FakeElement, FakeInputElement));
};

// Runs the real injected send scripts against a minimal DOM so the trusted-click
// marker is exercised as written rather than stubbed by the evaluate mock.
const createSendButtonDom = () => {
  class FakeElement {
    readonly handlers: ((event: { isTrusted: boolean; target: unknown }) => void)[] = [];

    constructor(readonly top: number) {}

    addEventListener(
      type: string,
      handler: (event: { isTrusted: boolean; target: unknown }) => void,
    ) {
      if (type === "click") this.handlers.push(handler);
    }

    getBoundingClientRect() {
      return { left: 10, top: this.top, width: 20, height: 10 };
    }

    getAttribute() {
      return null;
    }

    hasAttribute() {
      return false;
    }

    closest(selector: string) {
      return selector === SEND_BUTTON_SELECTORS.join(",") ? this : null;
    }

    contains(node: unknown) {
      return node === this;
    }
  }

  let button = new FakeElement(20);
  const listeners: ((event: { isTrusted: boolean; target: unknown }) => void)[] = [];
  const windowStub: Record<string, unknown> = {
    innerWidth: 800,
    innerHeight: 600,
    getComputedStyle: () => ({ display: "block", visibility: "visible", pointerEvents: "auto" }),
  };
  const document = {
    querySelector: () => null,
    querySelectorAll: (selector: string) =>
      selector === SEND_BUTTON_SELECTORS[0] ? [button] : ([] as unknown[]),
    elementFromPoint: () => button,
    addEventListener: (
      type: string,
      handler: (event: { isTrusted: boolean; target: unknown }) => void,
    ) => {
      if (type === "click") listeners.push(handler);
    },
  };

  return {
    run: (expression: string) =>
      new Function(
        "document",
        "window",
        "HTMLElement",
        "HTMLTextAreaElement",
        "HTMLInputElement",
        `return ${expression};`,
      )(document, windowStub, FakeElement, class {}, class {}),
    replaceButton: () => {
      button = new FakeElement(20);
    },
    dispatchTrustedClick: () => {
      // Only listeners on the document or on the node actually clicked can see
      // this event; one left on a detached node cannot.
      for (const handler of [...listeners, ...button.handlers]) {
        handler({ isTrusted: true, target: button });
      }
    },
    listenerCount: () => listeners.length,
  };
};

describe("promptComposer", () => {
  test.each([
    ["mcp.md", "mcp(7).md", true],
    ["mcp.md", "remove file 1: mcp(7).md", true],
    ["mcp.md", "mcp(7).jpg", false],
    ["mcp.md", "xmcp(7).md", false],
  ])("matches ready attachment %s against %s as %s", (expected, visible, matches) => {
    expect(evaluateAttachmentReady(expected, visible)).toBe(matches);
  });

  test("fails composer clearing when stale text remains", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: { value: { cleared: true, remaining: ["old draft"] } },
      }),
    } as unknown as {
      evaluate: (args: { expression: string; returnByValue?: boolean }) => Promise<unknown>;
    };
    const logger = Object.assign(vi.fn(), { verbose: false });

    await expect(clearPromptComposer(runtime as never, logger as never)).rejects.toThrow(
      /Failed to clear prompt composer/,
    );
  });

  test("does not treat historical assistant content as committed without a new turn", async () => {
    vi.useFakeTimers();
    try {
      const runtime = {
        evaluate: vi
          .fn()
          // Baseline read (turn count)
          .mockResolvedValueOnce({ result: { value: 10 } })
          // Polls (repeat)
          .mockResolvedValue({
            result: {
              value: {
                baseline: 10,
                turnsCount: 10,
                userMatched: false,
                prefixMatched: false,
                lastMatched: false,
                hasNewTurn: false,
                stopVisible: true,
                assistantVisible: true,
                composerCleared: true,
                inConversation: false,
              },
            },
          }),
      } as unknown as {
        evaluate: (args: { expression: string; returnByValue?: boolean }) => Promise<unknown>;
      };

      const promise = promptComposer.verifyPromptCommitted(runtime as never, "hello", 150);
      // Attach the rejection handler before timers advance to avoid unhandled-rejection warnings.
      const assertion = expect(promise).rejects.toThrow(/prompt did not appear/i);
      await vi.advanceTimersByTimeAsync(250);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not count nested broad-selector matches as new turns in a reused conversation", async () => {
    vi.useFakeTimers();
    try {
      const topLevelTurns = [{ innerText: "old user" }, { innerText: "old assistant" }];
      const nestedMatches = [
        topLevelTurns[0],
        { innerText: "old user" },
        topLevelTurns[1],
        { innerText: "old assistant" },
      ];
      const document = {
        querySelector: () => null,
        querySelectorAll: (selector: string) => {
          if (selector === CONVERSATION_TURN_CONTAINER_SELECTOR) return topLevelTurns;
          if (selector === CONVERSATION_TURN_SELECTOR) return nestedMatches;
          return [];
        },
      };
      class FakeTextArea {}
      const runtime = {
        evaluate: vi.fn(async ({ expression }: { expression: string }) => ({
          result: {
            value: Function(
              "document",
              "HTMLTextAreaElement",
              "location",
              `return ${expression};`,
            )(document, FakeTextArea, { href: "https://chatgpt.com/c/reused" }),
          },
        })),
      } as unknown as {
        evaluate: (args: { expression: string; returnByValue?: boolean }) => Promise<unknown>;
      };

      const promise = promptComposer.verifyPromptCommitted(
        runtime as never,
        "new prompt",
        150,
        undefined,
        2,
      );
      const assertion = expect(promise).rejects.toThrow(/prompt did not appear/i);
      await vi.advanceTimersByTimeAsync(250);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  test.each([5, 50_001])(
    "commit timeout at %i chars stays ambiguous, never too-large",
    async (length) => {
      vi.useFakeTimers();
      try {
        const probe = {
          baseline: 10,
          turnsCount: 10,
          userMatched: false,
          prefixMatched: false,
          lastMatched: false,
          hasNewTurn: false,
          stopVisible: false,
          assistantVisible: false,
          composerCleared: true,
          inConversation: false,
          editorValue: "",
          lastTurn: "previous turn text",
        };
        const runtime = {
          evaluate: vi
            .fn()
            // Baseline read (turn count)
            .mockResolvedValueOnce({ result: { value: 10 } })
            // Polls + final diagnostic probe
            .mockResolvedValue({ result: { value: probe } }),
        } as unknown as {
          evaluate: (args: { expression: string; returnByValue?: boolean }) => Promise<unknown>;
        };

        const promise = promptComposer.verifyPromptCommitted(
          runtime as never,
          "x".repeat(length),
          150,
        );
        const assertion = promise.then(
          () => {
            throw new Error("expected verifyPromptCommitted to reject");
          },
          (error: unknown) => error,
        );
        await vi.advanceTimersByTimeAsync(250);
        const error = (await assertion) as {
          name?: string;
          details?: Record<string, unknown>;
          message?: string;
        };
        expect(error.message).toMatch(/prompt did not appear/i);
        expect(error.name).toBe("BrowserAutomationError");
        expect(error.details).toMatchObject({
          stage: "submit-prompt",
          code: "prompt-commit-timeout",
          commitProbe: expect.objectContaining({
            hasNewTurn: false,
            composerCleared: true,
            turnsCount: 10,
            lastTurnLength: "previous turn text".length,
          }),
        });
        // Free text must not leak into the structured details.
        const commitProbe = error.details?.commitProbe as Record<string, unknown>;
        expect(commitProbe).not.toHaveProperty("lastTurn");
        expect(commitProbe).not.toHaveProperty("editorValue");
      } finally {
        vi.useRealTimers();
      }
    },
  );

  test("allows prompt match even if baseline turn count cannot be read", async () => {
    const runtime = {
      evaluate: vi
        .fn()
        // Baseline read fails
        .mockRejectedValueOnce(new Error("turn read failed"))
        // First poll shows prompt match (baseline unknown)
        .mockResolvedValueOnce({
          result: {
            value: {
              baseline: -1,
              turnsCount: 1,
              userMatched: true,
              prefixMatched: false,
              lastMatched: true,
              hasNewTurn: false,
              stopVisible: false,
              assistantVisible: false,
              composerCleared: false,
              inConversation: true,
            },
          },
        }),
    } as unknown as {
      evaluate: (args: { expression: string; returnByValue?: boolean }) => Promise<unknown>;
    };

    await expect(
      promptComposer.verifyPromptCommitted(runtime as never, "hello", 150),
    ).resolves.toBe(1);
  });

  test("attachment sends time out instead of allowing Enter fallback", async () => {
    vi.useFakeTimers();
    try {
      const runtime = {
        evaluate: vi.fn(async ({ expression }: { expression: string }) => {
          if (expression.includes("button.scrollIntoView")) {
            return { result: { value: { status: "disabled" } } };
          }
          return { result: { value: true } };
        }),
      } as unknown as {
        evaluate: (args: { expression: string; returnByValue?: boolean }) => Promise<unknown>;
      };

      const promise = promptComposer.attemptSendButton(
        runtime as never,
        (() => undefined) as never,
        undefined,
        ["oracle-attach-verify.txt"],
      );
      const assertion = expect(promise).rejects.toThrow(/after 45s/i);
      await vi.advanceTimersByTimeAsync(46_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  test("only attachment sends get the longer send-button deadline", () => {
    expect(promptComposer.sendButtonTimeoutMs()).toBe(20_000);
    expect(promptComposer.sendButtonTimeoutMs([])).toBe(20_000);
    expect(promptComposer.sendButtonTimeoutMs(["oracle-attach-verify.txt"])).toBe(45_000);
    expect(promptComposer.sendButtonTimeoutMs(["oracle-attach-verify.txt"], 120_000)).toBe(120_000);
  });

  test("marks prompt submitted before commit verification finishes", async () => {
    const onPromptSubmitted = vi.fn();
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        if (expression.includes("document.readyState")) {
          return { result: { value: { ready: true, composer: true, fileInput: false } } };
        }
        if (expression.includes("focused: true")) {
          return { result: { value: { focused: true } } };
        }
        if (expression.includes("editorText")) {
          return {
            result: { value: { editorText: "hello", fallbackValue: "", activeValue: "hello" } },
          };
        }
        if (expression.includes("button.scrollIntoView")) {
          return { result: { value: { status: "point", x: 10, y: 20 } } };
        }
        return {
          result: {
            value: {
              baseline: 0,
              turnsCount: 1,
              userMatched: true,
              prefixMatched: false,
              lastMatched: true,
              hasNewTurn: true,
              stopVisible: true,
              assistantVisible: false,
              composerCleared: true,
              inConversation: true,
            },
          },
        };
      }),
    };
    const input = { insertText: vi.fn(), dispatchKeyEvent: vi.fn(), dispatchMouseEvent: vi.fn() };
    const logger = Object.assign(vi.fn(), { verbose: false });

    await submitPrompt(
      {
        runtime: runtime as never,
        input: input as never,
        baselineTurns: 0,
        onPromptSubmitted,
      },
      "hello",
      logger as never,
    );

    expect(onPromptSubmitted).toHaveBeenCalledTimes(1);
    expect(input.dispatchKeyEvent).not.toHaveBeenCalled();
  });

  test("does not send Enter while a trusted click commits after the old fallback deadline", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      let clickedAt: number | null = null;
      const runtime = {
        evaluate: vi.fn(async ({ expression }: { expression: string }) => {
          if (expression.includes("document.readyState")) {
            return { result: { value: { ready: true, composer: true, fileInput: false } } };
          }
          if (expression.includes("focused: true")) {
            return { result: { value: { focused: true } } };
          }
          if (expression.includes("editorText")) {
            return {
              result: { value: { editorText: "hello", fallbackValue: "", activeValue: "hello" } },
            };
          }
          if (expression.includes("button.scrollIntoView")) {
            return { result: { value: { status: "point", x: 10, y: 20 } } };
          }
          if (expression.includes("oracle-post-click-composer-probe")) {
            const elapsed = clickedAt === null ? 0 : Date.now() - clickedAt;
            return { result: { value: elapsed < 2_500 } };
          }
          const committed = clickedAt !== null && Date.now() - clickedAt >= 2_500;
          return {
            result: {
              value: {
                baseline: 0,
                turnsCount: committed ? 1 : 0,
                userMatched: committed,
                prefixMatched: false,
                lastMatched: committed,
                hasNewTurn: committed,
                stopVisible: committed,
                assistantVisible: false,
                composerCleared: committed,
                inConversation: true,
              },
            },
          };
        }),
      };
      const input = {
        insertText: vi.fn(),
        dispatchKeyEvent: vi.fn(),
        dispatchMouseEvent: vi.fn(async ({ type }: { type: string }) => {
          if (type === "mouseReleased") clickedAt = Date.now();
        }),
      };
      const logger = Object.assign(vi.fn(), { verbose: false });

      const result = submitPrompt(
        {
          runtime: runtime as never,
          input: input as never,
          baselineTurns: 0,
        },
        "hello",
        logger as never,
      );
      await vi.advanceTimersByTimeAsync(3_500);

      await expect(result).resolves.toBe(1);
      expect(input.dispatchKeyEvent).not.toHaveBeenCalled();
      expect(input.dispatchMouseEvent).toHaveBeenCalledTimes(3);
      expect(input.dispatchMouseEvent).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ type: "mousePressed", button: "left" }),
      );
      expect(input.dispatchMouseEvent).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({ type: "mouseReleased", button: "left" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test("uses one Enter key sequence only when no send-button click was issued", async () => {
    vi.useFakeTimers();
    try {
      const runtime = {
        evaluate: vi.fn(async ({ expression }: { expression: string }) => {
          if (expression.includes("document.readyState")) {
            return { result: { value: { ready: true, composer: true, fileInput: false } } };
          }
          if (expression.includes("focused: true")) {
            return { result: { value: { focused: true } } };
          }
          if (expression.includes("editorText")) {
            return {
              result: { value: { editorText: "hello", fallbackValue: "", activeValue: "hello" } },
            };
          }
          if (expression.includes("button.scrollIntoView")) {
            return { result: { value: { status: "missing" } } };
          }
          return {
            result: {
              value: {
                baseline: 0,
                turnsCount: 1,
                userMatched: true,
                prefixMatched: false,
                lastMatched: true,
                hasNewTurn: true,
                stopVisible: true,
                assistantVisible: false,
                composerCleared: true,
                inConversation: true,
              },
            },
          };
        }),
      };
      const input = {
        insertText: vi.fn(),
        dispatchKeyEvent: vi.fn(),
        dispatchMouseEvent: vi.fn(),
      };
      const logger = Object.assign(vi.fn(), { verbose: false });

      const result = submitPrompt(
        {
          runtime: runtime as never,
          input: input as never,
          baselineTurns: 0,
        },
        "hello",
        logger as never,
      );
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(result).resolves.toBe(1);
      expect(input.dispatchKeyEvent).toHaveBeenCalledTimes(2);
      expect(input.dispatchKeyEvent).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ type: "keyDown", key: "Enter" }),
      );
      expect(input.dispatchKeyEvent).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ type: "keyUp", key: "Enter" }),
      );
      expect(input.dispatchMouseEvent).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("waits for a delayed trusted click without issuing a second send", async () => {
    vi.useFakeTimers();
    try {
      const evaluate = vi.fn().mockResolvedValue({
        result: { value: { status: "point", x: 10, y: 20 } },
      });
      const input = {
        dispatchMouseEvent: vi.fn(async ({ type }: { type: string }) => {
          if (type === "mouseReleased") {
            await new Promise((resolve) => setTimeout(resolve, 1_000));
          }
        }),
      };

      const result = promptComposer.attemptSendButton(
        { evaluate } as never,
        input as never,
        undefined,
        undefined,
      );
      await vi.advanceTimersByTimeAsync(1_250);

      await expect(result).resolves.toBe(true);
      // Two measurements (the stability samples) and one post-click
      // verification probe: a third measurement would mean a second click.
      const measurements = evaluate.mock.calls.filter(
        (args) => !String((args[0] as { expression: string }).expression).includes("clickSeen"),
      );
      expect(measurements).toHaveLength(2);
      expect(evaluate).toHaveBeenCalledTimes(3);
      expect(input.dispatchMouseEvent).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  test("activates the target before measuring fresh trusted-click coordinates", async () => {
    vi.useFakeTimers();
    try {
      const events: string[] = [];
      let activated = false;
      const runtime = {
        evaluate: vi.fn(async () => {
          events.push("measurePoint");
          return {
            result: {
              value: activated
                ? { status: "point", x: 30, y: 40 }
                : { status: "point", x: 10, y: 20 },
            },
          };
        }),
      };
      const input = {
        dispatchMouseEvent: vi.fn(async ({ type }: { type: string }) => {
          events.push(type);
        }),
      };
      const page = {
        bringToFront: vi.fn(async () => {
          activated = true;
          events.push("bringToFront");
        }),
      };

      const result = promptComposer.attemptSendButton(
        runtime as never,
        input as never,
        undefined,
        undefined,
        undefined,
        page as never,
      );
      await vi.advanceTimersByTimeAsync(350);

      await expect(result).resolves.toBe(true);
      expect(events).toEqual([
        "bringToFront",
        "measurePoint",
        "measurePoint",
        "mouseMoved",
        "mousePressed",
        "mouseReleased",
        // Post-click verification probe; it confirms the click and stops there.
        "measurePoint",
      ]);
      expect(page.bringToFront).toHaveBeenCalledTimes(1);
      expect(input.dispatchMouseEvent).toHaveBeenNthCalledWith(1, {
        type: "mouseMoved",
        x: 30,
        y: 40,
      });
      expect(input.dispatchMouseEvent).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  test("waits through scrolling and a layout snap before issuing its only click", async () => {
    vi.useFakeTimers();
    try {
      const runtime = {
        evaluate: vi
          .fn()
          .mockResolvedValueOnce({ result: { value: { status: "settling" } } })
          .mockResolvedValueOnce({ result: { value: { status: "point", x: 10, y: 20 } } })
          .mockResolvedValue({ result: { value: { status: "point", x: 30, y: 40 } } }),
      };
      const input = { dispatchMouseEvent: vi.fn() };
      const result = promptComposer.attemptSendButton(runtime as never, input as never);
      await vi.advanceTimersByTimeAsync(500);
      await expect(result).resolves.toBe(true);
      expect(input.dispatchMouseEvent).toHaveBeenCalledTimes(3);
      expect(input.dispatchMouseEvent).toHaveBeenNthCalledWith(2, {
        type: "mousePressed",
        x: 30,
        y: 40,
        button: "left",
        clickCount: 1,
      });
    } finally {
      vi.useRealTimers();
    }
  });
  test("re-clicks with fresh coordinates after a proven missed send click", async () => {
    vi.useFakeTimers();
    try {
      let clicksCompleted = 0;
      const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
        if (expression.includes("button.scrollIntoView")) {
          // The button drifts down a pixel after the first (missed) click.
          return {
            result: {
              value: {
                status: "point",
                x: 10,
                y: 20 + clicksCompleted,
                state: { composerCleared: false, stopVisible: false, turnsCount: 0 },
              },
            },
          };
        }
        if (expression.includes("clickSeen")) {
          // First click is eaten by a mid-click layout shift; the second lands.
          return {
            result: {
              value: {
                composerCleared: clicksCompleted >= 2,
                stopVisible: false,
                turnsCount: 0,
                clickSeen: false,
              },
            },
          };
        }
        return { result: { value: 0 } };
      });
      const input = {
        dispatchMouseEvent: vi.fn(async ({ type }: { type: string }) => {
          if (type === "mouseReleased") clicksCompleted += 1;
        }),
      };

      const page = { bringToFront: vi.fn(async () => undefined) };

      const result = promptComposer.attemptSendButton(
        { evaluate } as never,
        input as never,
        undefined,
        undefined,
        undefined,
        page as never,
      );
      await vi.advanceTimersByTimeAsync(10_000);

      await expect(result).resolves.toBe(true);
      expect(input.dispatchMouseEvent).toHaveBeenCalledTimes(6);
      // A miss can mean the window lost focus, so the retry re-activates the
      // target instead of trusting the activation that preceded the miss.
      expect(page.bringToFront).toHaveBeenCalledTimes(2);
      // The retry re-measures and only clicks once the fresh point is stable.
      const ys = input.dispatchMouseEvent.mock.calls.map(
        ([event]) => (event as unknown as { y: number }).y,
      );
      expect(ys.slice(0, 3)).toEqual([20, 20, 20]);
      expect(ys.slice(3)).toEqual([21, 21, 21]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not count a stop control that was already visible as send proof", async () => {
    vi.useFakeTimers();
    try {
      const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
        if (expression.includes("button.scrollIntoView")) {
          return {
            result: {
              value: {
                status: "point",
                x: 10,
                y: 20,
                state: { composerCleared: false, stopVisible: true, turnsCount: 3 },
              },
            },
          };
        }
        if (expression.includes("clickSeen")) {
          // A response from the resumed conversation is still streaming: the
          // stop control and the turn count were already there before the click.
          return {
            result: {
              value: {
                composerCleared: false,
                stopVisible: true,
                turnsCount: 3,
                clickSeen: false,
              },
            },
          };
        }
        return { result: { value: 0 } };
      });
      const input = { dispatchMouseEvent: vi.fn(async () => undefined) };

      const result = promptComposer.attemptSendButton({ evaluate } as never, input as never);
      const assertion = expect(result).resolves.toBe(false);
      await vi.advanceTimersByTimeAsync(15_000);

      await assertion;
      expect(input.dispatchMouseEvent).toHaveBeenCalledTimes(12);
    } finally {
      vi.useRealTimers();
    }
  });

  test("throws a structured error after four proven attachment send misses", async () => {
    vi.useFakeTimers();
    try {
      const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
        if (expression.includes("button.scrollIntoView")) {
          return {
            result: {
              value: {
                status: "point",
                x: 10,
                y: 20,
                state: { composerCleared: false, stopVisible: false, turnsCount: 3 },
              },
            },
          };
        }
        if (expression.includes("clickSeen")) {
          return {
            result: {
              value: {
                composerCleared: false,
                stopVisible: false,
                turnsCount: 3,
                clickSeen: false,
              },
            },
          };
        }
        if (expression.includes("chipsReady")) {
          return { result: { value: true } };
        }
        return { result: { value: 0 } };
      });
      const input = { dispatchMouseEvent: vi.fn(async () => undefined) };

      const result = promptComposer.attemptSendButton(
        { evaluate } as never,
        input as never,
        undefined,
        ["oracle-attach-verify.txt"],
        30_000,
      );
      const assertion = result.then(
        () => {
          throw new Error("expected attemptSendButton to reject");
        },
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(15_000);

      const error = await assertion;
      expect(error).toBeInstanceOf(BrowserAutomationError);
      expect((error as BrowserAutomationError).details).toMatchObject({
        code: "send-click-missed",
        clickAttempts: 4,
      });
      expect(input.dispatchMouseEvent).toHaveBeenCalledTimes(12);
    } finally {
      vi.useRealTimers();
    }
  });

  test("re-queries a stale zero-rect send button instead of clicking it", async () => {
    vi.useFakeTimers();
    try {
      let lookups = 0;
      let clicksCompleted = 0;
      const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
        if (expression.includes("button.scrollIntoView")) {
          lookups += 1;
          if (lookups === 2) return { result: { value: { status: "stale" } } };
          return {
            result: {
              value: {
                status: "point",
                x: 10,
                y: 20,
                state: { composerCleared: false, stopVisible: false, turnsCount: 0 },
              },
            },
          };
        }
        if (expression.includes("clickSeen")) {
          return {
            result: {
              value: {
                composerCleared: clicksCompleted > 0,
                stopVisible: false,
                turnsCount: 0,
                clickSeen: false,
              },
            },
          };
        }
        return { result: { value: 0 } };
      });
      const input = {
        dispatchMouseEvent: vi.fn(async ({ type }: { type: string }) => {
          if (type === "mouseReleased") clicksCompleted += 1;
        }),
      };

      const result = promptComposer.attemptSendButton({ evaluate } as never, input as never);
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(result).resolves.toBe(true);
      // A stale result discards the previous point; two fresh samples precede the click.
      expect(lookups).toBe(4);
      expect(input.dispatchMouseEvent).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  test("arms the trusted-click marker only for isTrusted events", async () => {
    vi.useFakeTimers();
    try {
      const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
        if (expression.includes("button.scrollIntoView")) {
          return { result: { value: { status: "missing" } } };
        }
        return { result: { value: 0 } };
      });

      const result = promptComposer.attemptSendButton(
        { evaluate } as never,
        { dispatchMouseEvent: vi.fn() } as never,
      );
      await vi.advanceTimersByTimeAsync(100);
      await expect(result).resolves.toBe(false);

      const script = evaluate.mock.calls
        .map((args) => String((args[0] as { expression: string }).expression))
        .find((expression) => expression.includes("button.scrollIntoView"));
      expect(script).toContain("window.__oracleSendClickSeen = false;");
      expect(script).toContain("if (!event.isTrusted) return;");
      // The listener must sit on the document, not on a button node React can swap.
      expect(script).toContain("document.addEventListener('click'");
      expect(script).not.toContain("dispatchClickSequence");
    } finally {
      vi.useRealTimers();
    }
  });

  test("keeps the trusted-click marker when React replaces the send button node", async () => {
    vi.useFakeTimers();
    try {
      const dom = createSendButtonDom();
      const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
        if (expression.includes("button.scrollIntoView") || expression.includes("clickSeen")) {
          return { result: { value: dom.run(expression) } };
        }
        return { result: { value: 0 } };
      });
      const input = {
        dispatchMouseEvent: vi.fn(async ({ type }: { type: string }) => {
          if (type !== "mouseReleased") return;
          // ChatGPT re-renders the composer, then the trusted click lands on the
          // fresh node -- the one the arming pass never saw.
          dom.replaceButton();
          dom.dispatchTrustedClick();
        }),
      };

      const result = promptComposer.attemptSendButton({ evaluate } as never, input as never);
      await vi.advanceTimersByTimeAsync(10_000);

      // No composer/stop/turn signal ever flips here: the document-level marker
      // is the only evidence that the click landed, and it must survive the swap.
      await expect(result).resolves.toBe(true);
      expect(input.dispatchMouseEvent).toHaveBeenCalledTimes(3);
      expect(dom.listenerCount()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not retry when the trusted-click marker cannot be read", async () => {
    vi.useFakeTimers();
    try {
      const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
        if (expression.includes("button.scrollIntoView")) {
          return {
            result: {
              value: {
                status: "point",
                x: 10,
                y: 20,
                state: { composerCleared: false, stopVisible: false, turnsCount: 0 },
              },
            },
          };
        }
        // No marker in the reply (destroyed context, navigation): a miss is
        // unproven, so re-clicking would risk sending the prompt twice.
        if (expression.includes("clickSeen")) {
          return {
            result: { value: { composerCleared: false, stopVisible: false, turnsCount: 0 } },
          };
        }
        return { result: { value: 0 } };
      });
      const input = { dispatchMouseEvent: vi.fn(async () => undefined) };
      const logger = Object.assign(vi.fn(), { verbose: false });

      const result = promptComposer.attemptSendButton(
        { evaluate } as never,
        input as never,
        logger as never,
      );
      await vi.advanceTimersByTimeAsync(10_000);

      await expect(result).resolves.toBe(true);
      expect(input.dispatchMouseEvent).toHaveBeenCalledTimes(3);
      // A later commit timeout needs to say why verification passed.
      expect(logger.mock.calls.map(([line]) => String(line)).join("\n")).toContain(
        "could not read the trusted-click marker",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test("logs a thrown verification probe instead of treating it as a miss", async () => {
    vi.useFakeTimers();
    try {
      const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
        if (expression.includes("button.scrollIntoView")) {
          return {
            result: {
              value: {
                status: "point",
                x: 10,
                y: 20,
                state: { composerCleared: false, stopVisible: false, turnsCount: 0 },
              },
            },
          };
        }
        if (expression.includes("clickSeen")) {
          throw new Error("Execution context was destroyed");
        }
        return { result: { value: 0 } };
      });
      const input = { dispatchMouseEvent: vi.fn(async () => undefined) };
      const logger = Object.assign(vi.fn(), { verbose: false });

      const result = promptComposer.attemptSendButton(
        { evaluate } as never,
        input as never,
        logger as never,
      );
      await vi.advanceTimersByTimeAsync(10_000);

      await expect(result).resolves.toBe(true);
      expect(input.dispatchMouseEvent).toHaveBeenCalledTimes(3);
      const lines = logger.mock.calls.map(([line]) => String(line)).join("\n");
      expect(lines).toContain("verification probe threw: Execution context was destroyed");
      expect(lines).not.toContain("could not read the trusted-click marker");
    } finally {
      vi.useRealTimers();
    }
  });
});
