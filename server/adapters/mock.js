/**
 * Mock adapter for testing UI and flow without API costs.
 */

const LOREM_IPSUM = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.";

async function sendMock({ model, messages, options }) {
    const modelId = model || 'mock-echo';

    // Simulate latency (default 500ms, or 2000ms for mock-slow)
    const delay = modelId === 'mock-slow' ? 2000 : 500;
    await new Promise(resolve => setTimeout(resolve, delay));

    if (modelId === 'mock-error') {
        throw new Error('Simulated mock error');
    }

    let text = '';
    const lastMsg = messages[messages.length - 1];
    const userContent = lastMsg && lastMsg.role === 'user' ? lastMsg.content : '';

    switch (modelId) {
        case 'mock-echo':
            text = `Echo: ${userContent}`;
            break;
        case 'mock-lorem':
            text = LOREM_IPSUM;
            break;
        case 'mock-slow':
            text = `Sorry for the wait! I processed: "${userContent.substring(0, 20)}..."`;
            break;
        default:
            text = `Mock response from ${modelId}`;
    }

    return {
        text,
        usage: {
            input_tokens: 10,
            output_tokens: 20,
            total_tokens: 30
        }
    };
}

module.exports = { sendMock };
