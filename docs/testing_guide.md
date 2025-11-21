# UI Testing Guide with Mock Provider

This guide details how to test the Multi-Model Chat application using the built-in Mock Provider. The Mock Provider allows for cost-free, deterministic, and offline testing of the UI's handling of various LLM response types.

## 1. The Mock Provider

The Mock Provider (`mock`) is a special adapter designed solely for testing. It does not make any external API calls.

### Available Models

| Model ID | Behavior | Use Case |
| :--- | :--- | :--- |
| `mock-echo` | Echoes the user's message back to them. | Verifying basic round-trip connectivity and message display. |
| `mock-lorem` | Returns a paragraph of Lorem Ipsum text. | Verifying layout, text wrapping, and long-content handling. |
| `mock-slow` | Waits 2 seconds before responding. | Verifying loading states, "Thinking..." indicators, and UI responsiveness during latency. |
| `mock-error` | Returns a simulated error message. | Verifying error handling, alert displays, and retry logic. |

## 2. Manual Testing

### Setup
1. Ensure the server is running: `npm start`.
2. Open the application at `http://localhost:3000`.

### Configuration
1. Click **⚙ Configuration** to open the settings panel.
2. Click **+ Add Model** to add a new model row if needed.
3. In the **Provider** dropdown, select **Mock**.
4. In the **Model** dropdown, select the desired behavior (e.g., `Mock Echo`).

### Test Scenarios

#### Basic Chat
1. Configure one model as `Mock Echo`.
2. Type "Hello" and click **Send**.
3. **Verify**: The chat log shows "Echo: User: Hello".

#### Multi-Model Parallelism
1. Configure Model 1 as `Mock Echo`.
2. Configure Model 2 as `Mock Lorem`.
3. Type "Test" and click **Send**.
4. **Verify**: Both models respond. `Mock Echo` returns the echo, and `Mock Lorem` returns a paragraph of text. They should appear roughly simultaneously.

#### Error Handling
1. Configure one model as `Mock Error`.
2. Send any message.
3. **Verify**: The UI displays an error message (typically red text or an alert box) indicating the failure.

#### Loading State
1. Configure one model as `Mock Slow`.
2. Send any message.
3. **Verify**: The UI immediately shows a "Thinking..." or loading indicator. After ~2 seconds, the response appears.

## 3. Automated Testing & Scripting

Automating tests for this UI can be challenging due to dynamic DOM elements and state management. Here are key findings and best practices.

### Selectors
- **Config Panel**: `#configPanel` (toggle with `#toggleConfig`).
- **Model Row**: `.model-row`.
- **Provider Dropdown**: `.model-row .provider`.
- **Model Dropdown**: `.model-row .modelSelect`.
- **Remove Button**: `.model-row .remove`.
- **Input**: `#userMsg`.
- **Send Button**: `#send`.

### Best Practices for Automation

#### 1. JavaScript-Based Setup
Interacting with the Config Panel via simulated clicks can be flaky. It is often more reliable to use JavaScript to programmatically set up the state.

**Example: Setting up Mock Echo**
```javascript
// 1. Select Provider
const row = document.querySelector('.model-row');
const provider = row.querySelector('.provider');
provider.value = 'mock';
provider.dispatchEvent(new Event('change')); // Trigger change listener

// 2. Select Model (wait for async populate if needed)
setTimeout(() => {
  const model = row.querySelector('.modelSelect');
  // Create option if it doesn't exist yet (handling async race conditions)
  if (!model.querySelector('option[value="mock-echo"]')) {
    const opt = document.createElement('option');
    opt.value = 'mock-echo';
    opt.textContent = 'Mock Echo';
    model.appendChild(opt);
  }
  model.value = 'mock-echo';
}, 500);
```

#### 2. Handling the Config Panel
The Config Panel (`#configPanel`) toggles visibility using the `is-hidden` class.
- **To Show**: `document.getElementById('configPanel').classList.remove('is-hidden');`
- **To Hide**: `document.getElementById('configPanel').classList.add('is-hidden');`

> **Warning**: Hiding the config panel programmatically might sometimes cause focus or layout shifts that make the main input area (`#userMsg`) temporarily unreachable by some automation tools. Ensure you scroll or wait for the layout to stabilize.

#### 3. Cache Busting
If you modify `app.js`, the browser might cache the old version. The `index.html` now includes a version query parameter (e.g., `src="app.js?v=3"`). Increment this manually in `index.html` if you make changes to `app.js` that aren't reflecting in tests.
