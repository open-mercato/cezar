# Repository test-environment notes

- Launch the built cezar server through `.ai/scripts/test-env-up.sh`; its app process must use `nohup` with stdin detached so it survives non-interactive bootstrap shells. This prevents a descriptor from reporting a server that is terminated as soon as the bootstrap command exits.
- Since the contract-workspace migration, validate `packages/cezar/dist/index.js` and `packages/cezar/web/dist/index.html` after `npm run build`; `packages/api-client` is typecheck-only and has no `dist/index.js`. Run `CEZ_AGENT_MODELS_LOCKED=1 sh .ai/scripts/test-env-up.sh --force` for locked-model QA.
