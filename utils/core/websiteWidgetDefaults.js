/** Default + merge for Client.websiteChatWidgetConfig */
const DEFAULT_WEBSITE_CHAT_WIDGET = {
  enabled: true,
  mode: 'chat',
  experience: 'chat',
  flowId: '',
  aiRepliesEnabled: true,
  theme: '#7C3AED',
  themeSecondary: '#5B21B6',
  position: 'bottom-right',
  delaySeconds: 3,
  greeting: 'Hi! How can we help you today? 👋',
  launcherIcon: 'chat',
  customIconUrl: '',
  headerTitle: '',
  headerSubtitle: '',
  showPoweredBy: true,
  poweredByText: 'Created by TopEdge AI',
  poweredByUrl: 'https://topedgeai.com',
  logoUrl: '',
  launcherStyle: 'pill',
  launcherLabel: 'Chat with us',
  autoOpen: false,
  bubblePulse: true,
};

function normalizeWidgetMode(mode, experience) {
  if (mode === 'chat' || experience === 'chat') return 'chat';
  return 'chat';
}

function mergeWebsiteWidgetConfig(stored) {
  const src = stored && typeof stored === 'object' ? stored : {};
  const merged = { ...DEFAULT_WEBSITE_CHAT_WIDGET, ...src };
  merged.mode = normalizeWidgetMode(merged.mode, merged.experience);
  merged.experience = 'chat';
  if (merged.showPoweredBy !== false) {
    merged.showPoweredBy = true;
    merged.poweredByText = DEFAULT_WEBSITE_CHAT_WIDGET.poweredByText;
    merged.poweredByUrl = DEFAULT_WEBSITE_CHAT_WIDGET.poweredByUrl;
  }
  return merged;
}

function pickWebsiteWidgetForPublic(cfg) {
  const c = mergeWebsiteWidgetConfig(cfg);
  return {
    enabled: c.enabled !== false,
    mode: 'chat',
    experience: 'chat',
    aiRepliesEnabled: c.aiRepliesEnabled !== false,
    theme: c.theme || DEFAULT_WEBSITE_CHAT_WIDGET.theme,
    themeSecondary: c.themeSecondary || DEFAULT_WEBSITE_CHAT_WIDGET.themeSecondary,
    position: c.position || 'bottom-right',
    delaySeconds: Number(c.delaySeconds) || 0,
    greeting: c.greeting || DEFAULT_WEBSITE_CHAT_WIDGET.greeting,
    launcherIcon: c.launcherIcon || 'chat',
    customIconUrl: c.customIconUrl || '',
    headerTitle: c.headerTitle || '',
    headerSubtitle: c.headerSubtitle || '',
    showPoweredBy: c.showPoweredBy !== false,
    poweredByText: c.poweredByText || DEFAULT_WEBSITE_CHAT_WIDGET.poweredByText,
    poweredByUrl: c.poweredByUrl || DEFAULT_WEBSITE_CHAT_WIDGET.poweredByUrl,
    logoUrl: c.logoUrl || '',
    launcherStyle: c.launcherStyle || 'pill',
    launcherLabel: c.launcherLabel || DEFAULT_WEBSITE_CHAT_WIDGET.launcherLabel,
    autoOpen: c.autoOpen === true,
    bubblePulse: c.bubblePulse !== false,
  };
}

function buildWebsiteWidgetSettingsBundle(doc, { clientId, origin = '' } = {}) {
  const cfg = mergeWebsiteWidgetConfig(doc?.websiteChatWidgetConfig);

  const bundle = {
    websiteChatWidgetConfig: cfg,
    websiteFlows: [],
    activeWebsiteFlowId: '',
  };

  if (origin && clientId) {
    bundle.embed = {
      scriptUrl: `${origin}/public/widget.js`,
      iframeUrl: `${origin}/public/widgetIframe.html`,
      configUrl: `${origin}/api/support-chat/widget-config/${clientId}`,
    };
  }

  return bundle;
}

module.exports = {
  DEFAULT_WEBSITE_CHAT_WIDGET,
  mergeWebsiteWidgetConfig,
  pickWebsiteWidgetForPublic,
  buildWebsiteWidgetSettingsBundle,
};
