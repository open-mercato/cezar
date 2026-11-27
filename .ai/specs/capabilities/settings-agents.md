# Capability: settings-agents

Workspace settings let users set the default agent, model and account for new projects.

## Requirement: Defaults for new projects

The system SHALL set the default agent for new projects with the star on that agent's row, and SHALL set each
agent's default model inside that agent's row, offering only models its connected methods serve plus `auto`.

### Scenario: Starring Codex
- WHEN the user clicks the star on Codex
- THEN new projects start with Codex, and the star moves from the previous default

Source: .ai/specs/2026-11-27-per-agent-provider-configuration.md
