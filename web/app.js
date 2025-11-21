
const q = (sel, el = document) => el.querySelector(sel);
const qa = (sel, el = document) => Array.from(el.querySelectorAll(sel));

// DOM Elements
const log = q('#log');
const convIdEl = q('#convId');
const userMsgEl = q('#userMsg');
const modelCountEl = q('#modelCount');
const debugToggle = q('#debugToggle');
const attachBtn = q('#attachBtn');
const attachmentFileInput = q('#attachmentFileInput');
const attachmentsPreview = q('#attachmentsPreview');
const refreshModelsBtn = q('#refreshModels');
const togglePromptsBtn = q('#togglePrompts');
const promptPanel = q('#promptPanel');
const promptCommonEl = q('#promptCommon');
const modelPromptList = q('#modelPromptList');
const previewProviderEl = q('#previewProvider');
const previewModelEl = q('#previewModel');
const previewBtn = q('#previewBtn');
const previewCopy = q('#previewCopy');
const downloadMdBtn = q('#downloadMd');
const autoSaveToggle = q('#autoSaveToggle');
const autoSaveNote = q('#autoSaveNote');
const previewOut = q('#previewOut');

let pendingEnableAutosave = false;
let attachedFiles = [];
let MODEL_INDEX = null;

const LOCAL_DEFAULT_PROMPT =
  'You are {{modelId}} in a multi-agent conversation with one user and multiple AI agents.' +
  ' This is a simplified conversation, driven off of user messages. There is one round per user message.' +
  " You will see the full conversation from the beginning: each user message followed by other agents' replies tagged in brackets, e.g., [ModelA]: ..." +
  ' Your own previous replies appear as assistant messages. Respond once per user turn, primarilly addressing the user directly but also addressing the other models as appropriate.';

// --- UI Helpers ---

function addLog(html, type = 'agent') {
  const div = document.createElement('div');
  div.className = `msg ${type}`;
  div.innerHTML = html;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function formatTokenUsage(info) {
  if (!info || typeof info !== 'object') return '';
  const { used, limit, limitBasis, input, output, total, thinking, remaining } = info;
  const pieces = [];
  if (limit !== undefined && output !== undefined) {
    pieces.push(`out ${output} / ${limit}`);
  } else if (used !== undefined && limit !== undefined && limitBasis === 'output') {
    pieces.push(`out ${used} / ${limit}`);
  } else if (used !== undefined) {
    pieces.push(`${used} toks`);
  }

  const detail = [];
  if (input !== undefined) detail.push(`in ${input}`);
  if (output !== undefined) detail.push(`out ${output}`);
  if (thinking !== undefined) detail.push(`think ${thinking}`);
  if (detail.length) pieces.push(`(${detail.join(', ')})`);

  if (!pieces.length) return '';
  return `<span class='tokens'>${pieces.join(' ')}</span>`;
}

// --- Toggles ---

function setupToggle(btnId, panelId) {
  const btn = q(btnId);
  const panel = q(panelId);
  if (btn && panel) {
    btn.addEventListener('click', () => {
      const isHidden = panel.classList.toggle('is-hidden');
      btn.setAttribute('aria-expanded', !isHidden);
      // Rotate arrow
      if (isHidden) {
        btn.style.setProperty('--arrow-rotation', '0deg');
      } else {
        btn.style.setProperty('--arrow-rotation', '180deg');
      }
    });
    // Initialize arrow rotation based on current state
    const initiallyHidden = panel.classList.contains('is-hidden');
    btn.style.setProperty('--arrow-rotation', initiallyHidden ? '0deg' : '180deg');
  }
}

setupToggle('#toggleConfig', '#configPanel');
setupToggle('#toggleAdvanced', '#advancedPanel');
setupToggle('#togglePrompts', '#promptPanel');

// --- Attachments ---

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('read failed'));
    reader.readAsText(file);
  });
}

function renderAttachments() {
  attachmentsPreview.innerHTML = '';
  attachedFiles.forEach((fileData, index) => {
    const chip = document.createElement('div');
    chip.className = 'attachment-chip';
    chip.innerHTML = `
      <span>📄 ${fileData.name}</span>
      <button class="attachment-remove" data-index="${index}">×</button>
    `;
    attachmentsPreview.appendChild(chip);
  });

  qa('.attachment-remove').forEach(btn => {
    btn.onclick = () => {
      const index = parseInt(btn.dataset.index);
      attachedFiles.splice(index, 1);
      renderAttachments();
    };
  });
}

