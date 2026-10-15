# Base image for cezar agent containers.
#
# A repo's own image is expected to build FROM this and add its toolchain, so
# the long-lived per-repo container starts with dependencies already present —
# that is what "each new task must not get a clean image" means in practice.
FROM docker.io/library/node:22-bookworm

# What cezar's agents assume exists: git (worktrees), gh (pull requests),
# ripgrep (the Grep tool's fast path), less (pagers that would otherwise hang).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git ca-certificates curl gnupg ripgrep less \
 && rm -rf /var/lib/apt/lists/*

# GitHub CLI from its own repo — Debian's package is far behind.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# The agent CLIs themselves. Kimi Code needs Node >= 22.19, which this image's
# node:22 satisfies; its npm build is the same program as the native installer's.
RUN npm install -g @anthropic-ai/claude-code @moonshot-ai/kimi-code

# CLIs an agent reaches for once their credential is passed through (Settings →
# Isolation): without the binary in the image, a ticked credential has nothing to
# authenticate. `gh` is installed above from its own apt repo.
RUN npm install -g @railway/cli

# The other runners' CLIs, and tools a ticked credential needs (az), only once a
# task has needed one (`CEZ_AGENTS`, set by cezar): the runners together add ~1.5 GB,
# most of it Cursor, and az another ~640 MB.
# Junie's npm package is a shim that downloads the real binary on first run, so
# that run happens here rather than in every new container.
ARG CEZ_AGENTS=""
RUN set -e; for agent in $CEZ_AGENTS; do case "$agent" in \
      codex)    npm install -g --no-fund --no-audit @openai/codex ;; \
      opencode) npm install -g --no-fund --no-audit opencode-ai ;; \
      pi)       npm install -g --no-fund --no-audit @mariozechner/pi-coding-agent ;; \
      copilot)  npm install -g --no-fund --no-audit @github/copilot ;; \
      junie)    npm install -g --no-fund --no-audit @jetbrains/junie && junie --version ;; \
      cursor)   curl -fsSL https://cursor.com/install | bash ;; \
      azure-cli) curl -fsSL https://aka.ms/InstallAzureCLIDeb | bash && rm -rf /var/lib/apt/lists/* ;; \
      *)        echo "unknown agent: $agent" >&2; exit 1 ;; \
    esac; done
# Cursor's installer puts `agent` here.
ENV PATH=/root/.local/bin:$PATH

# The image is the version pin: an agent that updates itself inside a
# per-task container would re-download on every task and drift from it.
ENV KIMI_CODE_NO_AUTO_UPDATE=1

# Agent scratch, deliberately NOT on any bind mount: the native claude binary
# does a startup temp-file operation that a macOS bind mount cannot serve, and
# dies with an opaque "ENOENT: no such file or directory, fstat" before it logs
# anything. cezar's per-run TMPDIR points into the repo, so the launcher
# overrides it to this path.
ENV TMPDIR=/tmp/cez-agent
RUN mkdir -p /tmp/cez-agent

# The agent's own Claude identity is mounted here (see the launcher): a volume,
# so conversations survive the container and can never be stranded inside a
# stopped one.
VOLUME ["/root/.claude"]

# Kimi's, likewise: the agent's own `~/.kimi-agent` on the host, with the host's
# Kimi login directories mounted inside it.
VOLUME ["/root/.kimi-code"]

CMD ["sleep", "infinity"]
