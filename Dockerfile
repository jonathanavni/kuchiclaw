# Lean agent container image
# Contains Node.js + Claude Agent SDK — no browser, no heavy tools

FROM node:20-slim

# Git is needed by Claude Code for file operations
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install container dependencies (claude-agent-sdk bundles the full CLI) +
# tsx for the TypeScript entrypoint, then drop the musl SDK binaries.
#
# The SDK ships per-platform native binaries as optionalDependencies and its
# resolver checks the musl variant before glibc on Linux. npm 10 doesn't
# filter optional deps by libc, so both binaries get installed and the
# resolver picks the musl one — which the Debian kernel can't exec, surfacing
# as "claude not found". The cleanup must be the FINAL step of the install
# RUN: any later `npm install` re-resolves the tree and pulls musl back in.
COPY container/package.json ./
RUN npm install --production && \
    npm install tsx && \
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

CMD ["npx", "tsx", "entrypoint.ts"]
