const { buildFilesSection } = require('./files');

/**
 * Build complete system prompt for a model
 */
function buildSystemPrompt(context) {
  const {
    modelId,
    provider,
    projectId,
    projectName,
    conversationInfo,
    systemPrompts
  } = context;

  let prompt = `You are ${modelId} in a multi-model conversation with one user and multiple AI models.

This conversation involves parallel responses from different models. You'll see the full conversation history: each user message followed by other models' replies tagged in brackets (e.g., [ModelName]: ...). Your own previous replies appear as assistant messages.

Respond directly to the user and other models as appropriate. Replies are collected in parallel; do not claim to "go first" or reference response order.

PROJECT CONTEXT
You are working in the "${projectName}" project.

`;

  // Add files section if files exist
  const filesSection = buildFilesSection(projectId);
  if (filesSection) {
    prompt += filesSection + '\n';
  }

  // Add conversation info if provided
  if (conversationInfo) {
    prompt += `CONVERSATION INFO
This conversation has ${conversationInfo.round_count} rounds so far.
${conversationInfo.summary ? `Summary: ${conversationInfo.summary}\n` : ''}
`;
  }

  // Provider-specific sections
  prompt += getProviderSection(provider);

  // User-configured prompts (config defaults merged with any per-request
  // overrides upstream). Placed last so they take precedence over the
  // structural sections above.
  const customSection = buildCustomSection(context);
  if (customSection) {
    prompt += `
CUSTOM INSTRUCTIONS
${customSection}
`;
  }

  return prompt;
}

function replaceModelId(template, modelId) {
  return (template || '').replace(/{{modelId}}/g, modelId);
}

/**
 * Resolve the per-agent override: perAgent[agentId] wins, else
 * perModel[modelIndex]; undefined means "no override" (fall back to the
 * per-provider prompt), '' means "override with nothing".
 */
function resolveAgentPrompt(prompts, context) {
  if (!prompts) return undefined;
  const { agentId, modelIndex } = context;
  const perAgent = prompts.perAgent;
  if (agentId && perAgent && typeof perAgent === 'object' && Object.prototype.hasOwnProperty.call(perAgent, agentId)) {
    const val = perAgent[agentId];
    return typeof val === 'string' ? val : '';
  }
  if (Number.isInteger(modelIndex) && Array.isArray(prompts.perModel) && Object.prototype.hasOwnProperty.call(prompts.perModel, modelIndex)) {
    const val = prompts.perModel[modelIndex];
    return typeof val === 'string' ? val : '';
  }
  return undefined;
}

/**
 * Build the user-configured portion of the prompt: common first, then the
 * per-agent (or per-model-index) override if one exists, otherwise the
 * per-provider prompt.
 */
function buildCustomSection(context) {
  const { systemPrompts, provider, modelId } = context;
  if (!systemPrompts) return '';
  const providerKey = (provider || '').toLowerCase();
  const parts = [];

  const common = replaceModelId(systemPrompts.common || '', modelId);
  if (common.trim()) parts.push(common.trim());

  const agentOverride = resolveAgentPrompt(systemPrompts, context);
  const providerPrompt = (systemPrompts.perProvider && systemPrompts.perProvider[providerKey]) || '';
  const chosen = agentOverride !== undefined ? agentOverride : providerPrompt;
  const resolved = replaceModelId(chosen || '', modelId);
  if (resolved.trim()) parts.push(resolved.trim());

  return parts.join('\n\n');
}

/**
 * Get provider-specific prompt sections
 */
function getProviderSection(provider) {
  const sections = {
    openai: `
REASONING:
You have extended thinking capabilities. Use them for complex analysis, debugging, or planning multi-step solutions.
`,
    anthropic: `
EXTENDED THINKING:
You can use extended thinking for complex reasoning. This is valuable for:
- Analyzing large codebases or datasets
- Debugging intricate issues
- Planning multi-step solutions
`,
    google: `
NOTE:
If you have access to Google Search grounding, you can offer to search for current information when relevant. Other models may not have this capability.
`,
    xai: ``,
    mock: ``
  };

  return sections[provider] || '';
}

module.exports = { buildSystemPrompt };
