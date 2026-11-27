# Capability: composer-model-picker

Users can select an available provider and model when composing a task.

## Requirement: Agents without a usable provider

The system SHALL keep an agent with no usable method selectable in the runner picker, SHALL replace its model
chip with a "Configure providers" chip that opens that agent's row in Settings → Agents, and SHALL disable Start
for it.

### Scenario: Codex has no method
- WHEN the user picks Codex and Codex has no usable method
- THEN the model chip reads "Configure providers", Start is disabled, and the chip links to `#agent-codex`

Source: .ai/specs/2026-11-27-per-agent-provider-configuration.md

## Requirement: Models show their method

The system SHALL show under each model the method that serves it ("via OpenRouter"), group models by method for
any-mode agents, and end the menu with "Manage providers".

### Scenario: pi's model menu
- WHEN the user opens pi's model menu
- THEN models appear under "Claude subscription" and "OpenRouter" headings, and the last item is Manage providers

Source: .ai/specs/2026-11-27-per-agent-provider-configuration.md
