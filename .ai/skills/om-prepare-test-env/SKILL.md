# Repository test-environment notes

- Launch the built cezar server through `.ai/scripts/test-env-up.sh`; its app process must use `nohup` with stdin detached so it survives non-interactive bootstrap shells. This prevents a descriptor from reporting a server that is terminated as soon as the bootstrap command exits.
