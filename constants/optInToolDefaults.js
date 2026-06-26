/** Default design payloads per opt-in tool type (Indian D2C defaults). */

const BRAND_VIOLET = '#7C3AED';
const BRAND_VIOLET_DARK = '#5B21B6';

const SHARED_CONSENT =
  'I agree to receive WhatsApp offers and order updates from this brand. Reply STOP anytime to opt out.';

function defaultPopupDesign() {
  return {
    brandExtracted: false,
    brandKit: {
      primary: BRAND_VIOLET,
      secondary: BRAND_VIOLET_DARK,
      background: '#FFFFFF',
      text: '#0F172A',
      font: 'Inter',
    },
    headline: 'Get 10% off your first order',
    subheadline: 'Join our WhatsApp VIP list — COD available on your first order.',
    offerText: 'Use code at checkout. Prices in ₹.',
    buttonText: 'Get my code',
    showImage: false,
    imageUrl: '',
    discount: {
      mode: 'auto_shopify',
      manualCode: '',
      discountType: 'percentage',
      discountValue: 10,
      minimumOrderAmount: 499,
    },
    phonePlaceholder: '10-digit mobile number',
    countryCode: '+91',
    consentText: SHARED_CONSENT,
    colors: {
      overlay: 'rgba(15, 23, 42, 0.45)',
      panelBackground: '#FFFFFF',
      buttonBackground: BRAND_VIOLET,
      buttonText: '#FFFFFF',
    },
  };
}

function defaultWhatsappWidgetDesign() {
  return {
    brandExtracted: false,
    brandKit: {
      primary: BRAND_VIOLET,
      secondary: BRAND_VIOLET_DARK,
      background: '#FFFFFF',
      text: '#0F172A',
      font: 'Inter',
    },
    phoneNumber: '',
    fallbackCountryCode: '+91',
    collectPhone: true,
    widgetStyle: 'icon_with_text',
    widgetText: 'Chat with us',
    widgetColor: BRAND_VIOLET,
    widgetIconColor: '#FFFFFF',
    iconSize: 'normal',
    position: { side: 'right', offsetX: 24, offsetY: 24 },
    mobilePosition: null,
    headerGradient: { left: BRAND_VIOLET, right: BRAND_VIOLET_DARK },
    chatHeading: 'Hi there 👋',
    chatSubheading: 'Chat with us on WhatsApp for order help and exclusive offers.',
    greetingText: 'Hey, how can we help you?',
    placeholderText: 'Enter your number',
    buttonText: 'Send us a text',
    defaultWhatsAppMessage: 'Hey! I need help with something.',
    consentText: SHARED_CONSENT,
  };
}

function defaultSpinWheelDesign() {
  return {
    brandExtracted: false,
    brandKit: {
      primary: BRAND_VIOLET,
      secondary: '#F59E0B',
      background: '#FFFFFF',
      text: '#0F172A',
      font: 'Inter',
    },
    backgroundLeft: '#FFFFFF',
    backgroundRight: BRAND_VIOLET,
    headline: 'SPIN TO WIN!',
    subheadline: 'Feeling lucky? Give the wheel a spin!',
    headingColor: '#FFFFFF',
    subheadingColor: '#FFFFFF',
    buttonText: 'Get coupon',
    spinButtonText: 'Try my luck!',
    respinButtonText: 'Give me another spin!',
    buttonColor: BRAND_VIOLET,
    buttonTextColor: '#FFFFFF',
    pinColor: '#FFFFFF',
    closeButtonColor: '#FFFFFF',
    collectInputsBeforeSpin: false,
    fallbackCountryCode: '+91',
    phonePlaceholder: '10-digit mobile',
    consentText: SHARED_CONSENT,
    wheelColors: [BRAND_VIOLET, '#F59E0B', '#10B981', '#EF4444', '#3B82F6', '#8B5CF6'],
    wheelTextColors: ['#FFFFFF', '#FFFFFF', '#FFFFFF', '#FFFFFF', '#FFFFFF', '#FFFFFF'],
    completedView: {
      successHeading: 'Congratulations! You won',
      successSubheading: 'Your coupon code is',
      failureHeading: 'Better luck next time',
      failureSubheading: 'Thanks for playing — check WhatsApp for future offers.',
    },
  };
}

function defaultMysteryDesign() {
  return {
    brandExtracted: false,
    brandKit: {
      primary: '#D4AF37',
      secondary: '#C0C0C0',
      background: '#1A1A2E',
      text: '#FFFFFF',
      font: 'Inter',
    },
    headline: 'Tap to reveal your surprise',
    subheadline: 'Exclusive discount for WhatsApp VIPs — limited time.',
    buttonText: 'Reveal my prize',
    cardStyle: 'gold',
    collectInputsBeforeSpin: false,
    fallbackCountryCode: '+91',
    phonePlaceholder: '10-digit mobile',
    consentText: SHARED_CONSENT,
    completedView: {
      successHeading: 'You unlocked a prize!',
      successSubheading: 'Your coupon code is',
      failureHeading: 'So close!',
      failureSubheading: 'Try again on your next visit.',
    },
  };
}

function defaultPrizesForSpin() {
  return [
    {
      label: '10% off',
      couponMode: 'unique',
      couponCode: '',
      discountType: 'percentage',
      discountValue: 10,
      minimumOrderAmount: 499,
      probability: 40,
      autoCreateOnShopify: true,
    },
    {
      label: 'Free shipping',
      couponMode: 'fixed',
      couponCode: 'FREESHIP',
      discountType: 'fixed_amount',
      discountValue: 0,
      minimumOrderAmount: 999,
      probability: 30,
      autoCreateOnShopify: true,
    },
    {
      label: 'Better luck next time',
      couponMode: 'lose',
      couponCode: '',
      discountType: 'percentage',
      discountValue: 0,
      minimumOrderAmount: 0,
      probability: 30,
      autoCreateOnShopify: false,
    },
  ];
}

function defaultTriggers() {
  return {
    when: { condition: 'immediate', delaySeconds: 3, scrollDepth: 50, timeOnPage: 0 },
    where: { pagesToShow: ['all'], pagesToHide: [], devices: ['all'] },
    who: { visitorType: 'all' },
    frequency: { type: 'once_per_session', cooldownDays: 3 },
    schedule: {
      enabled: false,
      timezone: 'Asia/Kolkata',
      days: [1, 2, 3, 4, 5, 6],
      startHour: 9,
      endHour: 21,
    },
    smart: {
      enabled: false,
      browsingWithoutAction: { enabled: false, threshold: 3 },
      productPageDwell: { enabled: false, seconds: 30 },
      cartWithoutCheckout: { enabled: false, minutes: 5 },
      returnVisitor: { enabled: false },
      highValueBrowser: { enabled: false, thresholdAmount: 5000 },
    },
  };
}

function defaultDesignForType(type) {
  switch (type) {
    case 'whatsapp_widget':
      return defaultWhatsappWidgetDesign();
    case 'spin_wheel':
      return defaultSpinWheelDesign();
    case 'mystery_discount':
      return defaultMysteryDesign();
    case 'popup':
    default:
      return defaultPopupDesign();
  }
}

function defaultNameForType(type, templateId = '') {
  if (templateId) return templateId.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const labels = {
    whatsapp_widget: 'WhatsApp chat widget',
    popup: 'Welcome popup',
    spin_wheel: 'Spin to win',
    mystery_discount: 'Mystery discount',
  };
  return labels[type] || 'Opt-in tool';
}

module.exports = {
  defaultDesignForType,
  defaultTriggers,
  defaultPrizesForSpin,
  defaultNameForType,
};
