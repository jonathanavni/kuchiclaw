// Compile-time pin that the host and container ContainerOutput declarations
// stay identical. It lives in src/ (not container/) because the root tsconfig
// only compiles src/**/* — pretest's `tsc --noEmit` follows these type-only
// imports into container/entrypoint.ts, so shape drift fails `npm test` at the
// pretest step. (The container-side copy of this pin is transpile-only under
// vitest and can never fail there.)
import { describe, expect, it } from "vitest";
import type { ContainerOutput as HostContainerOutput } from "./types.js";
import type { ContainerOutput as EntrypointContainerOutput } from "../container/prepare.js";

describe("host/container wire-shape parity (compiled by pretest)", () => {
  it("ContainerOutput declarations are identical across the boundary", () => {
    type Equal<A, B> =
      (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
        ? (<T>() => T extends B ? 1 : 2) extends (<T>() => T extends A ? 1 : 2)
          ? true
          : false
        : false;
    const shapesMatch: Equal<HostContainerOutput, EntrypointContainerOutput> = true;
    expect(shapesMatch).toBe(true);
  });
});