if (attachBtn && attachmentFileInput) {
  attachBtn.addEventListener('click', () => attachmentFileInput.click());
  attachmentFileInput.addEventListener('change', async (e) => {
    const files = Array.from(e.currentTarget.files || []);
    for (const f of files) {
      try {
        const text = await readFileAsText(f);
        attachedFiles.push({ name: f.name, content: text });
      } catch (err) {
        addLog(`<b>Attachment error</b>: <code>${err.message}</code>`, 'error');
      }
    }
    e.currentTarget.value = '';
    renderAttachments();
  });
}

function readTextAttachments() {
  return attachedFiles.map(f => ({
    title: f.name,
    content: f.content
  }));
}

// --- Prompts ---

function markPromptDirty(event) {
  if (event && event.currentTarget) {
    event.currentTarget.dataset.dirty = 'true';
  }
}

function registerPromptInput(el) {
  if (!el) return;
  el.addEventListener('input', markPromptDirty);
}

if (promptCommonEl) registerPromptInput(promptCommonEl);

function getRowAgentId(row) {
  return row && row.dataset ? row.dataset.agentId : undefined;
}

function ensurePromptPlaceholder() {
  if (!modelPromptList) return;
  const hasPrompt = modelPromptList.querySelector('.modelPromptSection');
  const placeholder = modelPromptList.querySelector('.prompt-placeholder');
  if (hasPrompt && placeholder) placeholder.remove();
  if (!hasPrompt && !placeholder) {
    const ph = document.createElement('div');
    ph.className = 'small prompt-placeholder';
    ph.textContent = 'Add models to configure their prompts.';
    modelPromptList.appendChild(ph);
  }
}

function ensurePromptField(row) {
  if (!row || !modelPromptList) return null;
  const id = getRowAgentId(row);
  if (!id) return null;
  let section = modelPromptList.querySelector(`.modelPromptSection[data-agent-id="${id}"]`);
  if (!section) {
    section = document.createElement('div');
    section.className = 'prompt-section modelPromptSection';
    section.dataset.agentId = id;
    section.innerHTML = `
      <label class="modelPromptLabel"></label>
      <textarea class="modelPrompt" data-agent-id="${id}" placeholder="Extra instructions for this model"></textarea>
    `;
    const textarea = q('textarea', section);
    if (textarea) registerPromptInput(textarea);
    modelPromptList.appendChild(section);
  }
  ensurePromptPlaceholder();
  return section;
}

function removePromptField(row) {
  if (!row || !modelPromptList) return;
  const id = getRowAgentId(row);
  if (!id) return;
  const section = modelPromptList.querySelector(`.modelPromptSection[data-agent-id="${id}"]`);
  if (section) section.remove();
  ensurePromptPlaceholder();
}

function getProviderDefaultPrompt(provider) {
  const prompts = (MODEL_INDEX && MODEL_INDEX.prompts && MODEL_INDEX.prompts.perProvider) || {};
  const key = (provider || '').toLowerCase();
  return typeof prompts[key] === 'string' ? prompts[key] : '';
}

function applyModelPromptDefault(row) {
  const section = ensurePromptField(row);
  if (!section) return;
  const textarea = q('textarea', section);
  if (!textarea) return;
  if (textarea.dataset.dirty === 'true') return;
  const provider = q('.provider', row)?.value || 'openai';
  const lastProvider = textarea.dataset.defaultProvider || '';
  if (lastProvider === provider && textarea.value) return;
  textarea.value = getProviderDefaultPrompt(provider);
  textarea.dataset.defaultProvider = provider;
}

function updateModelPromptLabel(row) {
  const section = ensurePromptField(row);
  if (!section) return;
  const labelEl = q('.modelPromptLabel', section);
  if (!labelEl) return;
  const rows = getModelRows();
  const idx = rows.indexOf(row);
  const provider = q('.provider', row)?.value || 'openai';
  const agentName = q('.agentName', row)?.value?.trim();
  let modelChoice = q('select.modelSelect', row)?.value || 'smart';
  if (modelChoice === '__custom__') {
    modelChoice = q('.modelId', row)?.value?.trim() || 'custom';
  }
  const defaultLabel = `Model ${idx >= 0 ? idx + 1 : ''}`.trim();
  const labelBase = agentName ? agentName : defaultLabel;
  labelEl.textContent = `${labelBase} — ${provider} · ${modelChoice}`;
}

