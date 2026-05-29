import { useState, useEffect, useCallback } from 'preact/hooks';
import { PROVIDERS } from '../config/providers';

function serializeModelConfig(model) {
  if (!model) return null;
  return {
    name: model.name,
    provider: model.provider,
    model: model.modelId,
    apiBaseUrl: model.baseUrl,
    apiKey: model.apiKey,
    authMethod: model.authMethod,
  };
}

function findModelIndex(models, selection) {
  if (!selection || !selection.model || !selection.apiBaseUrl) return -1;
  return models.findIndex(model =>
    model.modelId === selection.model &&
    model.baseUrl === selection.apiBaseUrl &&
    model.authMethod === selection.authMethod &&
    model.provider === selection.provider
  );
}

export function useConfig() {
  const [providerKeys, setProviderKeys] = useState({});
  const [customModels, setCustomModels] = useState([]);
  const [currentModelIndex, setCurrentModelIndex] = useState(0);
  const [agentDefaultConfig, setAgentDefaultConfig] = useState(null);
  const [userSkills, setUserSkills] = useState([]);
  const [builtInSkills, setBuiltInSkills] = useState([]);
  const [availableModels, setAvailableModels] = useState([]);
  const [oauthStatus, setOauthStatus] = useState({ isOAuthEnabled: false, isAuthenticated: false });
  const [isLoading, setIsLoading] = useState(true);
  const [onboarding, setOnboarding] = useState({ completed: true, primaryMode: null });

  useEffect(() => {
    loadConfig();
  }, []);

  const buildAvailableModels = useCallback(async (keys, custom, oauth) => {
    const models = [];
    const hasOAuth = oauth?.isOAuthEnabled && oauth?.isAuthenticated;
    const anthropic = PROVIDERS.anthropic;
    const bedrock = PROVIDERS.bedrock;
    const anthropicKey = keys.anthropic;
    const bedrockKey = keys.bedrock;

    // Claude Pro/Max via `claude login`
    if (hasOAuth) {
      for (const model of anthropic.models) {
        models.push({
          name: `${model.name} (Claude Code)`,
          provider: 'anthropic',
          modelId: model.id,
          baseUrl: anthropic.baseUrl,
          apiKey: null,
          authMethod: 'oauth',
        });
      }
    }

    // Direct Anthropic API key
    if (anthropicKey) {
      for (const model of anthropic.models) {
        models.push({
          name: `${model.name} (Anthropic API)`,
          provider: 'anthropic',
          modelId: model.id,
          baseUrl: anthropic.baseUrl,
          apiKey: anthropicKey,
          authMethod: 'api_key',
        });
      }
    }

    // Amazon Bedrock API key
    if (bedrockKey) {
      for (const model of bedrock.models) {
        models.push({
          name: model.name,
          provider: 'bedrock',
          modelId: model.id,
          baseUrl: bedrock.baseUrl,
          apiKey: bedrockKey,
          authMethod: 'api_key',
        });
      }
    }

    // Custom endpoints (kept for advanced users running a local ccproxy etc.)
    for (const customModel of custom) {
      models.push({
        name: customModel.name,
        provider: 'anthropic',
        modelId: customModel.modelId,
        baseUrl: customModel.baseUrl,
        apiKey: customModel.apiKey,
        authMethod: 'api_key',
      });
    }

    setAvailableModels(models);
  }, []);

  const loadConfig = useCallback(async () => {
    try {
      const config = await chrome.runtime.sendMessage({ type: 'GET_CONFIG' });
      setProviderKeys(config.providerKeys || {});
      setCustomModels(config.customModels || []);
      setCurrentModelIndex(config.currentModelIndex || 0);
      setAgentDefaultConfig(config.agentDefaultConfig || null);
      setUserSkills(config.userSkills || []);
      setBuiltInSkills(config.builtInSkills || []);

      const obState = await chrome.storage.local.get(['onboarding_completed', 'onboarding_primary_mode']);
      setOnboarding({
        completed: obState.onboarding_completed !== false,
        primaryMode: obState.onboarding_primary_mode || null,
      });

      const oauth = await chrome.runtime.sendMessage({ type: 'GET_OAUTH_STATUS' });
      setOauthStatus(oauth || { isOAuthEnabled: false, isAuthenticated: false });

      await buildAvailableModels(config.providerKeys || {}, config.customModels || [], oauth);

      setIsLoading(false);
    } catch (error) {
      console.error('Failed to load config:', error);
      setIsLoading(false);
    }
  }, [buildAvailableModels]);

  const saveConfig = useCallback(async (overrideKeys) => {
    const keysToSave = overrideKeys || providerKeys;
    await chrome.runtime.sendMessage({
      type: 'SAVE_CONFIG',
      payload: {
        providerKeys: keysToSave,
        customModels,
        currentModelIndex,
        userSkills,
      },
    });
    if (overrideKeys) setProviderKeys(overrideKeys);
    await buildAvailableModels(keysToSave, customModels, oauthStatus);
  }, [providerKeys, customModels, currentModelIndex, userSkills, oauthStatus, buildAvailableModels]);

  const selectModel = useCallback(async (index) => {
    setCurrentModelIndex(index);
    const model = availableModels[index];
    if (model) {
      await chrome.runtime.sendMessage({ type: 'CLEAR_CHAT' }).catch(() => {});
      await chrome.runtime.sendMessage({
        type: 'SAVE_CONFIG',
        payload: {
          currentModelIndex: index,
          model: model.modelId,
          apiBaseUrl: model.baseUrl,
          apiKey: model.apiKey,
          authMethod: model.authMethod,
          provider: model.provider,
        },
      });
    }
  }, [availableModels]);

  const selectAgentDefault = useCallback(async (index) => {
    const model = availableModels[index];
    if (!model) return;
    const serialized = serializeModelConfig(model);
    setAgentDefaultConfig(serialized);
    await chrome.runtime.sendMessage({
      type: 'SAVE_CONFIG',
      payload: { agentDefaultConfig: serialized },
    });
  }, [availableModels]);

  const setProviderKey = useCallback((provider, key) => {
    setProviderKeys(prev => ({ ...prev, [provider]: key }));
  }, []);

  const addCustomModel = useCallback((model) => {
    setCustomModels(prev => [...prev, model]);
  }, []);

  const removeCustomModel = useCallback((index) => {
    setCustomModels(prev => prev.filter((_, i) => i !== index));
  }, []);

  const addUserSkill = useCallback((skill) => {
    setUserSkills(prev => {
      const existingIndex = prev.findIndex(s => s.domain === skill.domain);
      if (existingIndex >= 0) {
        const updated = [...prev];
        updated[existingIndex] = skill;
        return updated;
      }
      return [...prev, skill];
    });
  }, []);

  const removeUserSkill = useCallback((index) => {
    setUserSkills(prev => prev.filter((_, i) => i !== index));
  }, []);

  const importCLI = useCallback(async () => {
    const result = await chrome.runtime.sendMessage({ type: 'IMPORT_CLI_CREDENTIALS' });
    if (result.success) await loadConfig();
    return result;
  }, [loadConfig]);

  const logoutCLI = useCallback(async () => {
    await chrome.runtime.sendMessage({ type: 'OAUTH_LOGOUT' });
    await loadConfig();
  }, [loadConfig]);

  const currentModel = availableModels[currentModelIndex] || null;
  const currentAgentDefaultIndex = findModelIndex(availableModels, agentDefaultConfig);

  return {
    providerKeys,
    customModels,
    currentModelIndex,
    agentDefaultConfig,
    userSkills,
    builtInSkills,
    availableModels,
    currentModel,
    currentAgentDefaultIndex,
    oauthStatus,
    isLoading,
    onboarding,

    loadConfig,
    saveConfig,
    selectModel,
    selectAgentDefault,
    setProviderKey,
    addCustomModel,
    removeCustomModel,
    addUserSkill,
    removeUserSkill,
    importCLI,
    logoutCLI,
  };
}
