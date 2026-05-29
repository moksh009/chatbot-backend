/** Default + merge for Client.websiteChatWidgetConfig */
const DEFAULT_WEBSITE_CHAT_WIDGET = {
  enabled: true,
  mode: 'both',
  experience: 'classic',
  flowId: '',
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
  poweredByText: 'Powered by AI',
  poweredByUrl: 'https://topedgeai.com',
  logoUrl: '',
  launcherStyle: 'pill',
  launcherLabel: 'Chat with us',
  autoOpen: false,
  bubblePulse: true,
};

function mergeWebsiteWidgetConfig(stored) {
  const src = stored && typeof stored === 'object' ? stored : {};
  return { ...DEFAULT_WEBSITE_CHAT_WIDGET, ...src };
}

function pickWebsiteWidgetForPublic(cfg) {
  const c = mergeWebsiteWidgetConfig(cfg);
  const mode = c.mode || 'both';
  const experience =
    mode === 'guided' ? 'guided' : c.experience === 'guided' ? 'guided' : c.experience || 'classic';
  return {
    enabled: c.enabled !== false,
    mode,
    experience,
    flowId: c.flowId || '',
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
  const websiteFlows = (doc?.visualFlows || []).filter((f) => f.platform === 'website');
  const cfg = mergeWebsiteWidgetConfig(doc?.websiteChatWidgetConfig);
  const activeWebsiteFlow =
    websiteFlows.find((f) => f.isActive) ||
    (cfg.flowId
      ? websiteFlows.find((f) => String(f.id) === String(cfg.flowId))
      : null);

  const bundle = {
    websiteChatWidgetConfig: cfg,
    websiteFlows: websiteFlows.map((f) => ({
      id: f.id,
      name: f.name,
      isActive: !!f.isActive,
      nodeCount: (f.publishedNodes || f.nodes || []).length,
    })),
    activeWebsiteFlowId: activeWebsiteFlow?.id || '',
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