function refreshPromptLabels() {
  const rows = getModelRows();
  for (const row of rows) updateModelPromptLabel(row);
}

function refreshAllModelPromptDefaults() {
  const rows = getModelRows();
  for (const row of rows) {
    applyModelPromptDefault(row);
    updateModelPromptLabel(row);
  }
}

function readSystemPrompts() {
  const perAgent = {};
  const rows = getModelRows();
  for (const row of rows) {
    const id = getRowAgentId(row);
    if (!id) continue;
    const section = ensurePromptField(row);
    const textarea = section ? q('textarea', section) : null;
    if (!textarea) continue;
    perAgent[id] = textarea.value || '';
  }
  return {
    common: promptCommonEl ? promptCommonEl.value : '',
    perAgent,
  };
}

// --- Model Management ---

function getProviderModels(provider) {
  const p = (MODEL_INDEX && MODEL_INDEX.providers && MODEL_INDEX.providers[provider]) || {};
  return Array.isArray(p.models) ? p.models : [];
}

function getModelRows() {
  return qa('.models-list > .model-row');
}

function smartLabelFor(provider) {
  const d = (MODEL_INDEX && MODEL_INDEX.defaults && MODEL_INDEX.defaults[provider]) || undefined;
  return d ? `Smart (${d})` : 'Smart (Recommended)';
}

function populateModelSelect(row, preserve = false) {
  const provider = q('.provider', row)?.value || 'openai';
  const sel = q('select.modelSelect', row);
  const customInput = q('input.modelId', row);

  let previous = sel ? sel.value : undefined;
  if (previous === '__custom__') {
    const prevCustom = q('.modelId', row)?.value?.trim();
    if (prevCustom) previous = prevCustom;
  }

  sel.innerHTML = '';

  // Smart option
  const optSmart = document.createElement('option');
  optSmart.value = 'smart';
  optSmart.textContent = smartLabelFor(provider);
  sel.appendChild(optSmart);

  // Separator
  const sep = document.createElement('option');
  sep.disabled = true; sep.textContent = '──────────';
  sel.appendChild(sep);

  // Models
  const list = getProviderModels(provider);
  for (const m of list) {
    const o = document.createElement('option');
    o.value = m.id;
    let t = m.displayName || m.id;
    if (m.thinking) t += ' 🧠';
    if (m.latest) t += ' • latest';
    o.textContent = t;
    sel.appendChild(o);
  }

  // Custom
  const optCustom = document.createElement('option');
  optCustom.value = '__custom__';
  optCustom.textContent = 'Custom…';
  sel.appendChild(optCustom);

  if (preserve && previous && previous !== 'smart') {
    const found = Array.from(sel.options).some(o => o.value === previous);
    if (found) {
      sel.value = previous;
      customInput.style.display = 'none';
    } else {
      sel.value = '__custom__';
      customInput.style.display = '';
      customInput.value = previous;
    }
  } else {
    sel.value = 'smart';
    customInput.style.display = 'none';
  }

  renderOptionsPanel(row);
  applyModelPromptDefault(row);
  updateModelPromptLabel(row);
}

function wireRowEvents(row) {
  const removeBtn = q('.remove', row);
  if (removeBtn) {
    removeBtn.onclick = () => {
      removePromptField(row);
      row.remove();
      syncCountToRows();
      refreshPromptLabels();
    };
  }

  const providerSelect = q('.provider', row);
  if (providerSelect) {
    providerSelect.addEventListener('change', () => {
      row.dataset.provider = providerSelect.value;
      populateModelSelect(row);
    });
    // Set initial provider
    row.dataset.provider = providerSelect.value;
  }

  const modelSelect = q('select.modelSelect', row);
  if (modelSelect) {
    modelSelect.addEventListener('change', (e) => {
      const val = e.currentTarget.value;
      const customInput = q('input.modelId', row);
      if (val === '__custom__') {
        customInput.style.display = '';
        customInput.focus();
      } else {
        customInput.style.display = 'none';
      }
      updateModelPromptLabel(row);
    });
  }

  const customInput = q('input.modelId', row);
  if (customInput) customInput.addEventListener('input', () => updateModelPromptLabel(row));

  const agentNameInput = q('.agentName', row);
  if (agentNameInput) agentNameInput.addEventListener('input', () => updateModelPromptLabel(row));

  const toggle = q('.optsToggle', row);
  if (toggle) {
    toggle.addEventListener('click', () => {
      const panel = q('.opts', row);
      if (!panel) return;
      const hidden = panel.style.display === 'none';
      panel.style.display = hidden ? 'block' : 'none';
    });
  }
}

