# Capability: project-agents

Users can see which workspace provider serves each project agent.

## Requirement: Project settings show each agent's method

The system SHALL show, for each agent on a project's Agents page, the method it runs on with a link to that
agent's row in Workspace → Agents, and SHALL disable agents without a usable method in the default-agent and
fallback pickers. A project still overrides the account and the model, never the method.

### Scenario: Codex has no method
- WHEN Codex has no usable method and the user opens the project's Default agent picker
- THEN Codex is listed as disabled with "no provider", and its Default models row reads "No provider · Configure providers"

Source: .ai/specs/2026-11-27-per-agent-provider-configuration.md
