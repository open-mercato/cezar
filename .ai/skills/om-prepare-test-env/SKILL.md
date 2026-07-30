# Repository test-environment notes

- Launch the built cezar server through `.ai/scripts/test-env-up.sh`; its app process must use `nohup` with stdin detached so it survives non-interactive bootstrap shells. This prevents a descriptor from reporting a server that is terminated as soon as the bootstrap command exits.
- After the contract/server package split, `npm run build` emits `packages/cezar/dist/index.js`, the inlined `packages/cezar/dist/contract/index.js`, and `packages/cezar/web/dist/index.html`; it deliberately does not emit `packages/api-client/dist/index.js`. Keep those three emitted files as the launcher artifact gate so a successful root build is not rejected.
