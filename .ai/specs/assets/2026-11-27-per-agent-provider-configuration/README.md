# Agents → providers per agent (mockup context)

Mockups: `settings.html` (Settings → Agents) and `composer.html` (new task), linked from `index.html`. Offline, simulated data.
Styling: `cockpit.css` copies the dark-theme tokens, type scale and fonts from `packages/web/src/styles/index.css`. The composer's chips and menus follow the live new-task page.
Source: the user's request and their screenshot of the current pi auth-methods panel.
No product brief or synthetic panel exists for this flow.

## Model
- Each agent has a mode badge in its header.
  - **One at a time** (Claude, Codex): radio list, exactly one provider "in use". The others stay signed in. Disconnecting the active one leaves the agent with "no provider".
  - **Any combination** (OpenCode, pi): every connected provider is active and adds its models to the default-model picker, grouped by provider, as in the current pi panel.
- Providers per agent:
  - Claude: Anthropic subscription, OpenRouter, Custom provider
  - Codex: OpenAI subscription, OpenRouter, Custom provider
  - pi: Anthropic subscription, OpenAI subscription, OpenRouter, Custom provider
- Custom provider opens an inline form: name, base URL, model id, API key.

## Assumptions
- [ASSUMPTION] OpenCode is "Any combination" with the same four providers as pi. The request listed it without a mode.
- [ASSUMPTION] Credentials are per agent, as in today's pi panel. A shared credential pool across agents would be a different design.
- [ASSUMPTION] Providers the current pi panel offers beyond these four (Mistral, xAI, LLM Gateway, OpenCode key…) are dropped or folded into Custom provider.
- [ASSUMPTION] Custom provider is OpenAI-compatible for Codex, Anthropic-compatible for Claude, either for pi/OpenCode.

## Verification
Walked in agent-browser: signing Codex into OpenAI selects it and sets a model; removing pi's OpenRouter key shrinks its model list; configuring and picking a custom provider for Claude switches it and its model. Composer: no badge. The model menu ends with Manage providers. An agent with no provider shows a Configure providers chip in place of the model chip. Both link to `settings.html#agent=<id>`.
Screenshots: `shots-settings.png`, `shots-composer-pi.png`, `shots-composer-codex.png`.

## Where today's Agents settings go
Source: `routes/settings/agents-global-section.tsx`, `accounts-section.tsx`, `skills-section.tsx`, `global-instructions-section.tsx`, `agents-section.tsx` on this branch.
- Global instructions: unchanged, first card of Workspace → Agents (`settings.html`).
- Installed on this machine: becomes the Agents card. Version sits in each agent's header and footer, with an Update link when one exists. "Show N not installed" lists the rest with their install command and an Install button.
- Defaults for new projects: the star picks the default agent, and each agent's Default model replaces the per-agent model list.
- Accounts (second logins): fold into the subscription row's account menu. It lists the logins, picks the one new projects use, and adds another.
- Skill repositories: unchanged, last card.
- Agent config files: a "Config files and MCP" link in each agent's footer. The page itself stays where it is.
- Project → Agents (`project-agents.html`): Default agent and account, Default models with Inherit, and Automatic fallback keep their place. Each agent shows its provider with a link to Workspace → Agents. Agents without a provider cannot be picked.
- [ASSUMPTION] Second logins exist only for subscriptions. API keys and custom providers hold one credential each.
