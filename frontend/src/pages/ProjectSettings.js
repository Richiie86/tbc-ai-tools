import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import axios from 'axios';
import OpHeader from '../components/OpHeader';
import '../styles/ProjectSettings.css';

function ProjectSettings() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [project, setProject] = useState(null);
  const [openaiKey, setOpenaiKey] = useState('');
  const [anthropicKey, setAnthropicKey] = useState('');
  const [geminiKey, setGeminiKey] = useState('');
  const [groqKey, setGroqKey] = useState('');

  useEffect(() => {
    loadProject();
  }, [projectId]);

  const loadProject = async () => {
    try {
      const token = localStorage.getItem('token');
      const res = await axios.get(`/api/operator/projects/${projectId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setProject(res.data);
      setLoading(false);
    } catch (err) {
      toast.error('Failed to load project');
      navigate('/operator');
    }
  };

  const handleSaveKey = async (provider, key) => {
    if (!key || !key.trim()) {
      toast.error('Key cannot be empty');
      return;
    }
    try {
      const token = localStorage.getItem('token');
      await axios.post(
        `/api/keys/${provider}`,
        { key: key.trim(), project_id: projectId },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      toast.success(`${provider.toUpperCase()} key saved`);
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to save key');
    }
  };

  const handleTestKey = async (provider, key) => {
    if (!key || !key.trim()) {
      toast.error('Key cannot be empty');
      return;
    }
    try {
      const token = localStorage.getItem('token');
      await axios.post(
        `/api/keys/${provider}/test`,
        { key: key.trim() },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      toast.success(`${provider.toUpperCase()} key is valid ✓`);
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Key test failed');
    }
  };

  if (loading) {
    return (
      <div className="project-settings-page" data-testid="project-settings-page">
        <OpHeader />
        <div className="settings-container">
          <p>Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="project-settings-page" data-testid="project-settings-page">
      <OpHeader />
      <div className="settings-container">
        <h1>Project Settings: {project?.name || projectId}</h1>
        <p className="settings-subtitle">Configure API keys for this deployment</p>

        <section className="api-keys-section">
          <h2>APIKey+</h2>
          <p className="section-hint">Store encrypted API keys for third-party integrations</p>

          {/* OpenAI */}
          <div className="api-key-row">
            <label htmlFor="openai-api-key">
              <span className="provider-name">🤖 OpenAI</span>
              <span className="provider-hint">Get your key at platform.openai.com/api-keys</span>
            </label>
            <div className="key-input-wrapper">
              <input
                id="openai-api-key"
                type="password"
                placeholder="sk-..."
                value={openaiKey}
                onChange={(e) => setOpenaiKey(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
              <button onClick={() => handleSaveKey('openai', openaiKey)}>
                Save
              </button>
              <button onClick={() => handleTestKey('openai', openaiKey)}>
                Test
              </button>
            </div>
          </div>

          {/* Anthropic */}
          <div className="api-key-row">
            <label htmlFor="anthropic-api-key">
              <span className="provider-name">🧠 Anthropic Claude</span>
              <span className="provider-hint">Get your key at console.anthropic.com/settings/keys</span>
            </label>
            <div className="key-input-wrapper">
              <input
                id="anthropic-api-key"
                type="password"
                placeholder="sk-ant-..."
                value={anthropicKey}
                onChange={(e) => setAnthropicKey(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
              <button onClick={() => handleSaveKey('anthropic', anthropicKey)}>
                Save
              </button>
              <button onClick={() => handleTestKey('anthropic', anthropicKey)}>
                Test
              </button>
            </div>
          </div>

          {/* Google Gemini */}
          <div className="api-key-row">
            <label htmlFor="gemini-api-key">
              <span className="provider-name">✨ Google Gemini</span>
              <span className="provider-hint">Get your key at aistudio.google.com/apikey</span>
            </label>
            <div className="key-input-wrapper">
              <input
                id="gemini-api-key"
                type="password"
                placeholder="AIza..."
                value={geminiKey}
                onChange={(e) => setGeminiKey(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
              <button onClick={() => handleSaveKey('gemini', geminiKey)}>
                Save
              </button>
              <button onClick={() => handleTestKey('gemini', geminiKey)}>
                Test
              </button>
            </div>
          </div>

          {/* Groq Cloud AI */}
          <div className="api-key-row">
            <label htmlFor="groq-api-key">
              <span className="provider-name">⚡ Groq Cloud AI</span>
              <span className="provider-hint">Get your key at console.groq.com/keys</span>
            </label>
            <div className="key-input-wrapper">
              <input
                id="groq-api-key"
                type="password"
                placeholder="gsk_..."
                value={groqKey}
                onChange={(e) => setGroqKey(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
              <button onClick={() => handleSaveKey('groq', groqKey)}>
                Save
              </button>
              <button onClick={() => handleTestKey('groq', groqKey)}>
                Test
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

export default ProjectSettings;