function makeModelRow() {
  const row = document.createElement('div');
  row.className = 'model-row';
  row.dataset.agentId = `agent-${Math.random().toString(36).slice(2, 10)}`;

  row.innerHTML = `
    <div class="control-group" style="margin-bottom: 0.5rem;">
      <select class="provider">
        <option value="openai">OpenAI</option>
        <option value="anthropic">Anthropic</option>
        <option value="google">Google</option>
        <option value="xai">xAI</option>
        <option value="mock">Mock</option>
      </select>
      <select class="modelSelect" style="flex: 1; min-width: 200px;"></select>
      <input class="modelId" placeholder="Custom model ID" style="display:none; flex: 1;" />
      <input class="agentName" placeholder="Agent Name (Optional)" />
      <button type="button" class="optsToggle">⚙ Options</button>
      <button class="remove" style="color: #EF4444; border-color: rgba(239,68,68,0.3);">×</button>
    </div>
    <div class="opts" style="display:none; padding-top: 1rem; border-top: 1px solid var(--border-light);">
      <div class="optsBody"></div>
    </div>
  `;

  wireRowEvents(row);
  populateModelSelect(row);
  return row;
}

function renderOptionsPanel(row) {
  const provider = q('.provider', row)?.value || 'openai';
  const body = q('.optsBody', row);
  if (!body) return;

  const common = `
    <div class="control-group">
      <div>
        <label>Max Tokens</label><br/>
        <input class="opt-maxTokens" type="number" min="1" placeholder="(unset)" style="width:100px"/>
      </div>
      <div>
        <label>Temp</label><br/>
        <input class="opt-temp" type="number" step="0.1" min="0" max="2" placeholder="(unset)" style="width:80px"/>
      </div>
      <div>
        <label>Top-P</label><br/>
        <input class="opt-topP" type="number" step="0.01" min="0" max="1" placeholder="(unset)" style="width:80px"/>
      </div>
      <div>
        <label>Seed</label><br/>
        <input class="opt-seed" type="number" step="1" placeholder="(unset)" style="width:100px"/>
      </div>
    </div>
  `;

  let providerSpecific = '';
  if (provider === 'openai') {
    providerSpecific = `
      <div class="control-group">
        <div>
          <label>Reasoning Effort</label><br/>
          <select class="opt-oai-effort">
            <option value="">(Default)</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </div>
      </div>
      <div style="border-top: 1px solid var(--border-color); padding-top: 12px; margin-top: 12px;">
        <label style="font-family: var(--font-display); margin-bottom: 8px; display: block;">Tools</label>
        <div class="control-group" style="flex-direction: column; align-items: flex-start; gap: 8px;">
          <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
            <input type="checkbox" class="opt-tool-websearch"/> Web Search
          </label>
          <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
            <input type="checkbox" class="opt-tool-codeinterpreter"/> Code Interpreter
          </label>
        </div>
      </div>
    `;
  } else if (provider === 'anthropic') {
    providerSpecific = `
      <div class="control-group">
        <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
          <input type="checkbox" class="opt-anth-thinking"/> Enable Thinking
        </label>
        <div>
          <label>Budget Tokens</label><br/>
          <input class="opt-anth-budget" type="number" min="1" placeholder="(env/default)" style="width:120px"/>
        </div>
      </div>
      <div style="border-top: 1px solid var(--border-color); padding-top: 12px; margin-top: 12px;">
        <label style="font-family: var(--font-display); margin-bottom: 8px; display: block;">Tools</label>
        <div class="control-group" style="flex-direction: column; align-items: flex-start; gap: 8px;">
          <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
            <input type="checkbox" class="opt-tool-websearch"/> Web Search <span class="small" style="opacity: 0.7;">($10/1k searches)</span>
          </label>
          <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
            <input type="checkbox" class="opt-tool-codeexecution"/> Code Execution <span class="small" style="opacity: 0.7;">(50hr free/day)</span>
          </label>
        </div>
      </div>
    `;
  } else if (provider === 'google') {
    providerSpecific = `
      <div style="border-top: 1px solid var(--border-color); padding-top: 12px; margin-top: 12px;">
        <label style="font-family: var(--font-display); margin-bottom: 8px; display: block;">Tools</label>
        <div class="control-group" style="flex-direction: column; align-items: flex-start; gap: 8px;">
          <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
            <input type="checkbox" class="opt-google-grounding"/> Google Search (Grounding)
          </label>
          <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
            <input type="checkbox" class="opt-tool-codeexecution"/> Code Execution
          </label>
        </div>
      </div>
    `;
  } else if (provider === 'xai') {
    providerSpecific = `
      <div style="border-top: 1px solid var(--border-color); padding-top: 12px; margin-top: 12px;">
        <label style="font-family: var(--font-display); margin-bottom: 8px; display: block;">Tools (Server-Side Agentic)</label>
        <div class="control-group" style="flex-direction: column; align-items: flex-start; gap: 8px;">
          <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
            <input type="checkbox" class="opt-tool-websearch"/> Web Search
          </label>
          <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
            <input type="checkbox" class="opt-tool-xsearch"/> X (Twitter) Search
          </label>
          <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
            <input type="checkbox" class="opt-tool-codeexecution"/> Code Execution
          </label>
          <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
            <input type="checkbox" class="opt-tool-imageunderstanding"/> Image/Video Understanding
          </label>
        </div>
      </div>
    `;

  } else if (provider === 'mock') {
    providerSpecific = `
      <div class="control-group">
        <div style="padding: 8px; color: var(--text-muted); font-size: 0.9rem;">
          Mock provider for testing. Select a model to simulate different behaviors.
        </div>
      </div>
      `;
  }

  body.innerHTML = common + providerSpecific;
}

