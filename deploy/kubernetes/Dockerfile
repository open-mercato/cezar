# EXAMPLE image for a cezar fleet node (hub or worker). Not published by this repo: build it, push it
# to your registry and point hub.yaml / workers.yaml at it.
#
#   docker build -t registry.example.com/cezar-fleet:latest deploy/kubernetes
#
# Agent CLIs are baked in at build time; add the ones you use (Cursor, OpenCode, ...) the same way.
FROM node:22-slim

ARG CEZAR_VERSION=latest
ARG INSTALL_AGENTS="@anthropic-ai/claude-code @openai/codex"

# git for worktrees, curl/gnupg to add the GitHub CLI apt source, gh for clones and draft PRs.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl gnupg openssh-client \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g @open-mercato/cezar@${CEZAR_VERSION} ${INSTALL_AGENTS} && npm cache clean --force

# Everything stateful lives under /data (a PVC in the manifests): the workspace home, cloned repos and
# the boot directory cezar serves from.
ENV CEZ_HOME=/data/cezar-home \
    CEZ_PROJECTS_DIR=/data/projects \
    HOME=/home/node
USER node
WORKDIR /data/boot

# Credentials arrive as env from Secrets (see workers.yaml): GH_TOKEN lets `gh` clone and push,
# ANTHROPIC_API_KEY / OPENAI_API_KEY drive the agent CLIs.
CMD ["sh", "-c", "mkdir -p \"$CEZ_HOME\" \"$CEZ_PROJECTS_DIR\" /data/boot && git config --global user.name \"${GIT_AUTHOR_NAME:-cezar}\" && git config --global user.email \"${GIT_AUTHOR_EMAIL:-cezar@localhost}\" && { [ -z \"$GH_TOKEN\" ] || gh auth setup-git; } && exec cezar serve --no-open --repo /data/boot"]
