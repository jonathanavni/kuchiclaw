# Lean agent container image
# Contains Node.js + Claude Agent SDK — no browser, no heavy tools

# Digest-pinned so a re-tagged upstream image can't silently change the runtime;
# bump deliberately (docker pull node:24-slim && docker inspect --format
# '{{index .RepoDigests 0}}' node:24-slim) alongside dependency updates.
FROM node:24-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df

# Git is needed by Claude Code for file operations
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install container dependencies (claude-agent-sdk bundles the full CLI; tsx
# runs the TypeScript entrypoint), then drop the musl SDK binaries.
#
# npm ci against the committed lockfile — the SDK pin alone floats transitive
# deps, and a floating agent runtime is exactly what a hardened image can't have.
#
# The SDK ships per-platform native binaries as optionalDependencies and its
# resolver checks the musl variant before glibc on Linux. npm doesn't filter
# optional deps by libc, so both binaries get installed and the resolver picks
# the musl one — which the Debian kernel can't exec, surfacing as "claude not
# found". The cleanup must be the FINAL step of the install RUN: any later
# `npm install` re-resolves the tree and pulls musl back in.
COPY container/package.json container/package-lock.json ./
RUN npm ci --omit=dev && \
    npm cache clean --force && \
    rm -rf node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl \
           node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64-musl

# Copy entrypoint
COPY container/entrypoint.ts ./
COPY container/prepare.ts ./

# Create non-root user (Claude Code refuses bypassPermissions as root)
RUN useradd -m -s /bin/bash -u 999 agent

# Create workspace directory owned by agent
RUN mkdir -p /workspace && chown agent:agent /workspace

USER agent

# --disable-sigusr1 closes the inspector-activation channel: the agent shares
# this process's uid and could otherwise send SIGUSR1 to start a debugger,
# connect over container loopback, and read the per-run result-signing key from
# the entrypoint's heap (Yama gates ptrace, not SIGUSR1). `--import tsx` runs
# the TS entrypoint IN this flagged process — no child that would escape it; the
# SDK's own child processes never hold the key, so they don't need the flag.
CMD ["node", "--disable-sigusr1", "--import", "tsx", "entrypoint.ts"]