function syncRowsToCount() {
  const desired = Math.max(1, Math.min(12, parseInt(modelCountEl.value || '1', 10)));
  const container = q('.models-list');
  const rows = getModelRows();

  if (rows.length < desired) {
    for (let i = rows.length; i < desired; i++) container.appendChild(makeModelRow());
  } else if (rows.length > desired) {
    for (let i = rows.length; i > desired; i--) {
      const row = rows[i - 1];
      removePromptField(row);
      row.remove();
    }
  }
  modelCountEl.value = String(desired);
  refreshPromptLabels();
}

function syncCountToRows() {
  const rows = getModelRows();
  modelCountEl.value = String(rows.length);
  refreshPromptLabels();
}

// --- Data Reading ---

function parseNum(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function buildOptionsForRow(row, provider) {
  const opts = {};
  const maxTokens = parseNum(q('.opt-maxTokens', row)?.value);
  if (maxTokens !== undefined) opts.maxTokens = Math.floor(maxTokens);

  const temp = parseNum(q('.opt-temp', row)?.value);
  const topP = parseNum(q('.opt-topP', row)?.value);
  const seed = parseNum(q('.opt-seed', row)?.value);

  // Build tools array
  const tools = [];

  if (provider === 'google') {
    const gen = {};
    if (temp !== undefined) gen.temperature = temp;
    if (topP !== undefined) gen.topP = topP;
    if (Object.keys(gen).length) {
      opts.extraBody = Object.assign({}, opts.extraBody, { generationConfig: gen });
    }

    // Google Search tool
    const groundingOn = q('.opt-google-grounding', row)?.checked;
    if (groundingOn) {
      tools.push({ googleSearch: {} });
    }

    // Code Execution tool
    const codeExecOn = q('.opt-tool-codeexecution', row)?.checked;
    if (codeExecOn) {
      tools.push({ codeExecution: {} });
    }

    if (tools.length) {
      opts.extraBody = Object.assign({}, opts.extraBody, { tools });
    }
  } else {
    if (temp !== undefined || topP !== undefined || seed !== undefined) {
      const eb = Object.assign({}, opts.extraBody);
      if (temp !== undefined) eb.temperature = temp;
      if (topP !== undefined) eb.top_p = topP;
      if (seed !== undefined) eb.seed = seed;
      opts.extraBody = eb;
    }
  }

  if (provider === 'openai') {
    const effort = q('.opt-oai-effort', row)?.value || '';
    if (effort) opts.reasoning = { effort };

    // OpenAI tools
    if (q('.opt-tool-websearch', row)?.checked) {
      tools.push({ type: 'web_search' });
    }
    if (q('.opt-tool-codeinterpreter', row)?.checked) {
      tools.push({ type: 'code_interpreter' });
    }
    if (tools.length) opts.tools = tools;

  } else if (provider === 'anthropic') {
    const thinkingOn = q('.opt-anth-thinking', row)?.checked;
    const budget = parseNum(q('.opt-anth-budget', row)?.value);
    if (thinkingOn) {
      opts.thinking = { type: 'enabled' };
      if (budget !== undefined) opts.thinking.budget_tokens = Math.floor(budget);
    }

    // Claude tools
    if (q('.opt-tool-websearch', row)?.checked) {
      tools.push({ type: 'web_search_20250305', name: 'web_search' });
    }
    if (q('.opt-tool-codeexecution', row)?.checked) {
      tools.push({ type: 'code_execution_20250825', name: 'code_execution' });
    }
    if (tools.length) opts.tools = tools;

  } else if (provider === 'xai') {
    // xAI tools (server-side agentic)
    if (q('.opt-tool-websearch', row)?.checked) {
      tools.push({ type: 'live_search' });
    }
    if (q('.opt-tool-xsearch', row)?.checked) {
      tools.push({ type: 'x_search' });
    }
    if (q('.opt-tool-codeexecution', row)?.checked) {
      tools.push({ type: 'code_execution' });
    }
    if (q('.opt-tool-imageunderstanding', row)?.checked) {
      tools.push({ type: 'view_image' });
      tools.push({ type: 'view_x_video' });
    }
    if (tools.length) opts.tools = tools;
  }

  return opts;
}

function readModels() {
  const rows = getModelRows();
  const models = [];
  for (const r of rows) {
    const provider = q('.provider', r)?.value?.trim();
    let modelId = q('select.modelSelect', r)?.value;
    if (modelId === '__custom__') modelId = q('.modelId', r)?.value?.trim();
    if (!modelId) modelId = 'smart';

    if (provider && modelId) {
      const options = buildOptionsForRow(r, provider);
      const entry = { provider, modelId };
      const name = q('.agentName', r)?.value?.trim();
      if (name) entry.name = name;
      const agentId = getRowAgentId(r);
      if (agentId) entry.agentId = agentId;
      if (options && Object.keys(options).length) entry.options = options;
      models.push(entry);
    }
  }
  return models;
}

// --- Initialization & Events ---

async function loadModelsIndex() {
  try {
    const resp = await fetch('/api/models');
    const json = await resp.json();
    if (!resp.ok) throw new Error(json && json.error || resp.statusText);
    MODEL_INDEX = json || {};
  } catch (e) {
    console.warn('Failed to load /api/models:', e);
    MODEL_INDEX = { defaults: {}, providers: {}, prompts: { common: LOCAL_DEFAULT_PROMPT, perProvider: {} } };
  }

  if (!MODEL_INDEX.defaults) MODEL_INDEX.defaults = {};
  if (!MODEL_INDEX.providers) MODEL_INDEX.providers = {};
  if (!MODEL_INDEX.prompts) MODEL_INDEX.prompts = { common: LOCAL_DEFAULT_PROMPT, perProvider: {} };

  // Apply defaults
  if (promptCommonEl && !promptCommonEl.dataset.dirty) {
    promptCommonEl.value = MODEL_INDEX.prompts.common || LOCAL_DEFAULT_PROMPT;
  }
  refreshAllModelPromptDefaults();
}

function findPreviewAgentId(provider, modelId) {
  const rows = getModelRows();
  for (const row of rows) {
    const rowProvider = q('.provider', row)?.value;
    if (rowProvider !== provider) continue;
    if (!modelId) return getRowAgentId(row);
    let rowModel = q('select.modelSelect', row)?.value || 'smart';
    if (rowModel === '__custom__') {
      rowModel = q('.modelId', row)?.value?.trim() || 'custom';
    }
    if (rowModel === modelId) return getRowAgentId(row);
  }
  return undefined;
}

function populatePreviewModel() {
  const provider = previewProviderEl?.value || 'openai';
  if (!previewModelEl) return;

  previewModelEl.innerHTML = '';
  const optSmart = document.createElement('option');
  optSmart.value = 'smart';
  optSmart.textContent = smartLabelFor(provider);
  previewModelEl.appendChild(optSmart);

  const sep = document.createElement('option');
  sep.disabled = true; sep.textContent = '──────────';
  previewModelEl.appendChild(sep);

  const list = getProviderModels(provider);
  for (const m of list) {
    const o = document.createElement('option');
    o.value = m.id;
    o.textContent = m.displayName || m.id;
    previewModelEl.appendChild(o);
  }
  previewModelEl.value = 'smart';
}

// Event Listeners
q('#addModel').onclick = () => {
  const container = q('.models-list');
  container.appendChild(makeModelRow());
  syncCountToRows();
};

modelCountEl.addEventListener('change', syncRowsToCount);
modelCountEl.addEventListener('input', syncRowsToCount);

if (refreshModelsBtn) {
  refreshModelsBtn.addEventListener('click', async () => {
    await loadModelsIndex();
    const rows = getModelRows();
    for (const r of rows) populateModelSelect(r, true);
    populatePreviewModel();
  });
}

q('#reset').onclick = () => { convIdEl.value = ''; log.innerHTML = ''; };

q('#send').onclick = async () => {
  const userMessage = userMsgEl.value.trim();
  if (!userMessage) return;

  const targetModels = readModels();
  if (!targetModels.length) { alert('Add at least one model'); return; }

  addLog(`
      <div class="msg-header"><b>User</b></div>
        <div class="msg-content">${userMessage.replace(/</g, '&lt;')}</div>
    `, 'user');

  const attsForLog = readTextAttachments();
  if (attsForLog.length) {
    const names = attsForLog.map(a => (a.title || '').trim() || 'untitled');
    addLog(`<div class='small'>Attachments: ${names.map(n => n.replace(/</g, '&lt;')).join(', ')}</div>`, 'user');
  }

  // Show loading indicator
  const loadingMsg = document.createElement('div');
  loadingMsg.className = 'msg loading';
  loadingMsg.id = 'loading-indicator';
  loadingMsg.innerHTML = `
      <span style="font-family: var(--font-display); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-secondary);">Thinking</span>
        <div class="loading-dots">
          <span></span>
          <span></span>
          <span></span>
        </div>
    `;
  log.appendChild(loadingMsg);
  log.scrollTop = log.scrollHeight;

  userMsgEl.value = '';

  const body = {
    conversationId: convIdEl.value.trim() || undefined,
    userMessage,
    targetModels,
    systemPrompts: readSystemPrompts(),
    textAttachments: readTextAttachments(),
  };

  try {
    const url = debugToggle && debugToggle.checked ? '/api/turn?debug=1' : '/api/turn';

    // Use fetch with streaming
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const json = await response.json();
      throw new Error(json && json.error || response.statusText);
    }

    // Parse SSE stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    async function readStream() {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || ''; // Keep incomplete line in buffer

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = JSON.parse(line.slice(6));

              if (data.type === 'init') {
                convIdEl.value = data.conversationId;

                // Handle pending autosave
                if (pendingEnableAutosave && data.conversationId) {
                  try {
                    const resp2 = await fetch(`/api/conversation/${encodeURIComponent(data.conversationId)}/autosave`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ enabled: true, format: 'md' })
                    });
                    const j2 = await resp2.json();
                    if (resp2.ok) {
                      autoSaveNote.textContent = j2 && j2.path ? `Auto‑saving to ${j2.path}` : 'Auto‑save enabled';
                      pendingEnableAutosave = false;
                    } else {
                      autoSaveNote.textContent = `Auto‑save failed: ${String(j2 && j2.error || resp2.statusText)}`;
                    }
                  } catch (e) {
                    autoSaveNote.textContent = `Auto‑save failed: ${e.message}`;
                  }
                }
              } else if (data.type === 'result') {
                const r = data.result;
                const headerName = r.name ? `${r.name} <span class='small'>(${r.modelId})</span>` : r.modelId;
                const from = r.requestedModelId && r.requestedModelId !== r.modelId ? ` <span class='small'>(from ${r.requestedModelId})</span>` : '';
                const tokensText = formatTokenUsage(r.tokenUsage);
                const headerExtras = `${from}${tokensText ? ` ${tokensText}` : ''}`;

                if (r.error) {
                  addLog(`
                    <div class="msg-header"><b>${headerName}</b> ${headerExtras}</div>
                    <div class="msg-content">Error: ${r.error}</div>
                  `, 'error');
                } else {
                  const text = (r.text || '');
                  const citations = Array.isArray(r?.meta?.citations) ? r.meta.citations : [];
                  let citsHtml = '';
                  if (citations.length) {
                    const items = citations.slice(0, 6).map(c => {
                      const url = (c.uri || '').replace(/\"/g, '&quot;');
                      const label = (c.title || url || '').replace(/</g, '&lt;');
                      return `<a href="${url}" target="_blank" rel="nofollow noopener">${label}</a>`;
                    });
                    citsHtml = `<div class='small' style='margin-top:6px; opacity:0.7;'>Citations: ${items.join(' • ')}</div>`;
                  }

                  addLog(`
                    <div class="msg-header"><b>${headerName}</b> ${headerExtras}</div>
                    <div class="msg-content">${text.replace(/</g, '&lt;')}</div>
                    ${citsHtml}
                  `, 'agent');
                }
              } else if (data.type === 'done') {
                // All responses received
                attachedFiles = [];
                renderAttachments();

                // Remove loading indicator
                const loadingIndicator = q('#loading-indicator');
                if (loadingIndicator) loadingIndicator.remove();
              }
            }
          }
        }
      } catch (err) {
        console.error('Stream reading error:', err);
        throw err;
      }
    }

    await readStream();

  } catch (e) {
    addLog(`<b>Error</b>: <code>${e.message}</code>`, 'error');

    // Remove loading indicator on error
    const loadingIndicator = q('#loading-indicator');
    if (loadingIndicator) loadingIndicator.remove();
  }

  userMsgEl.focus();
};

