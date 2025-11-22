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
    conversationInfo
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

  return prompt;
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
