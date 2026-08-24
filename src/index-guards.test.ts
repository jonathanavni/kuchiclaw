import { describe, it, expect } from "vitest";
import { installProcessGuards } from "./index.js";

describe("installProcessGuards", () => {
  it("registers unhandledRejection and uncaughtException handlers", () => {
    const before = {
      rejection: process.listeners("unhandledRejection").slice(),
      exception: process.listeners("uncaughtException").slice(),
    };

    installProcessGuards();

    const afterRejection = process.listeners("unhandledRejection");
    const afterException = process.listeners("uncaughtException");
    expect(afterRejection.length).toBe(before.rejection.length + 1);
    expect(afterException.length).toBe(before.exception.length + 1);

    // Remove the handlers we just added so the uncaughtException→exit(1) guard
    // can't take down the rest of the test run.
    for (const l of afterRejection) {
      if (!before.rejection.includes(l)) process.removeListener("unhandledRejection", l);
    }
    for (const l of afterException) {
      if (!before.exception.includes(l)) process.removeListener("uncaughtException", l);
    }
  });
});