if (previewBtn && previewProviderEl && previewModelEl) {
  previewBtn.onclick = async () => {
    const provider = previewProviderEl.value;
    const previewModel = previewModelEl.value;
    const body = {
      conversationId: convIdEl.value.trim() || undefined,
      provider,
      modelId: previewModel,
      agentId: findPreviewAgentId(provider, previewModel),
      userMessage: userMsgEl.value || '',
      systemPrompts: readSystemPrompts(),
      textAttachments: readTextAttachments(),
    };
    try {
      const resp = await fetch('/api/preview-view', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json && json.error || resp.statusText);
      previewOut.textContent = JSON.stringify(json, null, 2);
    } catch (e) {
      previewOut.textContent = `Error: ${e.message}`;
    }
  };
}

if (previewCopy && navigator && navigator.clipboard) {
  previewCopy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(previewOut.textContent || '');
      addLog(`<div class='small'>Preview copied to clipboard</div>`, 'agent');
    } catch (e) {
      addLog(`<b>Copy failed</b>: <code>${e.message}</code>`, 'error');
    }
  };
}

if (downloadMdBtn) {
  downloadMdBtn.onclick = async () => {
    const id = convIdEl.value.trim();
    if (!id) { alert('No conversation to download yet.'); return; }
    try {
      const resp = await fetch(`/api/conversation/${encodeURIComponent(id)}/export?format=md`);
      const text = await resp.text();
      if (!resp.ok) throw new Error(text || resp.statusText);
      const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `conversation-${id}.md`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
    } catch (e) {
      addLog(`<b>Download failed</b>: <code>${e.message}</code>`, 'error');
    }
  };
}

if (autoSaveToggle) {
  autoSaveToggle.addEventListener('change', async () => {
    const id = convIdEl.value.trim();
    if (!id) {
      pendingEnableAutosave = autoSaveToggle.checked;
      autoSaveNote.textContent = autoSaveToggle.checked ? 'Will enable on next send…' : '';
      return;
    }
    try {
      const resp = await fetch(`/api/conversation/${encodeURIComponent(id)}/autosave`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !!autoSaveToggle.checked, format: 'md' })
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json && json.error || resp.statusText);
      autoSaveNote.textContent = json && json.path ? `Auto‑saving to ${json.path}` : (autoSaveToggle.checked ? 'Auto‑save enabled' : '');
    } catch (e) {
      autoSaveNote.textContent = `Auto‑save failed: ${e.message}`;
    }
  });
}

userMsgEl.addEventListener('keypress', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    q('#send').click();
  }
});

// Init
(async function init() {
  await loadModelsIndex();
  const container = q('.models-list');
  container.appendChild(makeModelRow());
  container.appendChild(makeModelRow());
  syncCountToRows();
  populatePreviewModel();
  if (previewProviderEl) previewProviderEl.addEventListener('change', populatePreviewModel);

  // Expose for testing
  window.MODEL_INDEX = MODEL_INDEX;
  window.populatePreviewModel = populatePreviewModel;
})();
